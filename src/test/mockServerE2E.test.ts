import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import * as spawnAgentMod from '../server/spawn-agent';

const TMP = resolve(__dirname, '.mock-server-e2e-tmp');
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');
const FRONTEND_STATUS = resolve(TMP, '.frontend-status.json');

let server: Server | null = null;
let baseUrl = '';

function writeJson(path: string, value: unknown) {
    writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path: string) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

async function startServer() {
    server = http.createServer(createApp(TMP));
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((resolveClose, reject) => {
        server!.close((err) => err ? reject(err) : resolveClose());
    });
    server = null;
    baseUrl = '';
}

async function request(path: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
        },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    return { res, body };
}

beforeEach(async () => {
    vi.spyOn(spawnAgentMod, 'spawnAgent').mockReturnValue({ spawned: false });
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    delete process.env.SDLC_EXTERNAL_MODE;
    delete process.env.AZURE_DEVOPS_PAT;
    delete process.env.AZURE_DEVOPS_EXT_PAT;
    delete process.env.VSS_PAT;

    writeJson(CONFIG, {
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
                reviewer: { enabled: true, autoStart: false, stepMode: true },
                devops: { enabled: true, autoStart: false, stepMode: true },
            },
        },
    });

    writeJson(FRONTEND_STATUS, {
        agentId: 'frontend',
        projectKey: 'YourProject',
        storyNumber: 'B-17001',
        currentPhase: 'creating-pr',
        prs: [],
        events: [],
    });

    await startServer();
});

afterEach(async () => {
    await stopServer();
    vi.restoreAllMocks();
    delete process.env.SDLC_EXTERNAL_MODE;
    rmSync(TMP, { recursive: true, force: true });
});

