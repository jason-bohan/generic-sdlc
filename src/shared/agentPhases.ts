/** Phases where POST /api/agent/continue may honor dashboard-selected tasks (task-scoped work). */
export const PHASES_ALLOWING_CONTINUE_TASK_SCOPE = new Set<string>([
    'generating-code', 'addressing-feedback',
    'pending-review', 'reviewing', 'commenting',
    'pending-build', 'monitoring-build',
    'analyzing', 'validating',
    'creating-pr',
]);

export function phaseAllowsContinueTaskScope(phase: string | undefined): boolean {
    return typeof phase === 'string' && PHASES_ALLOWING_CONTINUE_TASK_SCOPE.has(phase);
}

export const DEFAULT_STEP_MODE_PHASES = ['analyzing', 'validating'] as const;

export const AGENT_STEP_MODE_PHASES: Record<string, readonly string[]> = {
    frontend: [
        'analyzing',
        'generating-code',
        'validating',
        'creating-pr',
        'watching-reviews',
        'addressing-feedback',
        'running-cypress',
    ],
    backend: [
        'analyzing',
        'generating-code',
        'validating',
        'creating-pr',
        'watching-reviews',
        'addressing-feedback',
    ],
    devops: ['analyzing', 'validating', 'pending-build', 'monitoring-build', 'build-passed', 'build-failed'],
    reviewer: ['pending-review', 'approved', 'waiting-for-fixes'],
    ux: ['researching', 'designing', 'spec-ready', 'collaborating', 'reviewing-design'],
};

export function getDefaultStepModePhases(agentId?: string): readonly string[] {
    if (!agentId) return DEFAULT_STEP_MODE_PHASES;
    return AGENT_STEP_MODE_PHASES[agentId] ?? DEFAULT_STEP_MODE_PHASES;
}

export function normalizeStepModePhases(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const phases = value
        .filter((phase): phase is string => typeof phase === 'string')
        .map(phase => phase.trim())
        .filter(Boolean);
    return phases.length > 0 ? [...new Set(phases)] : null;
}
