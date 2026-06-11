/**
 * Autonomous auto-continue for spawn-based (opencode, aider, goose, generic) drivers.
 *
 * The loop driver auto-resumes via registry events. But spawn-based drivers exit
 * after each phase — the process is gone, nothing picks up the next phase.
 *
 * This subscribes to the hook-runner status bus: when an agent reaches a new phase
 * and is no longer running, we POST /api/agent/continue to kick off the next phase.
 *
 * Idempotency: the hook-runner already dedupes on (agentId, phase), so a given
 * phase only triggers once. Subsequent status file writes (e.g. from the continue
 * endpoint setting handoffDispatched) are caught by the dedup check.
 */

import { getActiveAgents } from './spawn-agent';
import { isRunnerActive } from './agent-runner';
import { resolveAgentDriverConfig } from './agent-drivers';
import { isAgentStepMode } from './stepMode';
import { isLoopActive } from './loop-control';
import { existsSync } from 'fs';
import { parseJsonUtf8File } from './json-file';
import { serverLog as log } from './logger';

const NEVER_AUTO_CONTINUE_PHASES = new Set([
    'idle', 'complete', 'error',
    'approved', 'changes-requested',
]);

// Hard cap on consecutive auto-continues for the same (agent, phase, story). The loop driver
// auto-resumes in-process with a cap of 3; subprocess drivers (claude-code, opencode, aider, …)
// rely on this status-bus path, which had NO cap — so a fast-exiting subprocess gets re-spawned in
// a tight loop. Observed live: a claude-code worker exited instantly and was re-spawned 1,143× on
// "reading-story", cascading the workflow to a false "complete" with zero artifacts. The key
// includes the phase, so healthy phase-to-phase progress resets naturally; only a same-phase storm
// trips the cap.
export const AUTO_CONTINUE_CAP = 5;
const autoContinueCounts = new Map<string, number>();

/**
 * Record an auto-continue attempt for (agent, phase, story) and report whether it's within the cap.
 * Returns false once the cap is exceeded — the caller must then stop re-spawning. Exported for tests.
 */
export function withinAutoContinueCap(agentId: string, phase: string, storyNumber: string): boolean {
    if (autoContinueCounts.size > 1000) autoContinueCounts.clear(); // bound memory; stale keys are harmless
    const key = `${agentId}:${phase}:${storyNumber}`;
    const n = (autoContinueCounts.get(key) ?? 0) + 1;
    autoContinueCounts.set(key, n);
    return n <= AUTO_CONTINUE_CAP;
}

/** Clear the auto-continue counter for an agent's phase (e.g. on a clean manual reset). Exported for tests. */
export function resetAutoContinueCap(agentId?: string): void {
    if (!agentId) { autoContinueCounts.clear(); return; }
    for (const key of autoContinueCounts.keys()) {
        if (key.startsWith(`${agentId}:`)) autoContinueCounts.delete(key);
    }
}

/**
 * Single guarded auto-continue path, shared by the status-bus handler and the
 * process-exit hook. Reads the agent's current phase from its status file (the
 * source of truth both callers agree on) and only fires for spawn-based drivers
 * that are idle, not in step mode, and have a story to continue.
 */
export function maybeAutoContinueAgent(rootDir: string, port: number, configFile: string, agentId: string): void {
    // Loop brake: when the loop is paused/stopped, don't auto-continue to the next phase.
    if (!isLoopActive(rootDir)) return;
    // Safety check: make sure the agent actually has a story to continue.
    const statusFile = `${rootDir}/.${agentId}-status.json`;
    if (!existsSync(statusFile)) return;
    let status: Record<string, unknown>;
    try {
        status = parseJsonUtf8File(statusFile) as Record<string, unknown>;
    } catch {
        return;
    }

    const phase = String(status.currentPhase ?? '');
    if (NEVER_AUTO_CONTINUE_PHASES.has(phase)) return;
    if (!status.storyNumber) return;

    // Don't auto-continue a paused agent — the user must manually Continue.
    if (status.paused) return;

    // Only auto-continue spawn-based drivers (opencode, aider, goose, generic).
    // Loop drivers auto-resume internally via registry events.
    const driver = resolveAgentDriverConfig(agentId, configFile);
    if (driver.type === 'loop') return;

    // Don't continue if the agent is still actively running.
    const active = getActiveAgents();
    if (agentId in active) return;
    if (isRunnerActive(agentId)) return;

    // Step mode: user wants to review before proceeding.
    if (isAgentStepMode(agentId, configFile)) return;

    // Hard cap: stop re-spawning a subprocess driver that keeps exiting on the same phase, instead
    // of storming (the loop driver caps at 3 internally; subprocess drivers had no cap until here).
    if (!withinAutoContinueCap(agentId, phase, String(status.storyNumber))) {
        log.warn(`[auto-continue] ${agentId} hit the auto-continue cap (${AUTO_CONTINUE_CAP}) on phase "${phase}" for ${status.storyNumber} — stopping. The subprocess driver keeps exiting without advancing; needs a human or a clean re-kick.`);
        return;
    }

    log.info(`[auto-continue] ${agentId} idle on phase "${phase}" — auto-continuing`);
    void fetch(`http://localhost:${port}/api/agent/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
        signal: AbortSignal.timeout(30_000),
    })
        .then((r) => {
            if (r.ok) {
                log.info(`[auto-continue] ${agentId} → continue accepted (HTTP ${r.status})`);
            } else {
                log.warn(`[auto-continue] ${agentId} → continue returned HTTP ${r.status}`);
            }
        })
        .catch((e) => log.warn(`[auto-continue] ${agentId} continue failed: ${e instanceof Error ? e.message : String(e)}`));
}
