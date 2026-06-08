import { readBody, json } from '../router';
import type { UseFn } from './types';
import { runOrchestratorTick, type AssignmentPlanItem } from '../orchestrator-tick';

/**
 * Orchestrator routes. /api/orchestrator/tick runs one deterministic assign-loop
 * pass: in autonomous mode, route every free backlog story to its specialist and
 * assign it. Triggerable manually now; a periodic caller can drive it later.
 */
export function mount(use: UseFn, rootDir: string, configFile: string): void {
  use('/api/orchestrator/tick', async (req, res) => {
    if (req.method !== 'POST') {
      json(res, { error: 'Method not allowed' }, 405);
      return;
    }
    // Body is optional; accept and ignore for forward-compat (e.g. future limits).
    try { await readBody(req); } catch { /* no body is fine */ }

    const host = req.headers.host || 'localhost:3001';
    const assign = async (item: AssignmentPlanItem): Promise<boolean> => {
      try {
        const r = await fetch(`http://${host}/api/scheduler/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: item.agentId,
            storyNumber: item.storyNumber,
            storyName: item.storyName,
            storyDescription: item.storyDescription,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        return r.ok;
      } catch {
        return false;
      }
    };

    try {
      const result = await runOrchestratorTick({ rootDir, configFile, assign });
      json(res, result, 200);
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
