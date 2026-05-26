import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import * as spawnAgentMod from '../server/spawn-agent';

const TMP = resolve(__dirname, '.live-server-e2e-tmp');
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
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
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
        externalMode: 'live',
        activeProject: 'DemoProject',
        project: { prUrlBase: 'https://git.example.com/pr' },
        projects: {
            DemoProject: {
                organization: 'demo-org',
                azureProject: 'DemoProject',
                repositoryId: 'demo-repo',
                targetBranch: 'main',
                pipelineId: 1,
                reviewerIds: ['reviewer-1'],
                prUrlBase: 'https://git.example.com/pr',
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
        projectKey: 'DemoProject',
        storyNumber: 'STORY-100',
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

describe('live server E2E', () => {
    it('reports live external mode and accepts PRs', async () => {
        const mode = await request('/api/external-mode');
        expect(mode.res.status).toBe(200);
        expect(mode.body).toMatchObject({ mode: 'live', liveAdoCredentialsPresent: false });

        const pr = await request('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 9001,
                prTitle: 'Live SDLC PR',
                prUrl: 'https://git.example.com/pr/9001',
                storyNumber: 'STORY-100',
                branch: 'feat/story-100',
                projectKey: 'DemoProject',
            }),
        });
        expect(pr.res.status).toBe(200);
        expect(pr.body).toMatchObject({
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

        const afterPr = readJson(FRONTEND_STATUS);
        expect(afterPr.prs).toHaveLength(1);
        expect(afterPr.prs[0]).toMatchObject({ id: 9001, status: 'active', projectKey: 'DemoProject' });
        expect(afterPr.prs[0].url).toBeTruthy();
    });

    it('pr/created assigns reviewer desk under global step mode but skips auto-spawn', async () => {
        const cfg = readJson(CONFIG);
        cfg.scheduler.globalStepMode = true;
        writeJson(CONFIG, cfg);

        const pr = await request('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 9002,
                prTitle: 'Live PR global step',
                prUrl: 'https://git.example.com/pr/9002',
                storyNumber: 'STORY-100',
                branch: 'feat/story-100-global-step',
                projectKey: 'DemoProject',
            }),
        });
        expect(pr.res.status).toBe(200);
        expect(pr.body).toMatchObject({
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

    it('pr/created hybrid: frontend step mode on, reviewer/devops off — desk assigned for manual pickup', async () => {
        const cfg = readJson(CONFIG);
        cfg.scheduler.globalStepMode = false;
        cfg.scheduler.agents.frontend = { enabled: true, autoStart: false, stepMode: true };
        cfg.scheduler.agents.reviewer = { enabled: true, autoStart: false, stepMode: false };
        cfg.scheduler.agents.devops = { enabled: true, autoStart: false, stepMode: false };
        writeJson(CONFIG, cfg);

        const pr = await request('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 9003,
                prTitle: 'Live hybrid step PR',
                prUrl: 'https://git.example.com/pr/9003',
                storyNumber: 'STORY-100',
                branch: 'feat/story-100-hybrid',
                projectKey: 'DemoProject',
            }),
        });
        expect(pr.res.status).toBe(200);
        expect(pr.body).toMatchObject({
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
