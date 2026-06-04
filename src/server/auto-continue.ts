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

import type { StatusChangeEvent } from './status-events';
import { getActiveAgents } from './spawn-agent';
import { isRunnerActive } from './agent-runner';
import { resolveAgentDriverConfig } from './agent-drivers';
import { isAgentStepMode } from './stepMode';
import { existsSync } from 'fs';
import { parseJsonUtf8File } from './json-file';
import { serverLog as log } from './logger';

const NEVER_AUTO_CONTINUE_PHASES = new Set([
    'idle', 'complete', 'error',
    'approved', 'changes-requested',
]);

export function maybeAutoContinueAgent(rootDir: string, port: number, configFile: string, ev: StatusChangeEvent): void {
    const { agentId } = ev;
    if (NEVER_AUTO_CONTINUE_PHASES.has(ev.status?.currentPhase as string)) return;

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

    // Safety check: make sure the agent actually has a story to continue.
    const statusFile = `${rootDir}/.${agentId}-status.json`;
    if (!existsSync(statusFile)) return;
    try {
        const status = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        if (!status.storyNumber) return;
    } catch {
        return;
    }

    log.info(`[auto-continue] ${agentId} completed phase "${ev.status?.currentPhase}" — auto-continuing`);
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