describe('mock server E2E', () => {
    it('serves mock Agility and refuses live Azure PR registration in mock mode', async () => {
        const mode = await request('/api/external-mode');
        expect(mode.res.status).toBe(200);
        expect(mode.body).toMatchObject({ mode: 'mock', liveAdoCredentialsPresent: false });

        const story = await request('/mock-v1/rest-1.v1/Data/Story?where=Number%3D%27B-17001%27&sel=Name,Number');
        expect(story.res.status).toBe(200);
        expect(story.body.Assets[0].Attributes.Number.value).toBe('B-17001');
        const parent = story.body.Assets[0].id;

        const task = await request('/mock-v1/rest-1.v1/Data/Task', {
            method: 'POST',
            body: JSON.stringify({
                Attributes: {
                    Name: { value: 'E2E mock planning task' },
                    Parent: { value: parent },
                    DetailEstimate: { value: 1 },
                    ToDo: { value: 1 },
                },
            }),
        });
        expect(task.res.status).toBe(200);
        expect(task.body.Attributes.Number.value).toMatch(/^TK-LOCAL-/);
        expect(existsSync(resolve(TMP, '.sdlc-framework', 'mock', 'state.json'))).toBe(true);

        const mockPr = await request('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 9001,
                prTitle: 'Mock YourProject SDLC PR',
                prUrl: 'mock://ado/pr/9001',
                storyNumber: 'B-17001',
                branch: 'codex/mock-YourProject-work',
                projectKey: 'YourProject',
            }),
        });
        expect(mockPr.res.status).toBe(200);
        expect(mockPr.body).toMatchObject({
            ok: true,
            reviewerPhase: 'pending-review',
            stepMode: true,
            globalStepMode: false,
            reviewerAutoSpawnSkippedDueToGlobalStep: false,
        });

        expect(existsSync(resolve(TMP, '.reviewer-status.json'))).toBe(true);
        const reviewerAfterPr = readJson(resolve(TMP, '.reviewer-status.json'));
        expect(reviewerAfterPr.currentPhase).toBe('pending-review');
        expect(reviewerAfterPr.assignedPR?.id).toBe(9001);

        const afterMockPr = readJson(FRONTEND_STATUS);
        expect(afterMockPr.prs).toHaveLength(1);
        expect(afterMockPr.prs[0]).toMatchObject({
            id: 9001,
            status: 'active',
            url: 'mock://ado/pr/9001',
            projectKey: 'YourProject',
        });

        const livePr = await request('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 123,
                prTitle: 'Live Azure PR should not be accepted',
                prUrl: 'https://oursundayvisitor.visualstudio.com/YourProject/_git/YourProject/pullrequest/123',
                storyNumber: 'B-17001',
                branch: 'codex/escaped-live-work',
                projectKey: 'YourProject',
            }),
        });
        expect(livePr.res.status).toBe(409);
        expect(livePr.body).toMatchObject({ mode: 'mock' });
        expect(livePr.body.error).toContain('Mock mode refuses to register a live Azure DevOps PR');

        const afterLivePrAttempt = readJson(FRONTEND_STATUS);
        expect(afterLivePrAttempt.prs).toHaveLength(1);
        expect(afterLivePrAttempt.prs.some((pr: any) => pr.id === 123)).toBe(false);
    });

    it('pr/created assigns reviewer desk under global step mode but skips Brehon auto-spawn', async () => {
        const cfg = readJson(CONFIG);
        cfg.scheduler.globalStepMode = true;
        writeJson(CONFIG, cfg);

        const mockPr = await request('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 9002,
                prTitle: 'Mock PR global step',
                prUrl: 'mock://ado/pr/9002',
                storyNumber: 'B-17001',
                branch: 'codex/global-step-pr',
                projectKey: 'YourProject',
            }),
        });
        expect(mockPr.res.status).toBe(200);
        expect(mockPr.body).toMatchObject({
            ok: true,
            reviewerPhase: 'pending-review',
            globalStepMode: true,
            reviewerAutoSpawnSkippedDueToGlobalStep: true,
            agentSpawned: false,
        });
        expect(existsSync(resolve(TMP, '.reviewer-status.json'))).toBe(true);
        const reviewerSt = readJson(resolve(TMP, '.reviewer-status.json'));
        expect(reviewerSt.assignedPR?.id).toBe(9002);
    });

    it('pr/created hybrid: frontend step mode on, reviewer/devops off — desk assigned for manual reviewer pickup', async () => {
        const cfg = readJson(CONFIG);
        cfg.scheduler.globalStepMode = false;
        cfg.scheduler.agents.frontend = { enabled: true, autoStart: false, stepMode: true };
        cfg.scheduler.agents.reviewer = { enabled: true, autoStart: false, stepMode: false };
        cfg.scheduler.agents.devops = { enabled: true, autoStart: false, stepMode: false };
        writeJson(CONFIG, cfg);

        const mockPr = await request('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 9003,
                prTitle: 'Mock hybrid step PR',
                prUrl: 'mock://ado/pr/9003',
                storyNumber: 'B-17001',
                branch: 'codex/hybrid-step-pr',
                projectKey: 'YourProject',
            }),
        });
        expect(mockPr.res.status).toBe(200);
        expect(mockPr.body).toMatchObject({
            ok: true,
            reviewerPhase: 'pending-review',
            stepMode: true,
            globalStepMode: false,
            reviewerAutoSpawnSkippedDueToGlobalStep: false,
            reviewerAutoSpawnSkippedReason: 'creator-step-mode',
            agentSpawned: false,
        });

        const reviewerSt = readJson(resolve(TMP, '.reviewer-status.json'));
        expect(reviewerSt.assignedPR?.id).toBe(9003);
        expect(reviewerSt.currentPhase).toBe('pending-review');
        expect(reviewerSt.handoffDispatched).toBe(false);

        const reviewerSpawnCalls = vi.mocked(spawnAgentMod.spawnAgent).mock.calls.filter((call) => call[0] === 'reviewer');
        expect(reviewerSpawnCalls).toHaveLength(0);
    });
});
