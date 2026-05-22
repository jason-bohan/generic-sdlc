import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { cleanup, readJson, startServer, writeJson } from './helpers/server-harness';
import { minimalStatus, stoppedStatus, workingStatus } from './helpers/status-fixtures';
import { closeDb, initDb } from '../server/db';
import * as spawnAgent from '../server/spawn-agent';

const TMP = resolve(__dirname, '.request-handoff-e2e-tmp');

let httpServer: Awaited<ReturnType<typeof startServer>> | null = null;

async function req(path: string, init?: RequestInit) {
    const { res, body } = await httpServer!.request(path, init);
    return { res, body: body as Record<string, any> };
}

beforeEach(async () => {
    spawnAgent.setTestRunnerActive(true);
    closeDb();
    cleanup(TMP);
    mkdirSync(TMP, { recursive: true });
    delete process.env.SDLC_EXTERNAL_MODE;
    delete process.env.AZURE_DEVOPS_PAT;
    delete process.env.AZURE_DEVOPS_EXT_PAT;
    delete process.env.VSS_PAT;

    writeJson(resolve(TMP, '.sdlc-framework.config.json'), {
        externalMode: 'mock',
        activeProject: 'YourProject',
        project: { prUrlBase: 'mock://ado/pr' },
        projects: {
            YourProject: {
                organization: 'mock-org',
                azureProject: 'YourProject',
                repositoryId: 'mock-repo',
                targetBranch: 'master',
                pipelineId: 646,
                reviewerIds: ['mock-reviewer'],
                prUrlBase: 'mock://ado/pr',
                workspacePath: TMP,
            },
        },
        scheduler: {
            mode: 'notify',
            agents: {
                frontend: { enabled: true, autoStart: false, stepMode: true },
            },
        },
    });

    writeJson(resolve(TMP, '.frontend-status.json'), { ...minimalStatus });

    initDb(TMP);
    httpServer = await startServer(TMP);
});

afterEach(async () => {
    if (httpServer) await httpServer.stop();
    httpServer = null;
    closeDb();
    spawnAgent.setTestRunnerActive(false);
    delete process.env.SDLC_EXTERNAL_MODE;
    cleanup(TMP);
});

