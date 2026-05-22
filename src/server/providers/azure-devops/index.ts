import type { ICodeReview, CreatePROptions } from '../ICodeReview';
import type { PREvent } from '../types';

/**
 * Azure DevOps adapter.
 * Delegates to the existing ado-bridge for the heavy lifting.
 * CR_PROVIDER=azure-devops (default)
 */
export class AzureDevOpsCodeReview implements ICodeReview {
    readonly providerName = 'azure-devops';

    constructor(private rootDir: string, private configFile: string) {}

    async createPR(opts: CreatePROptions): Promise<PREvent> {
        const { createAdoPR } = await import('../../ado-bridge');
        const result = await createAdoPR({
            title: opts.title,
            description: opts.description,
            sourceBranch: opts.sourceBranch,
            targetBranch: opts.targetBranch,
            workItemIds: opts.workItemIds,
            draft: opts.draft,
        });
        return {
            prId: String(result.prId),
            title: opts.title,
            url: result.url ?? '',
            status: 'open',
            buildStatus: 'pending',
            branch: opts.sourceBranch,
            repo: opts.repo,
        };
    }

    async getPR(prId: string): Promise<PREvent | null> {
        const { getAdoPR } = await import('../../ado-bridge');
        const result = await getAdoPR(prId);
        if (!result) return null;
        return {
            prId,
            title: result.title ?? '',
            url: result.url ?? '',
            status: result.status ?? 'open',
            buildStatus: result.buildStatus,
        };
    }

    async triggerBuild(branch: string, repo?: string): Promise<{ buildId: string; url?: string }> {
        const { triggerAdoBuild } = await import('../../ado-bridge');
        return triggerAdoBuild(branch, repo);
    }

    async getBuildStatus(buildId: string): Promise<PREvent['buildStatus']> {
        const { getAdoBuildStatus } = await import('../../ado-bridge');
        return getAdoBuildStatus(buildId);
    }
}
