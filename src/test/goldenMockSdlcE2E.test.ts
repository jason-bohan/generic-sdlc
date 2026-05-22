import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';
import * as spawnAgentMod from '../server/spawn-agent';

const TMP = resolve(__dirname, '.golden-mock-sdlc-e2e-tmp');

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
        body: JSON.stringify({
            workflowItemId,
            agentId: 'frontend',
            phase,
            nextPhase,
            outputs,
        }),
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

describe('golden mock SDLC E2E', () => {
    it('drives assignment, typed phases, mock PR, review, build, and completion without live services', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-19001',
                storyName: 'Mock YourProject checkout copy',
                storyDescription: 'Update checkout copy in YourProject and validate the handoff trail.',
            }),
        });
        expect(assigned.res.status).toBe(200);
        const workflowItemId = assigned.body.workflow.item.id;

        await completePhase(workflowItemId, 'reading-story', 'analyzing', {
            tasks: [{ id: 'TK-LOCAL-1', name: 'Update checkout copy' }],
            taskIds: ['TK-LOCAL-1'],
            branchPlan: { branch: 'codex/b-19001-checkout-copy', base: 'master' },
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
            testResults: { unit: 'not-run-in-mock' },
            auditEvent: { phase: 'generating-code' },
        });

        await completePhase(workflowItemId, 'validating', 'creating-pr', {
            validationResults: { lint: 'passed', tests: 'mocked' },
            staticAnalysis: { issues: [] },
            testResults: { unit: 'passed' },
            risks: [],
            auditEvent: { phase: 'validating' },
        });

        const mockPr = await request('/api/pr/created', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                prId: 9101,
                prTitle: 'Mock YourProject checkout copy',
                prUrl: 'mock://ado/pr/9101',
                storyNumber: 'B-19001',
                branch: 'codex/b-19001-checkout-copy',
                projectKey: 'YourProject',
            }),
        });
        expect(mockPr.res.status).toBe(200);
        expect(mockPr.body).toMatchObject({
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
                storyNumber: 'B-19001',
                branch: 'codex/b-19001-checkout-copy',
                projectKey: 'YourProject',
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
            story_number: 'B-19001',
            active_agent_id: 'frontend',
            active_phase: 'complete',
            status: 'complete',
            external_mode: 'mock',
        });
        expect(audit.body.events.find((e: any) => e.event_type === 'pr-created').outputs.mockPr).toMatchObject({
            id: 9101,
            url: 'mock://ado/pr/9101',
        });
    });
});
