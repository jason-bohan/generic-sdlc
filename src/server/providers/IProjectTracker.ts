import type { Team, WorkItem, WorkItemSummary } from './types';
import type { RawTask } from '../status-normalize';

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

    /** Fetch existing planning tasks (subtasks/child tasks) for a story. Returns [] if the provider doesn't support it. */
    getTasksForStory(storyNumber: string): Promise<RawTask[]>;

    readonly providerName: string;
}
