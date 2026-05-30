import { defaultAgentDisplayName } from '../shared/agentDisplayDefaults';

export type Phase =
    | 'idle'
    | 'pending-approval'
    | 'reading-story'
    | 'planning'
    | 'analyzing'
    | 'creating-tasks'
    | 'generating-code'
    | 'committing'
    | 'validating'
    | 'creating-pr'
    | 'watching-reviews'
    | 'addressing-feedback'
    | 'running-cypress'
    | 'complete'
    | 'error'
    | 'pending-review'
    | 'reviewing'
    | 'commenting'
    | 'approved'
    | 'changes-requested'
    | 'waiting-for-fixes'
    | 'watching-build'
    | 'pending-build'
    | 'monitoring-build'
    | 'build-passed'
    | 'build-failed'
    | 'researching'
    | 'designing'
    | 'spec-ready'
    | 'collaborating';

export interface TokenMetrics {
    input: number;
    output: number;
}

export interface TaskItem {
    id: string;
    name: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    hours: number;
    completedAt?: string;
    category?: string;
    agilityStatus?: string;
    priority?: string | number;
}

export interface RequestItem {
    id: string;
    type: 'review' | 'design' | 'build';
    source: string;
    summary: string;
    file?: string;
    line?: number;
    severity?: string;
    status: 'open' | 'resolved';
    prId?: number;
    createdAt: string;
    /** Planning / workflow story key when this row is story-scoped (e.g. wrap-up). */
    storyNumber?: string;
}

export interface PullRequest {
    id: number;
    title: string;
    status: 'draft' | 'active' | 'completed' | 'abandoned';
    comments: number;
    approvals: number;
    url?: string;
    batchTaskIds?: string[];
}

export interface TaskReconciliation {
    status: 'pending' | 'reuse-confirmed';
    storyNumber: string;
    reason: string;
    detectedAt: string;
    matchingTaskIds: string[];
    matchingTasks: Array<Pick<TaskItem, 'id' | 'name' | 'status' | 'category' | 'hours' | 'priority'>>;
}

export function getPrUrl(pr: PullRequest): string {
    return pr.url || '#';
}

export interface CypressFailure {
    spec: string;
    test: string;
    error: string;
}

export interface CypressResults {
    lastRun: string | null;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    failures: CypressFailure[];
}

export interface StatusEvent {
    timestamp: string;
    type: 'info' | 'success' | 'warning' | 'error' | 'phase' | 'verdict';
    message: string;
}

export interface AgentStatus {
    storyNumber: string | null;
    storyName: string | null;
    /** HTML or plain text from planning adapters; dashboard strips tags for display. */
    storyDescription?: string | null;
    teamId?: string | null;
    currentPhase: Phase;
    currentTask: string | null;
    startedAt: string | null;
    /** True when the agent process is alive; false means it was terminated or never started. */
    isRunning?: boolean;
    /** True once the current handoff/step has been dispatched; in step mode this marks a paused checkpoint. */
    handoffDispatched?: boolean;
    /** True when global step mode is active (agent pauses for approval after each handoff). */
    globalStepMode?: boolean;
    /** Agent identifier, populated when statuses are keyed by agent ID in the dashboard. */
    id?: string;
    /** Chat responsiveness tier: 'live' = active session, 'auto-reply' = Ollama fallback, 'unavailable' = no injection mechanism. */
    chatCapability?: 'live' | 'auto-reply' | 'unavailable';
    /** Configured model for this agent (e.g. 'auto', 'composer-2', 'local'). */
    model?: string;
    tokens: {
        cloud?: TokenMetrics;
        meshllm?: TokenMetrics;
        ollama?: TokenMetrics;
        mlx?: TokenMetrics;
    };
    tasks: TaskItem[];
    requests?: RequestItem[];
    prs: PullRequest[];
    cypress: CypressResults;
    events: StatusEvent[];
    messages?: AgentMessage[];
    collaborators?: string[];
    designSpec?: string;
    taskReconciliation?: TaskReconciliation;
    archivedTasks?: Array<TaskItem & { archivedAt: string; archivedReason: string }>;
}

/** Dashboard wrap-up rows: `WRAPUP-PR-{n}` or `WRAPUP-{story}-PR-{n}`. */
export function isWrapUpDeskRequestId(id: string): boolean {
    const s = String(id);
    return /^WRAPUP-PR-\d+$/.test(s) || /^WRAPUP-[A-Za-z0-9-]+-PR-\d+$/.test(s);
}

/** Same stable id as `wrapUpDeskRequestId` in server handoff (story-scoped when `storyNumber` is set). */
export function wrapUpDeskRequestId(storyNumber: string | null | undefined, prId: number): string {
    const slug = typeof storyNumber === 'string' ? storyNumber.trim().replace(/[^a-zA-Z0-9-]+/g, '') : '';
    if (slug) return `WRAPUP-${slug}-PR-${prId}`;
    return `WRAPUP-PR-${prId}`;
}

