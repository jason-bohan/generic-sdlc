import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { executeToolCall } from '../server/agent-runner/tools';

const TMP = resolve(__dirname, '.phase-desync-tmp');
const statusFile = resolve(TMP, '.backend-status.json');
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ externalMode: 'live', scheduler: {} }));
  // Backend desk stuck on validating, but the DB has already advanced to committing.
  writeFileSync(statusFile, JSON.stringify({ workflowItemId: 87, storyNumber: 'LOCAL-B-0060', currentPhase: 'validating', tasks: [], events: [] }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(TMP, { recursive: true, force: true }); });

describe('complete_phase — desk/DB phase desync recovery', () => {
  it('on a 409 "in <X>, not <phase>", syncs the desk to X and returns PHASE_COMPLETE::X', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Workflow item is in committing, not validating' }), { status: 409 }),
    );

    const out = await executeToolCall('complete_phase', { next_phase: 'committing' }, TMP, TMP, 'backend', CONFIG);

    // The agent is told the phase already advanced — not a bare 409 it would loop on.
    expect(out).toMatch(/PHASE_COMPLETE::committing/);
    expect(out).not.toMatch(/^HTTP 409/);
    // The desk was synced to the DB's authoritative phase.
    const desk = JSON.parse(readFileSync(statusFile, 'utf-8'));
    expect(desk.currentPhase).toBe('committing');
  });

  it('leaves an unrelated 409 (no "in X, not" desync) as a normal error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'some other conflict' }), { status: 409 }),
    );
    const out = await executeToolCall('complete_phase', { next_phase: 'committing' }, TMP, TMP, 'backend', CONFIG);
    expect(out).toMatch(/HTTP 409/);
    expect(out).not.toMatch(/PHASE_COMPLETE/);
  });
});
