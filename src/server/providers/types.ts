// The "universal language" all adapters speak.
// No adapter leaks platform-specific types past this boundary.

export interface WorkItem {
    id: string;
    number: string;
    title: string;
    description: string;
    status: string;
    type: 'story' | 'bug' | 'task' | 'defect' | 'feature';
    teamId?: string;
    team?: string;
    assignee?: string;
    estimate?: number | null;
    priority?: string;
    classOfService?: string;
    acceptanceCriteria?: string;
    /** Lane-level breakdown for multi-discipline agents */
    lanes?: { frontend?: string; backend?: string; qa?: string };
    url?: string;
    source: 'agility' | 'jira' | 'github' | 'local' | 'mock';
}

export interface WorkItemSummary {
    id: string;
    number: string;
    title: string;
    status: string;
    team?: string;
    teamId?: string;
    estimate?: number | null;
    priority?: string;
    source: WorkItem['source'];
}

export interface Team {
    id: string;
    name: string;
}

export interface PREvent {
    prId: string;
    title: string;
    url: string;
    status: 'open' | 'merged' | 'closed' | 'draft';
    buildStatus?: 'pending' | 'passing' | 'failing' | 'unknown';
    branch?: string;
    repo?: string;
}

export interface NotificationPayload {
    title: string;
    body: string;
    url?: string;
    agentId?: string;
    storyNumber?: string;
    level?: 'info' | 'success' | 'warning' | 'error';
    /** Provider-specific theme color (e.g. hex string for Teams MessageCard). Ignored by non-Teams providers. */
    color?: string;
}