/** Open wrap-up queue rows (exclude resolved; count rows without explicit status as open). */
export function openWrapUpRequestCount(status: AgentStatus | null | undefined): number {
    if (!status?.requests?.length) return 0;
    return status.requests.filter(
        (r) => isWrapUpDeskRequestId(r.id) && r.status !== 'resolved',
    ).length;
}

/** Alias for {@link openWrapUpRequestCount}. Wrap-up is listed on the DevOps desk, not the floor pills. */
export function devopsWrapUpAttentionCount(status: AgentStatus | null | undefined): number {
    return openWrapUpRequestCount(status);
}

/** @deprecated Use AgentStatus instead */
export type LasairStatus = AgentStatus;

export type AgentRole = 'frontend' | 'backend' | 'qa' | 'ux' | 'devops' | 'reviewer' | 'aiqa';

export interface AgentProfile {
    id: string;
    name: string;
    shortName: string;
    role: AgentRole;
    title: string;
    accentColor: string;
    statusFile: string;
    active: boolean;
    avatar: string;
}

export type MessageDeliveryStatus = 'pending' | 'read' | 'acted';

/**
 * Status-file messages embedded in agent status JSON.
 * Uses `text` for the body. Contrast with `ChatMessage` which uses `message` —
 * the watcher and triggers layer normalizes both via `raw.message ?? raw.text`.
 */
export interface AgentMessage {
    id: string;
    from: string;
    text: string;
    timestamp: string;
    status: MessageDeliveryStatus;
}

export interface ChatMessage {
    id: string;
    timestamp: string;
    from: string;
    agentId: string;
    message: string;
    status?: MessageDeliveryStatus;
}

export const AGENT_ROSTER: AgentProfile[] = [
    {
        id: 'frontend',
        name: defaultAgentDisplayName('frontend'),
        shortName: defaultAgentDisplayName('frontend'),
        role: 'frontend',
        title: 'Frontend Engineer',
        accentColor: '#6366f1',
        statusFile: '.frontend-status.json',
        active: true,
        avatar: 'F',
    },
    {
        id: 'backend',
        name: defaultAgentDisplayName('backend'),
        shortName: defaultAgentDisplayName('backend'),
        role: 'backend',
        title: 'Backend Engineer',
        accentColor: '#10b981',
        statusFile: '.backend-status.json',
        active: true,
        avatar: 'B',
    },
    {
        id: 'qa',
        name: defaultAgentDisplayName('qa'),
        shortName: defaultAgentDisplayName('qa'),
        role: 'qa',
        title: 'QA Engineer',
        accentColor: '#f59e0b',
        statusFile: '.qa-status.json',
        active: true,
        avatar: 'Q',
    },
    {
        id: 'ux',
        name: defaultAgentDisplayName('ux'),
        shortName: defaultAgentDisplayName('ux'),
        role: 'ux',
        title: 'UX Designer',
        accentColor: '#ec4899',
        statusFile: '.ux-status.json',
        active: true,
        avatar: 'U',
    },
    {
        id: 'reviewer',
        name: defaultAgentDisplayName('reviewer'),
        shortName: defaultAgentDisplayName('reviewer'),
        role: 'reviewer',
        title: 'PR Reviewer',
        accentColor: '#8b5cf6',
        statusFile: '.reviewer-status.json',
        active: true,
        avatar: 'R',
    },
    {
        id: 'devops',
        name: defaultAgentDisplayName('devops'),
        shortName: defaultAgentDisplayName('devops'),
        role: 'devops',
        title: 'DevOps Engineer',
        accentColor: '#06b6d4',
        statusFile: '.devops-status.json',
        active: true,
        avatar: 'O',
    },
    {
        id: 'aiqa',
        name: defaultAgentDisplayName('aiqa'),
        shortName: defaultAgentDisplayName('aiqa'),
        role: 'aiqa',
        title: 'AI Quality Engineer',
        accentColor: '#14b8a6',
        statusFile: '.aiqa-status.json',
        active: true,
        avatar: 'AI',
    },
];

export type PullRequestWithAgentName = PullRequest & { agentName: string };

/**
 * PR ids Brehon's work card marks Complete (see /api/status normalization). Story-owner
 * or DevOps JSON may still list the same PR as active; omit those from the header
 * Open PRs total so it matches the reviewer card.
 */
export function reviewerCompletedPrIds(agentStatuses: Record<string, AgentStatus | null>): Set<number> {
    const reviewer = agentStatuses.reviewer;
    if (!reviewer?.prs?.length) return new Set();
    const ids = new Set<number>();
    for (const p of reviewer.prs) {
        if (p.status === 'completed') ids.add(p.id);
    }
    return ids;
}

/** Unique active PRs for the stats bar, excluding reviewer-completed rows. */
export function collectHeaderOpenPullRequests(
    agentStatuses: Record<string, AgentStatus | null>,
    displayNames: Record<string, string> = {},
): PullRequestWithAgentName[] {
    const reviewerDone = reviewerCompletedPrIds(agentStatuses);
    const seen = new Set<number>();
    const out: PullRequestWithAgentName[] = [];
    for (const agent of AGENT_ROSTER) {
        const status = agentStatuses[agent.id];
        if (!status?.prs) continue;
        for (const pr of status.prs) {
            if (pr.status !== 'active' || reviewerDone.has(pr.id) || seen.has(pr.id)) continue;
            seen.add(pr.id);
            out.push({ ...pr, agentName: displayNames[agent.id] || agent.name });
        }
    }
    return out;
}

