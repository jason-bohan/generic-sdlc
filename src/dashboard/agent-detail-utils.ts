import type { AgentRole, Phase, PullRequest, StatusEvent } from './types';
import { EVENT_COLORS } from './phase-labels';

export function pluralize(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

export function htmlToPlainText(html: string): string {
    if (!html) return '';
    if (typeof document === 'undefined') {
        return html.replace(/<[^>]*>/g, '').trim();
    }
    const el = document.createElement('div');
    el.innerHTML = html;
    return (el.textContent || el.innerText || '').trim();
}

/** Wrap plain text from a textarea as simple HTML paragraphs for storage/display. */
export function plainTextToHtml(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const escape = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return trimmed
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

export function normalizeTaskStatus(st: string): string {
    return st === 'complete' ? 'completed' : st;
}

export function isTaskTerminalStatus(task: { status: string }): boolean {
    const ns = normalizeTaskStatus(task.status);
    return ns === 'completed' || ns === 'failed';
}

export function formatRelativeTime(iso: string): string {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 45) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
}

export function eventAccent(type: StatusEvent['type']): { glyph: string; color: string } {
    const color = EVENT_COLORS[type] ?? 'var(--text-tertiary)';
    const glyphs: Record<StatusEvent['type'], string> = {
        info: '\u2139',
        success: '\u2713',
        warning: '\u26A0',
        error: '\u2715',
        phase: '\u25B6',
        verdict: '\u2696',
    };
    return { glyph: glyphs[type] ?? '\u2022', color };
}

export function prStatusLabel(status: PullRequest['status']): string {
    switch (status) {
        case 'active': return 'Active';
        case 'completed': return 'Complete';
        case 'abandoned': return 'Abandoned';
        case 'draft': return 'Draft';
        default: return status;
    }
}

export function getPlanningStatusColor(planningStatus?: string | null, localStatus?: string): string {
    const planningMap: Record<string, string> = {
        'Future': '#8b5cf6',
        'Not Started': '#8b5cf6',
        'In Progress': '#22c55e',
        'Done': 'var(--text-tertiary)',
        'Completed': 'var(--text-tertiary)',
        'Failed': 'var(--error)',
    };
    if (planningStatus && planningMap[planningStatus]) return planningMap[planningStatus];
    const fallback: Record<string, string> = {
        pending: '#8b5cf6',
        in_progress: '#22c55e',
        completed: 'var(--text-tertiary)',
        complete: 'var(--text-tertiary)',
        failed: 'var(--error)',
    };
    return fallback[localStatus ?? 'pending'] ?? '#8b5cf6';
}

export const CATEGORY_BADGE_COLORS: Record<string, { bg: string; fg: string }> = {
    Frontend: { bg: 'rgba(99, 102, 241, 0.12)', fg: '#6366f1' },
    Api: { bg: 'rgba(16, 185, 129, 0.12)', fg: '#10b981' },
    QA: { bg: 'rgba(245, 158, 11, 0.12)', fg: '#f59e0b' },
    AzureDevOps: { bg: 'rgba(6, 182, 212, 0.12)', fg: '#06b6d4' },
    UX: { bg: 'rgba(236, 72, 153, 0.12)', fg: '#ec4899' },
    Review: { bg: 'rgba(245, 158, 11, 0.12)', fg: '#f59e0b' },
    DevOps: { bg: 'rgba(6, 182, 212, 0.12)', fg: '#06b6d4' },
};

export const REQUEST_TYPE_COLORS: Record<string, { bg: string; fg: string; dot: string }> = {
    review: { bg: 'rgba(245, 158, 11, 0.14)', fg: '#b45309', dot: '#f59e0b' },
    design: { bg: 'rgba(236, 72, 153, 0.12)', fg: '#ec4899', dot: '#ec4899' },
    build: { bg: 'rgba(239, 68, 68, 0.12)', fg: '#ef4444', dot: '#ef4444' },
};

export const REQUEST_TYPE_LABELS: Record<string, string> = {
    review: 'Review',
    design: 'Design',
    build: 'Build',
};

/** Phases at or after validating where the contextual next-step bar may apply. */
export const CONTEXT_ACTION_BAR_PHASES = new Set<Phase>([
    'validating',
    'creating-pr',
    'watching-reviews',
    'addressing-feedback',
    'running-cypress',
    'pending-review',
    'approved',
    'waiting-for-fixes',
    'pending-build',
    'monitoring-build',
    'build-passed',
    'build-failed',
]);

export const PR_STATUS_COLORS: Record<PullRequest['status'], string> = {
    draft: 'var(--text-secondary)',
    active: 'var(--info)',
    completed: 'var(--success)',
    abandoned: 'var(--error)',
};

export const ROLE_DESCRIPTIONS: Record<AgentRole, { summary: string; capabilities: string[] }> = {
    frontend: {
        summary: 'Autonomous frontend engineer that reads stories, plans tasks, writes code, and creates PRs.',
        capabilities: ['Story execution', 'Task breakdown', 'Code generation', 'PR creation', 'Review response'],
    },
    backend: {
        summary: 'Backend engineer handling API design, data modeling, and server-side logic.',
        capabilities: ['API development', 'Database design', 'Service integration', 'Performance tuning'],
    },
    qa: {
        summary: 'QA engineer running Cypress tests, writing test plans, and validating acceptance criteria.',
        capabilities: ['E2E testing', 'Test planning', 'Bug triage', 'Regression testing'],
    },
    ux: {
        summary: 'UX designer creating wireframes, prototypes, and design system components.',
        capabilities: ['Wireframing', 'Prototyping', 'Design tokens', 'Accessibility audit'],
    },
    devops: {
        summary: 'DevOps engineer managing CI/CD pipelines, build validation, and deployment gates.',
        capabilities: ['Pipeline management', 'Build validation', 'Merge gating', 'Infrastructure'],
    },
    reviewer: {
        summary: 'Code reviewer that analyzes PRs, leaves feedback, and approves or requests changes.',
        capabilities: ['PR review', 'Code quality checks', 'Architectural feedback', 'Merge approval'],
    },
};
