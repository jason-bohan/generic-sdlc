import type { Phase, StatusEvent } from './types';

/** Short labels for floor tiles, cards, and phase-change notifications (App, SimpleFloor). */
export const PHASE_LABELS: Record<Phase, string> = {
    idle: 'Idle',
    'pending-approval': 'Awaiting Approval',
    'reading-story': 'Reading Story',
    planning: 'Planning',
    analyzing: 'Analyzing',
    'creating-tasks': 'Creating Tasks',
    'generating-code': 'Coding',
    validating: 'Validating',
    'creating-pr': 'Creating PR',
    'watching-reviews': 'Reviews',
    'addressing-feedback': 'Feedback',
    'running-cypress': 'Testing',
    complete: 'Done',
    error: 'Error',
    'pending-review': 'Pending Review',
    reviewing: 'Reviewing',
    commenting: 'Commenting',
    approved: 'Approved',
    'changes-requested': 'Changes Requested',
    'waiting-for-fixes': 'Waiting for Fixes',
    'watching-build': 'Watching CI',
    'pending-build': 'Pending Build',
    'monitoring-build': 'Building',
    'build-passed': 'Build Passed',
    'build-failed': 'Build Failed',
    researching: 'Researching',
    designing: 'Designing',
    'spec-ready': 'Spec Ready',
    collaborating: 'Collaborating',
};

/** Longer, task-oriented copy for the agent desk (AgentDetail). */
export const PHASE_LABELS_DESK: Record<Phase, string> = {
    idle: 'Idle',
    'pending-approval': 'Pending Approval',
    'reading-story': 'Reading Story',
    planning: 'Building Plan',
    analyzing: 'Analyzing Codebase',
    'creating-tasks': 'Creating Tasks',
    'generating-code': 'Generating Code',
    validating: 'Validating',
    'creating-pr': 'Creating PR',
    'watching-reviews': 'Watching Reviews',
    'addressing-feedback': 'Addressing Feedback',
    'running-cypress': 'Running Cypress',
    complete: 'Complete',
    error: 'Error',
    'pending-review': 'Pending Review',
    reviewing: 'Reviewing PR',
    commenting: 'Leaving Comments',
    approved: 'Approved',
    'changes-requested': 'Changes Requested',
    'waiting-for-fixes': 'Waiting for Fixes',
    'watching-build': 'Watching CI',
    'pending-build': 'Pending Build',
    'monitoring-build': 'Building',
    'build-passed': 'Build Passed',
    'build-failed': 'Build Failed',
    researching: 'Researching',
    designing: 'Designing',
    'spec-ready': 'Spec Ready',
    collaborating: 'Collaborating',
};

export const PHASE_COLORS: Record<Phase, string> = {
    idle: 'var(--text-secondary)',
    'pending-approval': 'var(--warning)',
    'reading-story': 'var(--info)',
    planning: 'var(--info)',
    analyzing: 'var(--info)',
    'creating-tasks': 'var(--info)',
    'generating-code': 'var(--accent)',
    validating: 'var(--warning)',
    'creating-pr': 'var(--info)',
    'watching-reviews': 'var(--warning)',
    'addressing-feedback': 'var(--accent)',
    'running-cypress': 'var(--warning)',
    complete: 'var(--success)',
    error: 'var(--error)',
    'pending-review': 'var(--warning)',
    reviewing: 'var(--info)',
    commenting: 'var(--info)',
    approved: 'var(--success)',
    'changes-requested': 'var(--warning)',
    'waiting-for-fixes': 'var(--warning)',
    'watching-build': 'var(--info)',
    'pending-build': 'var(--warning)',
    'monitoring-build': 'var(--info)',
    'build-passed': 'var(--success)',
    'build-failed': 'var(--error)',
    researching: 'var(--info)',
    designing: 'var(--accent)',
    'spec-ready': 'var(--success)',
    collaborating: 'var(--info)',
};

export const EVENT_COLORS: Record<StatusEvent['type'], string> = {
    info: 'var(--info)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    error: 'var(--error)',
    phase: 'var(--accent)',
    verdict: 'var(--warning)',
};

/** Phases that use a strong activity pulse on the floor cards. */
export const HARD_ACTIVE_PHASES: ReadonlySet<string> = new Set([
    'reading-story', 'planning', 'creating-tasks', 'analyzing',
    'generating-code', 'validating', 'creating-pr', 'addressing-feedback',
    'running-cypress', 'monitoring-build',
]);

/** Phases that use a softer activity animation on the floor cards. */
export const SOFT_ACTIVE_PHASES: ReadonlySet<string> = new Set([
    'pending-approval', 'watching-reviews', 'collaborating',
    'reviewing', 'commenting', 'spec-ready', 'pending-build',
    'pending-review', 'waiting-for-fixes', 'researching', 'designing',
]);

export function getPhaseColor(phase: Phase): string {
    switch (phase) {
        case 'idle':
        case 'complete':
            return 'var(--text-tertiary)';
        case 'error':
            return 'var(--error)';
        case 'pending-approval':
        case 'changes-requested':
        case 'waiting-for-fixes':
            return 'var(--warning)';
        default:
            return 'var(--success)';
    }
}

export function isActivePhase(phase: Phase): boolean {
    return HARD_ACTIVE_PHASES.has(phase) || SOFT_ACTIVE_PHASES.has(phase);
}