export const EXCLUDED_STORY_STATUSES = [
    'Released',
    'In Master',
    'Pending Release',
    'Accepted',
];

export const ROLE_LABELS: Record<AgentRole, string> = {
    frontend: 'Frontend',
    backend: 'Backend',
    qa: 'QA',
    ux: 'UX Design',
    devops: 'DevOps',
    reviewer: 'Code Review',
    aiqa: 'AI Quality',
};

export type OrgNodeKind = 'lead' | 'agent' | 'delegate' | 'contractor';

export interface OrgNode {
    id: string;
    name: string;
    shortName: string;
    kind: OrgNodeKind;
    title: string;
    model?: string;
    accentColor: string;
    avatar: string;
    active: boolean;
    reportsTo?: string;
    updateAvailable?: boolean;
    description: string;
}

export interface OllamaHealth {
    online: boolean;
    model: string;
    latestModel?: string;
    updateAvailable: boolean;
    lastChecked: string | null;
    ragReady?: boolean;
}

export const ORG_CHART: OrgNode[] = [
    {
        id: 'ev',
        name: 'Ev',
        shortName: 'Ev',
        kind: 'lead',
        title: 'Engineering Lead',
        model: 'Opus 4.6',
        accentColor: '#a78bfa',
        avatar: 'E',
        active: true,
        description: 'Cloud AI lead (the Cursor agent). Makes architectural decisions, reviews complex code, coordinates the team, and uses The Office tools to save tokens. This is the agent you chat with.',
    },
    {
        id: 'frontend',
        name: defaultAgentDisplayName('frontend'),
        shortName: defaultAgentDisplayName('frontend'),
        kind: 'agent',
        title: 'Frontend Engineer',
        accentColor: '#6366f1',
        avatar: 'F',
        active: true,
        reportsTo: 'ev',
        description: 'Handles Angular components, services, routing, and frontend stories end-to-end.',
    },
    {
        id: 'backend',
        name: defaultAgentDisplayName('backend'),
        shortName: defaultAgentDisplayName('backend'),
        kind: 'agent',
        title: 'Backend Engineer',
        accentColor: '#10b981',
        avatar: 'B',
        active: true,
        reportsTo: 'ev',
        description: '.NET Core APIs, Entity Framework, repository patterns, and backend logic.',
    },
    {
        id: 'qa',
        name: defaultAgentDisplayName('qa'),
        shortName: defaultAgentDisplayName('qa'),
        kind: 'agent',
        title: 'QA Engineer',
        accentColor: '#f59e0b',
        avatar: 'Q',
        active: true,
        reportsTo: 'ev',
        description: 'Cypress test runner, failure triage, and test authoring. Runs SDLC Framework and YourProject test suites.',
    },
    {
        id: 'ux',
        name: defaultAgentDisplayName('ux'),
        shortName: defaultAgentDisplayName('ux'),
        kind: 'agent',
        title: 'UX Designer',
        accentColor: '#ec4899',
        avatar: 'U',
        active: true,
        reportsTo: 'ev',
        description: 'UX research, design specs, accessibility audits, and theme design. Collaborates with the frontend agent on shared stories.',
    },
    {
        id: 'ollama',
        name: 'Ollama',
        shortName: 'Oll',
        kind: 'delegate',
        title: 'Local SLM Pool',
        model: 'deepseek-coder:6.7b',
        accentColor: '#06b6d4',
        avatar: 'O',
        active: true,
        reportsTo: 'frontend',
        description: 'Local small language models for lint fixes, boilerplate, simple tests, and review responses. Saves cloud tokens.',
    },
    {
        id: 'reviewer',
        name: defaultAgentDisplayName('reviewer'),
        shortName: defaultAgentDisplayName('reviewer'),
        kind: 'agent',
        title: 'PR Reviewer',
        accentColor: '#8b5cf6',
        avatar: 'R',
        active: true,
        reportsTo: 'ev',
        description: 'The Judge. Watches the Ninja Turtles PR channel in Teams, reviews pull requests, leaves comments, and approves or requests changes.',
    },
    {
        id: 'devops',
        name: defaultAgentDisplayName('devops'),
        shortName: defaultAgentDisplayName('devops'),
        kind: 'agent',
        title: 'DevOps Engineer',
        accentColor: '#06b6d4',
        avatar: 'O',
        active: true,
        reportsTo: 'ev',
        description: 'CI/CD pipelines, build validation, and infrastructure. Monitors configured build adapters and gates PR merges on passing builds.',
    },
    {
        id: 'goose',
        name: 'Goose',
        shortName: 'Gse',
        kind: 'contractor',
        title: 'Codebase Analyst',
        accentColor: '#78716c',
        avatar: 'G',
        active: true,
        description: 'External liaison. Provides zero-token codebase analysis via static analysis tools. Any agent can call Goose.',
    },
];
