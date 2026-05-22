import type { NotificationPayload } from './types';

export type { WorkItem, WorkItemSummary, Team, PREvent, NotificationPayload } from './types';
export type { IProjectTracker, FetchStoriesOptions } from './IProjectTracker';
export type { ICodeReview, CreatePROptions } from './ICodeReview';
export type { INotifications } from './INotifications';

export { MockProjectTracker, MockCodeReview, MockNotifications } from './mock';

/**
 * Resolve the active project tracker.
 * PM_PROVIDER=agility (default) | jira | github | mock
 *
 * New providers: implement IProjectTracker and add a case here.
 */
export async function resolveProjectTracker(rootDir: string, configFile: string) {
    const provider = (process.env.PM_PROVIDER ?? 'agility').toLowerCase();
    if (provider === 'mock') {
        const { MockProjectTracker } = await import('./mock');
        return new MockProjectTracker(rootDir);
    }
    // Default: Agility/VersionOne — delegates to existing v1Fetch infrastructure
    const { AgilityProjectTracker } = await import('./agility');
    return new AgilityProjectTracker(rootDir, configFile);
}

export async function resolveCodeReview(rootDir: string, configFile: string) {
    const provider = (process.env.CR_PROVIDER ?? 'azure-devops').toLowerCase();
    if (provider === 'mock') {
        const { MockCodeReview } = await import('./mock');
        return new MockCodeReview();
    }
    const { AzureDevOpsCodeReview } = await import('./azure-devops');
    return new AzureDevOpsCodeReview(rootDir, configFile);
}

export async function resolveNotifications(rootDir: string) {
    const provider = (process.env.NOTIFY_PROVIDER ?? 'teams').toLowerCase();
    if (provider === 'mock' || provider === 'none') {
        const { MockNotifications } = await import('./mock');
        return new MockNotifications();
    }
    const { TeamsNotifications } = await import('./teams');
    return new TeamsNotifications(rootDir);
}

/** Convenience wrapper: resolve the notifier for rootDir and send in one call. */
export async function notify(rootDir: string, payload: NotificationPayload): Promise<boolean> {
    const notifier = await resolveNotifications(rootDir);
    return notifier.send(payload);
}