describe('request handoff data flow', () => {
    it('review-complete with comments writes requests[] into owner status file', async () => {
        const { res } = await req('/api/handoff/review-complete', {
            method: 'POST',
            body: JSON.stringify({
                prId: 42,
                verdict: 'changes-requested',
                storyNumber: 'B-17003',
                commentCount: 2,
                comments: [
                    { summary: 'Extract this into a helper function', file: 'src/utils.ts', line: 42 },
                    { summary: 'Missing null check on response', file: 'src/api.ts', line: 15 },
                ],
            }),
        });
        expect(res.status).toBe(200);

        const status = readJson(resolve(TMP, '.frontend-status.json'));
        expect(status.currentPhase).toBe('addressing-feedback');
        expect(status.requests).toHaveLength(2);
        expect(status.requests[0]).toMatchObject({
            id: 'R-42-1',
            type: 'review',
            source: 'reviewer',
            summary: 'Extract this into a helper function',
            file: 'src/utils.ts',
            line: 42,
            status: 'open',
            prId: 42,
        });
        expect(status.requests[1]).toMatchObject({
            id: 'R-42-2',
            summary: 'Missing null check on response',
            file: 'src/api.ts',
            line: 15,
        });
    });

    it('review-complete without comments does not create requests[]', async () => {
        const { res } = await req('/api/handoff/review-complete', {
            method: 'POST',
            body: JSON.stringify({
                prId: 42,
                verdict: 'changes-requested',
                storyNumber: 'B-17003',
                commentCount: 3,
            }),
        });
        expect(res.status).toBe(200);

        const status = readJson(resolve(TMP, '.frontend-status.json'));
        expect(status.currentPhase).toBe('addressing-feedback');
        expect(status.requests).toBeUndefined();
    });

    it('review-complete loads reviewer comment threads when comments are omitted', async () => {
        writeJson(resolve(TMP, '.reviewer-comments.json'), {
            prId: 42,
            threads: [
                { id: '7', file: 'src/api.ts', line: 18, comment: 'Return a typed error here.', severity: 'warning' },
            ],
        });

        const { res } = await req('/api/handoff/review-complete', {
            method: 'POST',
            body: JSON.stringify({
                prId: 42,
                verdict: 'changes-requested',
                storyNumber: 'B-17003',
            }),
        });
        expect(res.status).toBe(200);

        const status = readJson(resolve(TMP, '.frontend-status.json'));
        expect(status.currentPhase).toBe('addressing-feedback');
        expect(status.requests).toHaveLength(1);
        expect(status.requests[0]).toMatchObject({
            id: 'REQ-7',
            summary: 'Return a typed error here.',
            file: 'src/api.ts',
            line: 18,
            severity: 'warning',
            prId: 42,
        });
    });

    it('review-complete reports no spawn when target owner is in step mode', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent');
        try {
            const { res, body } = await req('/api/handoff/review-complete', {
                method: 'POST',
                body: JSON.stringify({
                    prId: 42,
                    verdict: 'changes-requested',
                    storyNumber: 'B-17003',
                }),
            });

            expect(res.status).toBe(200);
            expect(body.agentSpawned).toBe(false);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it('review-complete reports actual devops spawn result on approval', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent').mockReturnValue({ spawned: true, pid: 1234 });
        try {
            const cfg = readJson(resolve(TMP, '.sdlc-framework.config.json'));
            cfg.scheduler.agents.frontend.stepMode = false;
            writeJson(resolve(TMP, '.sdlc-framework.config.json'), cfg);

            const { res, body } = await req('/api/handoff/review-complete', {
                method: 'POST',
                body: JSON.stringify({
                    prId: 42,
                    verdict: 'approved',
                    storyNumber: 'B-17003',
                }),
            });

            expect(res.status).toBe(200);
            expect(body.agentSpawned).toBe(true);
            expect(spy).toHaveBeenCalledWith(
                'devops',
                expect.stringContaining('Build gate for PR #42'),
                TMP,
                'auto',
            );
        } finally {
            spy.mockRestore();
        }
    });

    it('review-complete assigns DevOps build desk without spawning or bridge permission while story owner is in step mode', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent').mockReturnValue({ spawned: true, pid: 1234 });
        try {
            const { res, body } = await req('/api/handoff/review-complete', {
                method: 'POST',
                body: JSON.stringify({
                    prId: 42,
                    verdict: 'approved',
                    storyNumber: 'B-17003',
                }),
            });

            expect(res.status).toBe(200);
            expect(body).toMatchObject({
                target: 'devops',
                targetPhase: 'pending-build',
                agentSpawned: false,
            });
            expect(spy).not.toHaveBeenCalled();

            const devops = readJson(resolve(TMP, '.devops-status.json'));
            expect(devops.currentPhase).toBe('pending-build');
            expect(devops.manualStartRequired).toBe(true);
            expect(devops.assignedPR.id).toBe(42);
        } finally {
            spy.mockRestore();
        }
    });

    it('review-complete waits for pending design review without spawning devops', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent');
        try {
            const statusData = readJson(resolve(TMP, '.frontend-status.json'));
            statusData.prs[0].designReview = { verdict: 'pending', reviewedAt: null };
            writeJson(resolve(TMP, '.frontend-status.json'), statusData);

            const { res, body } = await req('/api/handoff/review-complete', {
                method: 'POST',
                body: JSON.stringify({
                    prId: 42,
                    verdict: 'approved',
                    storyNumber: 'B-17003',
                }),
            });

            expect(res.status).toBe(200);
            expect(body).toMatchObject({
                target: 'waiting-for-design-review',
                targetPhase: 'watching-reviews',
                agentSpawned: false,
            });
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it('build-complete with failure writes a build request into owner status', async () => {
        writeJson(resolve(TMP, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 42, storyNumber: 'B-17003' },
            events: [],
        });

        const { res } = await req('/api/handoff/build-complete', {
            method: 'POST',
            body: JSON.stringify({ prId: 42, result: 'failed', buildId: 999 }),
        });
        expect(res.status).toBe(200);

        const status = readJson(resolve(TMP, '.frontend-status.json'));
        expect(status.requests).toHaveLength(1);
        expect(status.requests[0]).toMatchObject({
            id: 'B-42-999',
            type: 'build',
            source: 'devops',
            status: 'open',
            prId: 42,
        });
        expect(status.requests[0].summary).toContain('failed');
    });

    it('pr-created stores the active in-progress task batch on the PR', async () => {
        const statusData = readJson(resolve(TMP, '.frontend-status.json'));
        statusData.currentPhase = 'creating-pr';
        statusData.tasks = [
            { id: 'TK-1', number: 'TK-1', name: 'Selected A', status: 'in_progress', hours: 1 },
            { id: 'TK-2', number: 'TK-2', name: 'Selected B', status: 'in_progress', hours: 1 },
            { id: 'TK-3', number: 'TK-3', name: 'Later', status: 'pending', hours: 1 },
        ];
        writeJson(resolve(TMP, '.frontend-status.json'), statusData);

        const { res } = await req('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 4242,
                prTitle: 'Batch PR',
                storyNumber: 'B-17003',
            }),
        });

        expect(res.status).toBe(200);
        const after = readJson(resolve(TMP, '.frontend-status.json'));
        expect(after.prs.find((p: { id: number }) => p.id === 4242).batchTaskIds).toEqual(['TK-1', 'TK-2']);
        expect(after.activePrBatchTaskIds).toEqual(['TK-1', 'TK-2']);
        expect(after.tasks.find((t: { id: string }) => t.id === 'TK-1').status).toBe('completed');
        expect(after.tasks.find((t: { id: string }) => t.id === 'TK-2').status).toBe('completed');
        expect(after.tasks.find((t: { id: string }) => t.id === 'TK-3').status).toBe('pending');
    });

    it('pr-created preserves selected batch ids even when the agent reset task status before PR registration', async () => {
        const statusData = readJson(resolve(TMP, '.frontend-status.json'));
        statusData.currentPhase = 'creating-pr';
        statusData.activePrBatchTaskIds = ['TK-2'];
        statusData.tasks = [
            { id: 'TK-1', number: 'TK-1', name: 'Later', status: 'pending', hours: 1 },
            { id: 'TK-2', number: 'TK-2', name: 'Selected but reset', status: 'pending', hours: 1 },
        ];
        writeJson(resolve(TMP, '.frontend-status.json'), statusData);

        const { res } = await req('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 4243,
                prTitle: 'Recovered Batch PR',
                storyNumber: 'B-17003',
            }),
        });

        expect(res.status).toBe(200);
        const after = readJson(resolve(TMP, '.frontend-status.json'));
        expect(after.prs.find((p: { id: number }) => p.id === 4243).batchTaskIds).toEqual(['TK-2']);
        expect(after.activePrBatchTaskIds).toEqual(['TK-2']);
        expect(after.tasks.find((t: { id: string }) => t.id === 'TK-1').status).toBe('pending');
        expect(after.tasks.find((t: { id: string }) => t.id === 'TK-2').status).toBe('completed');
    });

    it('pr-created assigns reviewer desk but does not auto-spawn reviewer when creator is in step mode', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent').mockReturnValue({ spawned: true, pid: 1234 });
        try {
            const statusData = readJson(resolve(TMP, '.frontend-status.json'));
            statusData.currentPhase = 'creating-pr';
            statusData.tasks = [
                { id: 'TK-1', number: 'TK-1', name: 'Selected A', status: 'in_progress', hours: 1 },
            ];
            writeJson(resolve(TMP, '.frontend-status.json'), statusData);

            const { res, body } = await req('/api/pr/created', {
                method: 'POST',
                body: JSON.stringify({
                    agentId: 'frontend',
                    prId: 5150,
                    prTitle: 'Manual reviewer pickup',
                    storyNumber: 'B-17003',
                }),
            });

            expect(res.status).toBe(200);
            expect(body).toMatchObject({
                agentSpawned: false,
                reviewerPhase: 'pending-review',
                reviewerAutoSpawnSkippedReason: 'creator-step-mode',
                stepMode: true,
            });
            expect(spy).not.toHaveBeenCalled();

            const reviewer = readJson(resolve(TMP, '.reviewer-status.json'));
            expect(reviewer.currentPhase).toBe('pending-review');
            expect(reviewer.assignedPR.id).toBe(5150);
            expect(reviewer.handoffDispatched).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    it('build-complete reports actual spawn result', async () => {
        writeJson(resolve(TMP, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 42, storyNumber: 'B-17003' },
            events: [],
        });

        const { res, body } = await req('/api/handoff/build-complete', {
            method: 'POST',
            body: JSON.stringify({ prId: 42, result: 'failed', buildId: 999 }),
        });

        expect(res.status).toBe(200);
        expect(body.agentSpawned).toBe(false);
    });

    it('build-complete with pass does not create requests', async () => {
        writeJson(resolve(TMP, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 42, storyNumber: 'B-17003' },
            events: [],
        });

        const { res } = await req('/api/handoff/build-complete', {
            method: 'POST',
            body: JSON.stringify({ prId: 42, result: 'passed', buildId: 999 }),
        });
        expect(res.status).toBe(200);

        const status = readJson(resolve(TMP, '.frontend-status.json'));
        expect(status.requests).toBeUndefined();
    });

    it('build-complete queues DevOps wrap-up without auto-spawning DevOps when story owner is in step mode', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent').mockReturnValue({ spawned: true, pid: 1234 });
        try {
            writeJson(resolve(TMP, '.devops-status.json'), {
                currentPhase: 'monitoring-build',
                assignedPR: { id: 42, storyNumber: 'B-17003' },
                events: [],
            });

            const { res, body } = await req('/api/handoff/build-complete', {
                method: 'POST',
                body: JSON.stringify({ prId: 42, result: 'passed', buildId: 999 }),
            });

            expect(res.status).toBe(200);
            expect(body.agentSpawned).toBe(false);
            expect(spy).not.toHaveBeenCalled();

            const devops = readJson(resolve(TMP, '.devops-status.json'));
            expect(devops.currentPhase).toBe('build-passed');
            expect(devops.requests).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    id: 'WRAPUP-B-17003-PR-42',
                    status: 'open',
                    prId: 42,
                }),
            ]));
        } finally {
            spy.mockRestore();
        }
    });

    it('build-complete dedupe still marks mock ADO PR completed on pass', async () => {
        mkdirSync(resolve(TMP, '.sdlc-framework', 'mock'), { recursive: true });
        writeJson(resolve(TMP, '.sdlc-framework', 'mock', 'state.json'), {
            prs: [{ pullRequestId: 42, id: 42, status: 'active', title: 'PR 42' }],
        });
        writeJson(resolve(TMP, '.devops-status.json'), {
            currentPhase: 'build-passed',
            assignedPR: { id: 42, storyNumber: 'B-17003' },
            events: [],
        });

        const { res, body } = await req('/api/handoff/build-complete', {
            method: 'POST',
            body: JSON.stringify({ prId: 42, result: 'passed', buildId: 1 }),
        });
        expect(res.status).toBe(200);
        expect(body).toMatchObject({ ok: true, deduplicated: true });

        const mockState = readJson(resolve(TMP, '.sdlc-framework', 'mock', 'state.json'));
        expect(mockState.prs[0].status).toBe('completed');
    });

    it('design-review-complete with designComments writes design requests', async () => {
        writeJson(resolve(TMP, '.ux-status.json'), {
            currentPhase: 'reviewing-design',
            events: [],
        });

        const prData = readJson(resolve(TMP, '.frontend-status.json'));
        prData.prs[0].designReview = null;
        prData.collaborators = ['ux'];
        writeJson(resolve(TMP, '.frontend-status.json'), prData);

        const { res } = await req('/api/handoff/design-review-complete', {
            method: 'POST',
            body: JSON.stringify({
                prId: 42,
                verdict: 'changes-requested',
                storyNumber: 'B-17003',
                designComments: [
                    { summary: 'Button contrast too low on dark mode', file: 'src/button.scss' },
                ],
            }),
        });
        expect(res.status).toBe(200);

        const status = readJson(resolve(TMP, '.frontend-status.json'));
        expect(status.requests).toHaveLength(1);
        expect(status.requests[0]).toMatchObject({
            id: 'D-42-1',
            type: 'design',
            source: 'ux',
            summary: 'Button contrast too low on dark mode',
            file: 'src/button.scss',
            status: 'open',
        });
    });

    it('design-review-complete does not spawn target owner while owner is in step mode', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent');
        try {
            writeJson(resolve(TMP, '.ux-status.json'), {
                currentPhase: 'reviewing-design',
                events: [],
            });

            const prData = readJson(resolve(TMP, '.frontend-status.json'));
            prData.collaborators = ['ux'];
            writeJson(resolve(TMP, '.frontend-status.json'), prData);

            const { res, body } = await req('/api/handoff/design-review-complete', {
                method: 'POST',
                body: JSON.stringify({
                    prId: 42,
                    verdict: 'changes-requested',
                    storyNumber: 'B-17003',
                    comments: 'Spacing is off',
                }),
            });

            expect(res.status).toBe(200);
            expect(body.agentSpawned).toBe(false);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it('design-review-complete reports actual devops spawn result when both reviews are approved', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent').mockReturnValue({ spawned: true, pid: 1234 });
        try {
            writeJson(resolve(TMP, '.ux-status.json'), {
                currentPhase: 'reviewing-design',
                events: [],
            });

            const prData = readJson(resolve(TMP, '.frontend-status.json'));
            prData.collaborators = ['ux'];
            prData.prs[0].codeReview = { verdict: 'approved', reviewedAt: new Date().toISOString() };
            prData.prs[0].designReview = { verdict: 'pending', reviewedAt: null };
            writeJson(resolve(TMP, '.frontend-status.json'), prData);

            const { res, body } = await req('/api/handoff/design-review-complete', {
                method: 'POST',
                body: JSON.stringify({
                    prId: 42,
                    verdict: 'approved',
                    storyNumber: 'B-17003',
                }),
            });

            expect(res.status).toBe(200);
            expect(body.agentSpawned).toBe(true);
            expect(spy).toHaveBeenCalledWith(
                'devops',
                expect.stringContaining('Build gate for PR #42'),
                TMP,
                'auto',
            );
        } finally {
            spy.mockRestore();
        }
    });

    it('design-review-complete assigns devops but does not spawn it while devops is in step mode', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent');
        try {
            const cfg = readJson(resolve(TMP, '.sdlc-framework.config.json'));
            cfg.scheduler.agents.devops = { enabled: true, autoStart: false, stepMode: true };
            writeJson(resolve(TMP, '.sdlc-framework.config.json'), cfg);

            writeJson(resolve(TMP, '.ux-status.json'), {
                currentPhase: 'reviewing-design',
                events: [],
            });

            const prData = readJson(resolve(TMP, '.frontend-status.json'));
            prData.collaborators = ['ux'];
            prData.prs[0].codeReview = { verdict: 'approved', reviewedAt: new Date().toISOString() };
            prData.prs[0].designReview = { verdict: 'pending', reviewedAt: null };
            writeJson(resolve(TMP, '.frontend-status.json'), prData);

            const { res, body } = await req('/api/handoff/design-review-complete', {
                method: 'POST',
                body: JSON.stringify({
                    prId: 42,
                    verdict: 'approved',
                    storyNumber: 'B-17003',
                }),
            });

            expect(res.status).toBe(200);
            expect(body).toMatchObject({
                bothApproved: true,
                target: 'devops',
                targetPhase: 'pending-build',
                agentSpawned: false,
            });
            expect(spy).not.toHaveBeenCalled();

            const devops = readJson(resolve(TMP, '.devops-status.json'));
            expect(devops.currentPhase).toBe('pending-build');
            expect(devops.assignedPR.id).toBe(42);
        } finally {
            spy.mockRestore();
        }
    });

    it('design-review-complete with legacy comments string writes single request', async () => {
        writeJson(resolve(TMP, '.ux-status.json'), {
            currentPhase: 'reviewing-design',
            events: [],
        });

        const prData = readJson(resolve(TMP, '.frontend-status.json'));
        prData.collaborators = ['ux'];
        writeJson(resolve(TMP, '.frontend-status.json'), prData);

        const { res } = await req('/api/handoff/design-review-complete', {
            method: 'POST',
            body: JSON.stringify({
                prId: 42,
                verdict: 'changes-requested',
                storyNumber: 'B-17003',
                comments: 'Spacing is off on the modal header',
            }),
        });
        expect(res.status).toBe(200);

        const status = readJson(resolve(TMP, '.frontend-status.json'));
        expect(status.requests).toHaveLength(1);
        expect(status.requests[0]).toMatchObject({
            type: 'design',
            source: 'ux',
            summary: 'Spacing is off on the modal header',
            status: 'open',
        });
    });

    it('continue endpoint accepts selectedRequestIds and includes them in prompt', async () => {
        const statusData = readJson(resolve(TMP, '.frontend-status.json'));
        statusData.currentPhase = 'addressing-feedback';
        statusData.requests = [
            { id: 'R-42-1', type: 'review', source: 'reviewer', summary: 'Extract helper', file: 'src/utils.ts', line: 42, status: 'open', prId: 42, createdAt: new Date().toISOString() },
            { id: 'R-42-2', type: 'review', source: 'reviewer', summary: 'Add null check', file: 'src/api.ts', line: 15, status: 'open', prId: 42, createdAt: new Date().toISOString() },
        ];
        writeJson(resolve(TMP, '.frontend-status.json'), statusData);

        const { res, body } = await req('/api/agent/continue', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                selectedRequestIds: ['R-42-1'],
            }),
        });
        expect(res.status).toBe(200);
        expect(body.selectedRequestIds).toEqual(['R-42-1']);
    });

    it('continue endpoint works without selectedRequestIds for backward compat', async () => {
        const statusData = readJson(resolve(TMP, '.frontend-status.json'));
        statusData.currentPhase = 'addressing-feedback';
        writeJson(resolve(TMP, '.frontend-status.json'), statusData);

        const { res, body } = await req('/api/agent/continue', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend' }),
        });
        expect(res.status).toBe(200);
        expect(body.selectedRequestIds).toEqual([]);
    });

    it('continue with both selectedTaskIds and selectedRequestIds returns both', async () => {
        const statusData = readJson(resolve(TMP, '.frontend-status.json'));
        statusData.currentPhase = 'addressing-feedback';
        statusData.tasks = [{ id: 'TK-1', name: 'Fix button', status: 'in_progress', hours: 2 }];
        statusData.requests = [
            { id: 'R-42-1', type: 'review', source: 'reviewer', summary: 'Extract helper', status: 'open', prId: 42, createdAt: new Date().toISOString() },
        ];
        writeJson(resolve(TMP, '.frontend-status.json'), statusData);

        const { res, body } = await req('/api/agent/continue', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                selectedTaskIds: ['TK-1'],
                selectedRequestIds: ['R-42-1'],
            }),
        });
        expect(res.status).toBe(200);
        expect(body.selectedTaskIds).toEqual(['TK-1']);
        expect(body.selectedRequestIds).toEqual(['R-42-1']);
    });

    it('dismiss-item removes a completed task from the status file', async () => {
        const statusData = readJson(resolve(TMP, '.frontend-status.json'));
        statusData.tasks = [
            { id: 'TK-1', name: 'Fix button', status: 'completed', hours: 2 },
            { id: 'TK-2', name: 'Fix modal', status: 'in_progress', hours: 1 },
        ];
        writeJson(resolve(TMP, '.frontend-status.json'), statusData);

        const { res, body } = await req('/api/agent/dismiss-item', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend', itemId: 'TK-1', itemType: 'task' }),
        });
        expect(res.status).toBe(200);
        expect(body.dismissed).toBe('TK-1');

        const after = readJson(resolve(TMP, '.frontend-status.json'));
        expect(after.tasks).toHaveLength(1);
        expect(after.tasks[0].id).toBe('TK-2');
    });

    it('dismiss-item removes a resolved request from the status file', async () => {
        const statusData = readJson(resolve(TMP, '.frontend-status.json'));
        statusData.requests = [
            { id: 'R-42-1', type: 'review', source: 'reviewer', summary: 'Extract helper', status: 'resolved', prId: 42, createdAt: new Date().toISOString() },
            { id: 'R-42-2', type: 'review', source: 'reviewer', summary: 'Add null check', status: 'open', prId: 42, createdAt: new Date().toISOString() },
        ];
        writeJson(resolve(TMP, '.frontend-status.json'), statusData);

        const { res, body } = await req('/api/agent/dismiss-item', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend', itemId: 'R-42-1', itemType: 'request' }),
        });
        expect(res.status).toBe(200);
        expect(body.dismissed).toBe('R-42-1');

        const after = readJson(resolve(TMP, '.frontend-status.json'));
        expect(after.requests).toHaveLength(1);
        expect(after.requests[0].id).toBe('R-42-2');
    });

    it('POST /api/agent/step-mode persists stepMode flag from JSON body', async () => {
        let cfg = readJson(resolve(TMP, '.sdlc-framework.config.json'));
        expect(cfg.scheduler.agents.frontend.stepMode).toBe(true);

        const { res, body } = await req('/api/agent/step-mode', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend', stepMode: false }),
        });
        expect(res.status).toBe(200);
        expect(body.stepMode).toBe(false);
        expect(body.agentId).toBe('frontend');

        cfg = readJson(resolve(TMP, '.sdlc-framework.config.json'));
        expect(cfg.scheduler.agents.frontend.stepMode).toBe(false);
    });

    it('POST /api/agent/step-mode accepts enabled alias (dashboard continue-autonomous)', async () => {
        const { res, body } = await req('/api/agent/step-mode', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend', enabled: false }),
        });
        expect(res.status).toBe(200);
        expect(body.stepMode).toBe(false);

        const cfg = readJson(resolve(TMP, '.sdlc-framework.config.json'));
        expect(cfg.scheduler.agents.frontend.stepMode).toBe(false);
    });

    it('POST /api/agent/continue returns phaseHint and uses creating-pr clause in prompt', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent').mockReturnValue({ spawned: false });
        try {
            const statusData = readJson(resolve(TMP, '.frontend-status.json'));
            statusData.currentPhase = 'creating-pr';
            statusData.storyNumber = 'B-17003';
            writeJson(resolve(TMP, '.frontend-status.json'), statusData);

            const { res, body } = await req('/api/agent/continue', {
                method: 'POST',
                body: JSON.stringify({ agentId: 'frontend', phaseHint: 'creating-pr' }),
            });
            expect(res.status).toBe(200);
            expect(body.ok).toBe(true);
            expect(body.phaseHint).toBe('creating-pr');
            expect(body.phase).toBe('creating-pr');

            expect(spy).toHaveBeenCalled();
            const promptArg = spy.mock.calls[0]?.[1] as string;
            expect(promptArg).toContain("currently in phase 'creating-pr'");
            expect(promptArg).toContain('Proceed to create a PR with the completed work.');
        } finally {
            spy.mockRestore();
        }
    });

    it('POST /api/agent/continue maps unknown phaseHint to generic user-direction clause', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent').mockReturnValue({ spawned: false });
        try {
            const statusData = readJson(resolve(TMP, '.frontend-status.json'));
            statusData.currentPhase = 'validating';
            writeJson(resolve(TMP, '.frontend-status.json'), statusData);

            const { res, body } = await req('/api/agent/continue', {
                method: 'POST',
                body: JSON.stringify({ agentId: 'frontend', phaseHint: 'custom-next' }),
            });
            expect(res.status).toBe(200);
            expect(body.phaseHint).toBe('custom-next');

            const promptArg = spy.mock.calls[0]?.[1] as string;
            expect(promptArg).toContain("User direction: proceed with phase hint 'custom-next'.");
        } finally {
            spy.mockRestore();
        }
    });

    it('POST /api/hook/agent-stop returns step-mode pause copy when at a step-mode phase', async () => {
        const statusData = readJson(resolve(TMP, '.frontend-status.json'));
        statusData.currentPhase = 'analyzing';
        statusData.handoffDispatched = false;
        writeJson(resolve(TMP, '.frontend-status.json'), statusData);

        const { res, body } = await req('/api/hook/agent-stop', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend' }),
        });
        expect(res.status).toBe(200);
        expect(body.followup_message).toContain('Step-mode pause');
        expect(body.followup_message).toContain('analyzing');
        expect(body.followup_message).toContain('/api/agent/continue');
    });

    it('POST /api/agent/step-mode returns 409 while global step mode is on', async () => {
        let cfg = readJson(resolve(TMP, '.sdlc-framework.config.json'));
        cfg.scheduler.globalStepMode = true;
        cfg.scheduler.agents.frontend = { enabled: true, autoStart: false, stepMode: false };
        writeJson(resolve(TMP, '.sdlc-framework.config.json'), cfg);

        const { res, body } = await req('/api/agent/step-mode', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend', stepMode: true }),
        });
        expect(res.status).toBe(409);
        expect(typeof body.error).toBe('string');
        expect(body.error).toContain('global step mode');

        cfg = readJson(resolve(TMP, '.sdlc-framework.config.json'));
        expect(cfg.scheduler.agents.frontend.stepMode).toBe(false);
    });

    it('POST /api/agent/continue uses story wrap-up prompt when devops is build-passed', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent').mockReturnValue({ spawned: false });
        try {
            writeJson(resolve(TMP, '.devops-status.json'), {
                storyNumber: 'B-17099',
                storyName: 'Wrap test',
                currentPhase: 'build-passed',
                currentTask: null,
                startedAt: new Date().toISOString(),
                tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
                tasks: [],
                requests: [
                    {
                        id: 'WRAPUP-B-17099-PR-777',
                        type: 'build',
                        source: 'sdlc-framework',
                        summary: 'Run wrap-up',
                        status: 'open',
                        createdAt: 't',
                        prId: 777,
                    },
                ],
                prs: [{ id: 777, title: 'Test PR', status: 'active', comments: 0, approvals: 0 }],
                cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
                events: [],
                assignedPR: { id: 777, title: 'Test PR', storyNumber: 'B-17099' },
            });

            const { res, body } = await req('/api/agent/continue', {
                method: 'POST',
                body: JSON.stringify({ agentId: 'devops' }),
            });
            expect(res.status).toBe(200);
            expect(body.ok).toBe(true);
            expect(spy).toHaveBeenCalled();
            const call = spy.mock.calls[0];
            expect(call[0]).toBe('devops');
            const promptArg = call[1] as string;
            expect(promptArg).toContain('story-wrapup.mdc');
            expect(promptArg).toContain('WRAPUP-B-17099-PR-777');
            expect(call[4]).toEqual({ bypassHandoffDispatched: true });
        } finally {
            spy.mockRestore();
        }
    });

    it('POST /api/agent/continue clears DevOps manual build gate on pending-build pickup', async () => {
        writeJson(resolve(TMP, '.devops-status.json'), {
            currentPhase: 'pending-build',
            manualStartRequired: true,
            assignedPR: { id: 42, storyNumber: 'B-17003', title: 'PR 42' },
            events: [],
        });

        const { res, body } = await req('/api/agent/continue', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'devops', phaseHint: 'monitor-build' }),
        });

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        const devops = readJson(resolve(TMP, '.devops-status.json'));
        expect(devops.manualStartRequired).toBe(false);
        expect(devops.events.some((event: { message?: string }) => String(event.message ?? '').includes('Manual DevOps pickup approved'))).toBe(true);
    });

    it('POST /api/agent/continue resumes a stopped agent mid-phase with correct prompt', async () => {
        const spy = vi.spyOn(spawnAgent, 'spawnAgent').mockReturnValue({ spawned: false });
        try {
            writeJson(resolve(TMP, '.frontend-status.json'), { ...workingStatus });

            const { res, body } = await req('/api/agent/continue', {
                method: 'POST',
                body: JSON.stringify({ agentId: 'frontend' }),
            });
            expect(res.status).toBe(200);
            expect(body.ok).toBe(true);
            expect(body.phase).toBe('generating-code');

            expect(spy).toHaveBeenCalled();
            const promptArg = spy.mock.calls[0]?.[1] as string;
            expect(promptArg).toContain('Continue as frontend');
            expect(promptArg).toContain("currently in phase 'generating-code'");
            expect(promptArg).toContain('story B-99999');
        } finally {
            spy.mockRestore();
        }
    });

    it('POST /api/agent/continue clears handoffDispatched so the agent can be re-spawned', async () => {
        writeJson(resolve(TMP, '.frontend-status.json'), { ...stoppedStatus });

        const { res, body } = await req('/api/agent/continue', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend' }),
        });
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);

        const afterStatus = readJson(resolve(TMP, '.frontend-status.json'));
        expect(afterStatus.handoffDispatched).toBe(true);
    });
});
