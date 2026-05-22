import type { Team, WorkItem, WorkItemSummary } from './types';

export interface FetchStoriesOptions {
    team?: string;
    status?: string;
    text?: string;
    maxResults?: number;
}

export interface IProjectTracker {
    /** List available teams */
    getTeams(): Promise<Team[]>;

    /** List stories/work items, optionally filtered */
    getStories(opts?: FetchStoriesOptions): Promise<WorkItemSummary[]>;

    /** Fetch a single work item by number or id */
    getWorkItem(numberOrId: string): Promise<WorkItem | null>;

    /** Update a work item's status */
    updateStatus(numberOrId: string, status: string): Promise<boolean>;

    /** Create a new work item */
    createWorkItem(fields: Partial<WorkItem>): Promise<WorkItem>;

    readonly providerName: string;
}
