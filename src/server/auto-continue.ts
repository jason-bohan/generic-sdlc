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
