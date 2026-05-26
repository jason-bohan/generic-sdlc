import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';
import { setTestRunnerActive } from '../server/spawn-agent';
import { mockV1Post } from '../server/mock-external';

const TMP = resolve(__dirname, '.workflow-routes-tmp');

let server: Server | null = null;
let baseUrl = '';

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
    setTestRunnerActive(true);
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    writeFileSync(resolve(TMP, '.sdlc-framework.config.json'), JSON.stringify({
        externalMode: 'mock',
        activeProject: 'YourProject',
        scheduler: { mode: 'notify', agents: { backend: { enabled: true, autoStart: false } } },
        projects: { YourProject: { workspacePath: TMP, repositoryId: 'mock-repo', azureProject: 'YourProject' } },
    }, null, 2));
    initDb(TMP);
    await startServer();
});

afterEach(async () => {
    await stopServer();
    closeDb();
    setTestRunnerActive(false);
    rmSync(TMP, { recursive: true, force: true });
});

describe('workflow routes', () => {
    it('passes frontend/backend fields through assign route so full-stack classification is correct', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-19001',
                storyName: 'Add pagination to audit table',
                storyDescription: 'Lazy load audit rows',
                frontend: 'PrimeNG lazy-loading table',
                backend: 'page/size params on GET /api/audit-trail',
            }),
        });

        expect(assigned.res.status).toBe(200);
        // Classification should be full-stack even though frontend was the assigned agent
        expect(assigned.body.workflow.item).toMatchObject({
            story_number: 'B-19001',
            active_agent_id: 'frontend',
        });
        const audit = await request(`/api/workflows?id=${assigned.body.workflow.item.id}`);
        const outputs = audit.body.events[0].outputs;
        expect(outputs.classification).toBe('full-stack');
        // frontend should NOT be listed as its own collaborator
        expect(outputs.handoff.collaborators).not.toContain('frontend');
    });

    it('approve route returns spawnReason when agent cannot be spawned', async () => {
        await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-19002',
                storyName: 'Test spawn reason',
                storyDescription: 'Backend story',
            }),
        });

        const approved = await request('/api/scheduler/approve', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'backend', storyNumber: 'B-19002' }),
        });

        expect(approved.res.status).toBe(200);
        expect(approved.body.ok).toBe(true);
        // In test mode spawning is suppressed — spawnReason should be present when agentSpawned is false
        if (!approved.body.agentSpawned) {
            expect(approved.body.spawnReason).toBeTruthy();
        }
    });

    it('inherits existing planning tasks on story assignment and preserves them on approval', async () => {
        mockV1Post(TMP, '/Task', {
            Attributes: {
                Name: { value: 'Existing YourProject task from taskboard' },
                Parent: { value: 'Story:17004' },
                DetailEstimate: { value: 2 },
            },
        });

        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-17004',
                storyName: 'Add bulk action support to content manager',
                storyDescription: 'Mock YourProject story with pre-existing taskboard work',
            }),
        });

        expect(assigned.res.status).toBe(200);
        let status = JSON.parse(readFileSync(resolve(TMP, '.backend-status.json'), 'utf-8'));
        expect(status.tasks).toHaveLength(1);
        expect(status.tasks[0]).toMatchObject({
            name: 'Existing YourProject task from taskboard',
            status: 'pending',
            source: 'agility',
            inherited: true,
        });

        const approved = await request('/api/scheduler/approve', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'backend' }),
        });

        expect(approved.res.status).toBe(200);
        status = JSON.parse(readFileSync(resolve(TMP, '.backend-status.json'), 'utf-8'));
        expect(status.currentPhase).toBe('reading-story');
        expect(status.tasks).toHaveLength(1);
        expect(status.tasks[0].name).toBe('Existing YourProject task from taskboard');
        expect(status.events.some((event: { message: string }) => event.message.includes('Synced 1 existing planning task'))).toBe(true);
    });

    it('mirrors scheduler assignment into SQLite workflow state', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-18001',
                storyName: 'Add audit API',
                storyDescription: 'Backend endpoint for audit history',
            }),
        });

        expect(assigned.res.status).toBe(200);
        expect(assigned.body).toMatchObject({ ok: true, phase: 'pending-approval' });
        expect(assigned.body.workflow.item).toMatchObject({
            story_number: 'B-18001',
            active_agent_id: 'backend',
            active_phase: 'reading-story',
            external_mode: 'mock',
            project_key: 'YourProject',
        });

        const workflows = await request('/api/workflows');
        expect(workflows.res.status).toBe(200);
        expect(workflows.body.workflows).toHaveLength(1);
        expect(workflows.body.workflows[0]).toMatchObject({
            story_number: 'B-18001',
            active_agent_id: 'backend',
        });

        const audit = await request(`/api/workflows?id=${assigned.body.workflow.item.id}`);
        expect(audit.res.status).toBe(200);
        expect(audit.body.events[0]).toMatchObject({
            agent_id: 'orchestrator',
            phase: 'story-intake',
            event_type: 'assigned',
        });
        expect(audit.body.events[0].outputs.auditEvent).toMatchObject({ externalMode: 'mock' });
    });

    it('enforces phase contracts through the workflow completion route', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-18002',
                storyName: 'Add profile API',
                storyDescription: 'Backend endpoint for profile data',
            }),
        });
        const workflowItemId = assigned.body.workflow.item.id;

        const rejected = await request('/api/workflows/complete-phase', {
            method: 'POST',
            body: JSON.stringify({
                workflowItemId,
                agentId: 'backend',
                phase: 'reading-story',
                nextPhase: 'analyzing',
                outputs: {
                    tasks: [{ name: 'Implement endpoint' }],
                    taskIds: ['TK-LOCAL-1'],
                },
            }),
        });
        expect(rejected.res.status).toBe(409);
        expect(rejected.body.missing).toEqual(expect.arrayContaining(['branchPlan', 'testMatrix', 'risks', 'openQuestions', 'auditEvent']));

        const accepted = await request('/api/workflows/complete-phase', {
            method: 'POST',
            body: JSON.stringify({
                workflowItemId,
                agentId: 'backend',
                phase: 'reading-story',
                nextPhase: 'analyzing',
                outputs: {
                    tasks: [{ name: 'Implement endpoint' }],
                    taskIds: ['TK-LOCAL-1'],
                    branchPlan: { branch: 'feat/b-18002-profile-api' },
                    testMatrix: { unit: true, integration: true },
                    risks: [],
                    openQuestions: [],
                    auditEvent: { completedBy: 'backend' },
                },
            }),
        });
        expect(accepted.res.status).toBe(200);
        expect(accepted.body.workflow).toMatchObject({
            active_agent_id: 'backend',
            active_phase: 'analyzing',
        });

        const audit = await request(`/api/workflows?id=${workflowItemId}`);
        expect(audit.body.events.map((e: any) => e.event_type)).toEqual(['assigned', 'phase-completed', 'transitioned']);
        expect(audit.body.artifacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                artifact_type: 'task',
                artifact_key: 'TK-LOCAL-1',
                payload: expect.objectContaining({ name: 'Implement endpoint', sourcePhase: 'reading-story' }),
            }),
        ]));
    });

    it('builds a contract prompt and records phase start through the phase runner route', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-18003',
                storyName: 'Plan task contracts',
                storyDescription: 'Backend story that should start with typed task planning',
            }),
        });
        const workflowItemId = assigned.body.workflow.item.id;

        const phaseRun = await request('/api/workflows/run-phase', {
            method: 'POST',
            body: JSON.stringify({ workflowItemId, spawn: false }),
        });

        expect(phaseRun.res.status).toBe(200);
        expect(phaseRun.body).toMatchObject({
            ok: true,
            agentSpawned: false,
            workflow: {
                story_number: 'B-18003',
                active_agent_id: 'backend',
                active_phase: 'reading-story',
            },
        });
        expect(phaseRun.body.prompt).toContain('Run SDLC phase "reading-story"');
        expect(phaseRun.body.prompt).toContain('You must produce these output keys exactly:');
        expect(phaseRun.body.prompt).toContain('- tasks');
        expect(phaseRun.body.prompt).toContain('- taskIds');
        expect(phaseRun.body.prompt).toContain('/api/scheduler/create-task');
        expect(phaseRun.body.prompt).toContain('/api/workflows/complete-phase');

        const audit = await request(`/api/workflows?id=${workflowItemId}`);
        expect(audit.body.events.map((e: any) => e.event_type)).toEqual(['assigned', 'phase-started']);
        expect(audit.body.events[1].outputs.auditEvent).toMatchObject({ promptContract: true });
    });

    it('records scheduler-created tasks as workflow artifacts', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-17001',
                storyName: 'Add pagination to audit trail table',
                storyDescription: 'Use mock planning story so task creation can resolve the parent',
            }),
        });
        const workflowItemId = assigned.body.workflow.item.id;

        const created = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-17001',
                name: 'Plan API pagination contract',
                estimate: 1,
            }),
        });

        expect(created.res.status).toBe(200);
        expect(created.body.number).toMatch(/^MOCK-TK-/);

        const audit = await request(`/api/workflows?id=${workflowItemId}`);
        expect(audit.body.artifacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                artifact_type: 'task',
                artifact_key: created.body.number,
                payload: expect.objectContaining({
                    name: 'Plan API pagination contract',
                    agentId: 'backend',
                    sourceRoute: '/api/scheduler/create-task',
                }),
            }),
        ]));
    });

    it('assigns two agents to the same story with independent workflow items', async () => {
        const backend = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-20010',
                storyName: 'Multi-agent story',
                storyDescription: 'Both agents work on this',
                frontend: 'UI work',
                backend: 'API work',
            }),
        });
        const frontend = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-20010',
                storyName: 'Multi-agent story',
                storyDescription: 'Both agents work on this',
                frontend: 'UI work',
                backend: 'API work',
            }),
        });

        expect(backend.res.status).toBe(200);
        expect(frontend.res.status).toBe(200);
        expect(backend.body.workflow.item.id).not.toBe(frontend.body.workflow.item.id);
        expect(backend.body.workflow.item.active_agent_id).toBe('backend');
        expect(frontend.body.workflow.item.active_agent_id).toBe('frontend');

        const workflows = await request('/api/workflows');
        const storyWorkflows = workflows.body.workflows.filter((w: any) => w.story_number === 'B-20010');
        expect(storyWorkflows).toHaveLength(2);
    });

    it('writes workflowItemId into the agent status file on assign', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-20011',
                storyName: 'Status file test',
                storyDescription: 'Check workflowItemId in status',
            }),
        });

        expect(assigned.res.status).toBe(200);
        const statusPath = resolve(TMP, '.backend-status.json');
        const status = JSON.parse(require('fs').readFileSync(statusPath, 'utf-8'));
        expect(status.workflowItemId).toBe(assigned.body.workflow.item.id);
    });

    it('returns and records supervisor recommendations', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-18004',
                storyName: 'Coordinate full-stack checkout',
                storyDescription: 'Backend API and frontend checkout UI need coordinated work',
            }),
        });
        const workflowItemId = assigned.body.workflow.item.id;

        const supervised = await request('/api/workflows/supervise', {
            method: 'POST',
            body: JSON.stringify({ workflowItemId }),
        });

        expect(supervised.res.status).toBe(200);
        expect(supervised.body).toMatchObject({
            ok: true,
            workflow: { story_number: 'B-18004' },
        });
        expect(supervised.body.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'run-active-phase',
                agentId: 'backend',
                phase: 'reading-story',
            }),
        ]));

        const audit = await request(`/api/workflows?id=${workflowItemId}`);
        expect(audit.body.events.map((e: any) => e.event_type)).toContain('supervisor-check');
    });
});
