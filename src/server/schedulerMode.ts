/**
 * Scheduler workflow mode: whether assigned agents wait for manual approval or start immediately.
 * Distinct from execution mode (local / balanced / speed).
 */

export type SchedulerWorkflowMode = 'notify' | 'autonomous';

export function getSchedulerWorkflowMode(config: unknown): SchedulerWorkflowMode {
    const raw = (config as { scheduler?: { mode?: string } } | null)?.scheduler?.mode;
    return raw === 'autonomous' ? 'autonomous' : 'notify';
}

export function isValidSchedulerWorkflowMode(m: string): m is SchedulerWorkflowMode {
    return m === 'notify' || m === 'autonomous';
}

export interface AssignmentPhaseResult {
    phase: 'reading-story' | 'pending-approval';
    startedAt: string | null;
}

/** Combine global scheduler mode with per-agent autoStart. */
export function resolveAgentAssignmentPhase(
    workflowMode: SchedulerWorkflowMode,
    agentAutoStart: boolean,
): AssignmentPhaseResult {
    const immediate = workflowMode === 'autonomous' || agentAutoStart;
    const now = new Date().toISOString();
    return immediate
        ? { phase: 'reading-story', startedAt: now }
        : { phase: 'pending-approval', startedAt: null };
}
