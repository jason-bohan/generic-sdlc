import type { PREvent } from './types';

export interface CreatePROptions {
    title: string;
    description?: string;
    sourceBranch: string;
    targetBranch: string;
    repo?: string;
    workItemIds?: string[];
    draft?: boolean;
}

export interface ICodeReview {
    /** Create a pull request and return a PREvent */
    createPR(opts: CreatePROptions): Promise<PREvent>;

    /** Get status of an existing PR */
    getPR(prId: string): Promise<PREvent | null>;

    /** Trigger a CI build for a branch */
    triggerBuild(branch: string, repo?: string): Promise<{ buildId: string; url?: string }>;

    /** Get build status */
    getBuildStatus(buildId: string): Promise<PREvent['buildStatus']>;

    readonly providerName: string;
}
