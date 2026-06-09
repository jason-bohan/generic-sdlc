// Loop control routes — the autonomous brake.
//
// Pause/resume/stop the whole fleet without abusing step mode (which is "approve at each gate")
// or reset-to-idle (which nukes desk state). State is preserved; the loop resumes where it left
// off. Every autonomous trigger (assign-loop tick, auto-continue, review handoff, build-gate
// driver) checks isLoopActive, so flipping to paused/stopped freezes all of them.

import { readBody, json, cors } from '../router';
import type { UseFn } from './types';
import { getLoopState, setLoopState, type LoopState } from '../loop-control';
import { getActiveAgents } from '../spawn-agent';
import { stopRunner } from '../agent-runner';

export function mount(use: UseFn, rootDir: string): void {
  // GET /api/loop/status → current run-state
  use('/api/loop/status', async (req, res) => {
    cors(res, 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    json(res, { state: getLoopState(rootDir) });
  });

  // POST /api/loop/pause | /resume — flip the brake. Freezes/unfreezes all autonomous triggers;
  // in-flight desk state is left untouched so the loop resumes exactly where it paused.
  const setter = (state: LoopState) => async (req: Parameters<Parameters<UseFn>[1]>[0], res: Parameters<Parameters<UseFn>[1]>[1]) => {
    cors(res, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
    setLoopState(rootDir, state);
    json(res, { ok: true, state });
  };
  use('/api/loop/pause', setter('paused'));
  use('/api/loop/resume', setter('running'));

  // POST /api/loop/stop — pause AND gracefully halt any running agent processes (without
  // nuking desk state like reset-to-idle does). Resume re-enables the loop.
  use('/api/loop/stop', async (req, res) => {
    cors(res, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
    setLoopState(rootDir, 'stopped');
    const halted: string[] = [];
    for (const agentId of Object.keys(getActiveAgents())) {
      try { if (stopRunner(agentId)) halted.push(agentId); } catch { /* best-effort */ }
    }
    json(res, { ok: true, state: 'stopped', halted });
  });
}
