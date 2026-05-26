import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';
import * as spawnAgentMod from '../server/spawn-agent';

const TMP = resolve(__dirname, '.golden-live-sdlc-e2e-tmp');

let server: Server | null = null;
let baseUrl = '';

function writeJson(path: string, value: unknown) {
    writeFileSync(path, JSON.stringify(value, null, 2));
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

async function completePhase(workflowItemId: number, phase: string, nextPhase: string, outputs: Record<string, unknown>) {
    const response = await request('/api/workflows/complete-phase', {
        method: 'POST',
        body: JSON.stringify({ workflowItemId, agentId: 'frontend', phase, nextPhase, outputs }),
    });
    expect(response.res.status).toBe(200);
    return response.body;
}

beforeEach(async () => {
    vi.spyOn(spawnAgentMod, 'spawnAgent').mockReturnValue({ spawned: false });
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    delete process.env.SDLC_EXTERNAL_MODE;
    delete process.env.AZURE_DEVOPS_PAT;
    delete process.env.AZURE_DEVOPS_EXT_PAT;
    delete process.env.VSS_PAT;

    writeJson(resolve(TMP, '.sdlc-framework.config.json'), {
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

    initDb(TMP);
    await startServer();
});

afterEach(async () => {
    await stopServer();
    closeDb();
    vi.restoreAllMocks();
    delete process.env.SDLC_EXTERNAL_MODE;
    rmSync(TMP, { recursive: true, force: true });
});

describe('golden live SDLC E2E', () => {
    it('drives assignment, typed phases, PR, review, build, and completion in live mode', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'STORY-101',
                storyName: 'Live checkout copy update',
                storyDescription: 'Update checkout copy and validate the handoff trail.',
            }),
        });
        expect(assigned.res.status).toBe(200);
        const workflowItemId = assigned.body.workflow.item.id;

        await completePhase(workflowItemId, 'reading-story', 'analyzing', {
            tasks: [{ id: 'TK-1', name: 'Update checkout copy' }],
            taskIds: ['TK-1'],
            branchPlan: { branch: 'feat/story-101-checkout-copy', base: 'main' },
            testMatrix: { unit: ['copy renderer'], e2e: ['checkout happy path'] },
            risks: [],
            openQuestions: [],
            auditEvent: { phase: 'reading-story' },
        });

        await completePhase(workflowItemId, 'analyzing', 'generating-code', {
            codeChanges: { files: ['src/checkout/CheckoutCopy.tsx'], summary: 'Change checkout text' },
            risks: [],
            auditEvent: { phase: 'analyzing' },
        });

        await completePhase(workflowItemId, 'generating-code', 'validating', {
            codeChanges: { files: ['src/checkout/CheckoutCopy.tsx'], commits: [] },
            testResults: { unit: 'passed' },
            auditEvent: { phase: 'generating-code' },
        });

        await completePhase(workflowItemId, 'validating', 'creating-pr', {
            validationResults: { lint: 'passed', tests: 'passed' },
            staticAnalysis: { issues: [] },
            testResults: { unit: 'passed' },
            risks: [],
            auditEvent: { phase: 'validating' },
        });

        const prResult = await request('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 9101,
                prTitle: 'Live checkout copy update',
                prUrl: 'https://git.example.com/pr/9101',
                storyNumber: 'STORY-101',
                branch: 'feat/story-101-checkout-copy',
                projectKey: 'DemoProject',
            }),
        });
        expect(prResult.res.status).toBe(200);
        expect(prResult.body).toMatchObject({
            ok: true,
            stepMode: true,
            reviewerPhase: 'pending-review',
            globalStepMode: false,
            reviewerAutoSpawnSkippedDueToGlobalStep: false,
        });

        const review = await request('/api/handoff/review-complete', {
            method: 'POST',
            body: JSON.stringify({
                prId: 9101,
                verdict: 'approved',
                storyNumber: 'STORY-101',
                branch: 'feat/story-101-checkout-copy',
                projectKey: 'DemoProject',
            }),
        });
        expect(review.res.status).toBe(200);
        expect(review.body).toMatchObject({ ok: true, target: 'devops', targetPhase: 'pending-build' });

        const build = await request('/api/handoff/build-complete', {
            method: 'POST',
            body: JSON.stringify({ prId: 9101, result: 'passed', buildId: 6101 }),
        });
        expect(build.res.status).toBe(200);
        expect(build.body).toMatchObject({ ok: true, storyOwner: 'frontend', newPrStatus: 'completed' });

        const audit = await request(`/api/workflows?id=${workflowItemId}`);
        expect(audit.res.status).toBe(200);
        const eventTypes = audit.body.events.map((e: any) => e.event_type);
        expect(eventTypes).toEqual(expect.arrayContaining([
            'assigned',
            'phase-completed',
            'pr-created',
            'review-complete',
            'build-complete',
            'transitioned',
        ]));

        const finalWorkflow = audit.body.workflow;
        expect(finalWorkflow).toMatchObject({
            story_number: 'STORY-101',
            active_agent_id: 'frontend',
            active_phase: 'complete',
            status: 'complete',
            external_mode: 'live',
        });
        const prEvent = audit.body.events.find((e: any) => e.event_type === 'pr-created');
        expect(prEvent.outputs.pr).toMatchObject({ id: 9101 });
        expect(prEvent.outputs.pr.url).toBeTruthy();
    });
});
