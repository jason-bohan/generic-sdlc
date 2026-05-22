/**
 * Integration test: Lasair + Brehon in step mode; QA + DevOps not in step mode.
 * Flow: workflow phase 1 chain → mock PR → reviewer requests changes (comments to Las) →
 * Las does not auto-spawn (step mode) → Las "picks up" (simulated phase bump) →
 * reviewer approves → DevOps is assigned for manual pickup. QA never spawns in this path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';
import * as spawnAgentMod from '../server/spawn-agent';

const TMP = resolve(__dirname, '.review-feedback-hybrid-step-modes-tmp');
const STORY = 'B-19202';
const PR_ID = 9202;
const BRANCH = 'codex/b-19202-hybrid-review';

let server: Server | null = null;
let baseUrl = '';
const spawnCalls: string[] = [];

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
        server!.close((err) => (err ? reject(err) : resolveClose()));
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
    spawnCalls.length = 0;
    vi.spyOn(spawnAgentMod, 'spawnAgent').mockImplementation((agentId: string) => {
        spawnCalls.push(agentId);
        return { spawned: false };
    });
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
            globalStepMode: false,
            agents: {
                frontend: { enabled: true, autoStart: false, stepMode: true },
                reviewer: { enabled: true, autoStart: false, stepMode: true },
                qa: { enabled: true, autoStart: false, stepMode: false },
                devops: { enabled: true, autoStart: false, stepMode: false },
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

describe('review feedback hybrid step modes', () => {
    it('Las + Brehon step mode: changes-requested does not auto-spawn Las; approval assigns DevOps without auto-starting build; QA never spawns', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: STORY,
                storyName: 'Hybrid step-mode review loop',
                storyDescription: 'Las step mode through phase 1; Brehon requests changes; Las picks up; Brehon approves; DevOps not in step mode.',
            }),
        });
        expect(assigned.res.status).toBe(200);
        const workflowItemId = assigned.body.workflow.item.id;

        await completePhase(workflowItemId, 'reading-story', 'analyzing', {
            tasks: [{ id: 'TK-LOCAL-1', name: 'Implement widget' }],
            taskIds: ['TK-LOCAL-1'],
            branchPlan: { branch: BRANCH, base: 'master' },
            testMatrix: { unit: ['widget'], e2e: ['smoke'] },
            risks: [],
            openQuestions: [],
            auditEvent: { phase: 'reading-story' },
        });

        await completePhase(workflowItemId, 'analyzing', 'generating-code', {
            codeChanges: { files: ['src/widget.tsx'], summary: 'Add widget' },
            risks: [],
            auditEvent: { phase: 'analyzing' },
        });

        await completePhase(workflowItemId, 'generating-code', 'validating', {
            codeChanges: { files: ['src/widget.tsx'], commits: [] },
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
                prId: PR_ID,
                prTitle: 'Hybrid step-mode PR',
                prUrl: `mock://ado/pr/${PR_ID}`,
                storyNumber: STORY,
                branch: BRANCH,
                projectKey: 'YourProject',
            }),
        });
        expect(mockPr.res.status).toBe(200);
        expect(mockPr.body.reviewerPhase).toBe('pending-review');
        // Reviewer step mode: desk is assigned but Brehon CLI is not auto-started (same as /api/reviewer/spawn-from-desk guard).
        expect(mockPr.body.agentSpawned).toBe(false);
        expect(spawnCalls.some((id) => id === 'reviewer')).toBe(false);

        const nAfterPr = spawnCalls.length;

        const round1 = await request('/api/handoff/review-complete', {
            method: 'POST',
            body: JSON.stringify({
                prId: PR_ID,
                verdict: 'changes-requested',
                storyNumber: STORY,
                branch: BRANCH,
                projectKey: 'YourProject',
                commentCount: 1,
                comments: [{ summary: 'Add null check in widget handler', file: 'src/widget.tsx', line: 14 }],
            }),
        });
        expect(round1.res.status).toBe(200);
        expect(round1.body).toMatchObject({ ok: true, target: 'frontend', targetPhase: 'addressing-feedback' });

        const lasRoundTrip = spawnCalls.slice(nAfterPr);
        expect(lasRoundTrip.some((id) => id === 'frontend')).toBe(false);

        const frontendPath = resolve(TMP, '.frontend-status.json');
        const lasAfterRound1 = JSON.parse(readFileSync(frontendPath, 'utf-8'));
        expect(lasAfterRound1.currentPhase).toBe('addressing-feedback');
        expect(Array.isArray(lasAfterRound1.requests)).toBe(true);
        expect(lasAfterRound1.requests.length).toBe(1);
        expect(lasAfterRound1.requests[0].summary).toContain('null check');

        const nAfterRound1 = spawnCalls.length;

        const lasSimulated = JSON.parse(readFileSync(frontendPath, 'utf-8'));
        lasSimulated.currentPhase = 'watching-reviews';
        lasSimulated.requests = lasSimulated.requests.map((r: { status: string }) => ({ ...r, status: 'resolved' }));
        lasSimulated.events = Array.isArray(lasSimulated.events) ? lasSimulated.events : [];
        lasSimulated.events.push({
            timestamp: new Date().toISOString(),
            type: 'success',
            message: 'Simulated: Las addressed feedback and pushed; awaiting re-review.',
        });
        writeJson(frontendPath, lasSimulated);

        const round2 = await request('/api/handoff/review-complete', {
            method: 'POST',
            body: JSON.stringify({
                prId: PR_ID,
                verdict: 'approved',
                storyNumber: STORY,
                branch: BRANCH,
                projectKey: 'YourProject',
            }),
        });
        expect(round2.res.status).toBe(200);
        expect(round2.body).toMatchObject({ ok: true, target: 'devops', targetPhase: 'pending-build' });

        const approveSpawns = spawnCalls.slice(nAfterRound1);
        expect(approveSpawns).not.toContain('devops');
        expect(spawnCalls.some((id) => id === 'qa')).toBe(false);

        const devopsPath = resolve(TMP, '.devops-status.json');
        const devopsSt = JSON.parse(readFileSync(devopsPath, 'utf-8'));
        expect(devopsSt.currentPhase).toBe('pending-build');
        expect(devopsSt.manualStartRequired).toBe(true);
        expect(devopsSt.assignedPR?.id).toBe(PR_ID);
    });
});
