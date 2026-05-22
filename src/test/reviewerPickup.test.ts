import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { cleanup, readJson, startServer, writeJson } from './helpers/server-harness';
import { mockAdoFetch } from '../server/mock-external';
import * as spawnAgentMod from '../server/spawn-agent';

const TMP = resolve(__dirname, '.reviewer-pickup-tmp');
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');

let httpServer: Awaited<ReturnType<typeof startServer>> | null = null;

async function request(path: string, init?: RequestInit) {
    const { res, body } = await httpServer!.request(path, init);
    return { res, body: body as Record<string, any> };
}

beforeEach(async () => {
    vi.spyOn(spawnAgentMod, 'spawnAgent').mockReturnValue({ spawned: false });
    cleanup(TMP);
    mkdirSync(TMP, { recursive: true });
    writeJson(CONFIG, {
        externalMode: 'mock',
        activeProject: 'YourProject',
        projects: {
            YourProject: {
                organization: 'mock-org',
                azureProject: 'YourProject',
                repositoryId: 'mock-repo',
                targetBranch: 'master',
                pipelineId: 646,
                reviewerIds: ['mock-reviewer'],
                prUrlBase: 'mock://ado/pr',
                teamPrefixes: { 'Team:2001': 'teams/' },
                workspacePath: TMP,
            },
        },
        scheduler: { mode: 'notify', agents: { reviewer: { enabled: true, autoStart: false, stepMode: true } } },
    });
    httpServer = await startServer(TMP);
});

afterEach(async () => {
    if (httpServer) await httpServer.stop();
    httpServer = null;
    vi.restoreAllMocks();
    cleanup(TMP);
});

describe('reviewer PR pickup', () => {
    it('lists active mock Azure DevOps PRs with branch filters', async () => {
        mockAdoFetch(TMP, '/git/repositories/mock-repo/pullrequests?api-version=7.1', 'POST', {
            title: 'B-17001 Add YourProject filter',
            sourceRefName: 'refs/heads/teams/b-17001-YourProject-filter',
            targetRefName: 'refs/heads/master',
            createdBy: { id: 'dev-1', displayName: 'Lasair', uniqueName: 'lasair@example.test' },
        });
        mockAdoFetch(TMP, '/git/repositories/mock-repo/pullrequests?api-version=7.1', 'POST', {
            title: 'B-17002 Backend cleanup',
            sourceRefName: 'refs/heads/backend/b-17002-cleanup',
            targetRefName: 'refs/heads/master',
            createdBy: { id: 'dev-2', displayName: 'Cairn', uniqueName: 'cairn@example.test' },
        });

        const result = await request('/api/reviewer/prs?branchPrefix=teams/');

        expect(result.res.status).toBe(200);
        expect(result.body.count).toBe(1);
        expect(result.body.prs[0]).toMatchObject({
            title: 'B-17001 Add YourProject filter',
            sourceBranch: 'teams/b-17001-YourProject-filter',
            storyNumber: 'B-17001',
            projectKey: 'YourProject',
        });
    });

    it('picks up a PR onto Brehon desk without spawning in step mode', async () => {
        const seeded = mockAdoFetch(TMP, '/git/repositories/mock-repo/pullrequests?api-version=7.1', 'POST', {
            title: 'B-17003 Review outside owner flow',
            sourceRefName: 'refs/heads/teams/b-17003-review-pickup',
            targetRefName: 'refs/heads/master',
            createdBy: { id: 'dev-3', displayName: 'Team Member', uniqueName: 'team@example.test' },
        }) as { pullRequestId: number };

        const result = await request('/api/reviewer/pick-pr', {
            method: 'POST',
            body: JSON.stringify({ prId: seeded.pullRequestId, projectKey: 'YourProject' }),
        });

        expect(result.res.status).toBe(200);
        expect(result.body).toMatchObject({
            ok: true,
            agentSpawned: false,
            reviewerStepMode: true,
            pr: { id: seeded.pullRequestId, branch: 'teams/b-17003-review-pickup', storyNumber: 'B-17003', projectKey: 'YourProject' },
        });
        expect(spawnAgentMod.spawnAgent).not.toHaveBeenCalled();

        const reviewerFile = resolve(TMP, '.reviewer-status.json');
        expect(existsSync(reviewerFile)).toBe(true);
        const status = readJson(reviewerFile);
        expect(status.currentPhase).toBe('pending-review');
        expect(status.assignedPR.id).toBe(seeded.pullRequestId);
        expect(status.tasks[0]).toMatchObject({ id: `PR-REVIEW-${seeded.pullRequestId}`, category: 'Review', status: 'pending' });

        const state = readJson(resolve(TMP, '.sdlc-framework', 'mock', 'state.json'));
        expect(state.notifications.some((n: { title: string }) => n.title.includes(`PR #${seeded.pullRequestId}`))).toBe(true);
    });

    it('pick-pr returns 409 when mock Azure PR is completed (merged)', async () => {
        const seeded = mockAdoFetch(TMP, '/git/repositories/mock-repo/pullrequests?api-version=7.1', 'POST', {
            title: 'B-17004 Already merged',
            sourceRefName: 'refs/heads/teams/b-17004-merged',
            targetRefName: 'refs/heads/master',
            createdBy: { id: 'dev-4', displayName: 'Dev', uniqueName: 'dev@example.test' },
        }) as { pullRequestId: number };

        const statePath = resolve(TMP, '.sdlc-framework', 'mock', 'state.json');
        const state = readJson(statePath);
        const row = state.prs.find((p: { pullRequestId?: number }) => p.pullRequestId === seeded.pullRequestId);
        expect(row).toBeDefined();
        row.status = 'completed';
        writeJson(statePath, state);

        const result = await request('/api/reviewer/pick-pr', {
            method: 'POST',
            body: JSON.stringify({ prId: seeded.pullRequestId, projectKey: 'YourProject' }),
        });

        expect(result.res.status).toBe(409);
        expect(String(result.body.error)).toMatch(/completed/i);
        expect(spawnAgentMod.spawnAgent).not.toHaveBeenCalled();
    });
});
