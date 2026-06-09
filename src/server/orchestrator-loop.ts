// Periodic orchestrator loop — the engine of continuous autonomy.
//
// The assign-loop (runOrchestratorTick) only ran when something POSTed /api/orchestrator/tick,
// so the orchestrator was poke-driven, not continuous: after one story finished, nothing picked
// up the next. This drives the tick on an interval so the orchestrator keeps assigning backlog
// as specialists free up — "the orchestrator just doing its thing".
//
// Gated by the loop brake (isLoopActive) AND autonomous mode, so pausing the loop pauses the
// ticker, and it never fires outside autonomous mode. The tick endpoint is self-gating too, so
// this is belt-and-suspenders — and avoids POSTing when there's nothing to do.

import { isLoopActive } from './loop-control';
import { getSchedulerWorkflowMode } from './schedulerMode';
import { getSchedulerConfig } from './route-shared';

/** Pure gate: should the periodic loop fire a tick right now? Only when the brake is off and
 *  the scheduler is autonomous. */
export function shouldTick(rootDir: string): boolean {
  return isLoopActive(rootDir) && getSchedulerWorkflowMode(getSchedulerConfig(rootDir)) === 'autonomous';
}

/** Start the periodic orchestrator tick. Self-gates each interval; never throws. */
export function startOrchestratorLoop(rootDir: string, port: number): void {
  const POLL_MS = 30_000;
  setInterval(() => {
    try {
      if (!shouldTick(rootDir)) return;
      void fetch(`http://localhost:${port}/api/orchestrator/tick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
      }).catch(() => { /* a missed tick is harmless — the next one retries */ });
    } catch { /* non-fatal */ }
  }, POLL_MS);
}
