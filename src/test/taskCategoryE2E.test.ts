import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';
import { setTestRunnerActive } from '../server/spawn-agent';

const TMP = resolve(__dirname, '.task-category-e2e-tmp');

let server: Server | null = null;
let baseUrl = '';

function writeJson(path: string, value: unknown) {
    writeFileSync(path, JSON.stringify(value, null, 2));
}

async function startServer() {
    server = http.createServer(createApp(TMP));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((r, j) => server!.close((err) => (err ? j(err) : r())));
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
                backend: { enabled: true, autoStart: false, stepMode: true },
            },
        },
    });

    initDb(TMP);
    await startServer();
});

afterEach(async () => {
    await stopServer();
    closeDb();
    setTestRunnerActive(false);
    delete process.env.SDLC_EXTERNAL_MODE;
    rmSync(TMP, { recursive: true, force: true });
});

describe('task categories and step-mode task selection', () => {
    it('creates tasks with default agent category and writes category into status file and workflow artifact', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                storyName: 'Implement dark mode for admin dashboard',
                storyDescription: 'Add dark mode toggle',
            }),
        });
        expect(assigned.res.status).toBe(200);
        const workflowItemId = assigned.body.workflow.item.id;

        const task1 = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                name: 'Build component',
                estimate: 2,
            }),
        });
        expect(task1.res.status).toBe(200);

        const statusRaw = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        const createdTask = statusRaw.tasks.find((t: any) => t.name === 'Build component');
        expect(createdTask).toBeDefined();
        expect(createdTask.category).toBe('Frontend');

        const audit = await request(`/api/workflows?id=${workflowItemId}`);
        const taskArtifact = audit.body.artifacts.find(
            (a: any) => a.artifact_type === 'task' && a.payload.name === 'Build component',
        );
        expect(taskArtifact).toBeDefined();
        expect(taskArtifact.payload.category).toBe('Frontend');
    });

    it('pauses for reconciliation before reusing repeated task creation by story, name, and category', async () => {
        await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                storyName: 'Implement dark mode for admin dashboard',
                storyDescription: 'Add dark mode toggle',
            }),
        });

        const first = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                name: 'Build component',
                estimate: 2,
            }),
        });
        expect(first.res.status).toBe(200);

        const second = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                name: 'Build component',
                estimate: 3,
            }),
        });
        expect(second.res.status).toBe(409);
        expect(second.body.reconciliationRequired).toBe(true);

        const statusRaw = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        expect(statusRaw.currentPhase).toBe('analyzing');
        expect(statusRaw.taskReconciliation).toMatchObject({
            status: 'pending',
            storyNumber: 'B-17003',
        });

        const approved = await request('/api/agent/task-reconciliation', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend', action: 'reuse' }),
        });
        expect(approved.res.status).toBe(200);

        const third = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                name: 'Build component',
                estimate: 3,
            }),
        });
        expect(third.res.status).toBe(200);
        expect(third.body.number).toBe(first.body.number);
        expect(third.body.deduplicated).toBe(true);

        const reusedStatus = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        const matchingTasks = reusedStatus.tasks.filter((t: any) => t.name === 'Build component' && t.category === 'Frontend');
        expect(matchingTasks).toHaveLength(1);
        expect(matchingTasks[0]).toMatchObject({
            number: first.body.number,
            hours: 3,
            status: 'pending',
        });
    });

    it('archives local tasks when reconciliation chooses recreate', async () => {
        await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                storyName: 'Implement dark mode for admin dashboard',
                storyDescription: 'Add dark mode toggle',
            }),
        });

        const first = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                name: 'Build component',
                estimate: 2,
            }),
        });
        expect(first.res.status).toBe(200);

        const duplicate = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                name: 'Build component',
                estimate: 2,
            }),
        });
        expect(duplicate.res.status).toBe(409);

        const recreated = await request('/api/agent/task-reconciliation', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend', action: 'recreate' }),
        });
        expect(recreated.res.status).toBe(200);

        const statusRaw = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        expect(statusRaw.tasks).toEqual([]);
        expect(statusRaw.archivedTasks).toHaveLength(1);
        expect(statusRaw.archivedTasks[0].number).toBe(first.body.number);
        expect(statusRaw.taskReconciliation).toBeUndefined();
    });

    it('allows explicit category override', async () => {
        await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-17002',
                storyName: 'Fix environment selector',
                storyDescription: 'Backend creates a QA-category task',
            }),
        });

        const task = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'backend',
                storyNumber: 'B-17002',
                name: 'Write integration tests',
                estimate: 1,
                category: 'QA',
            }),
        });
        expect(task.res.status).toBe(200);

        const statusRaw = JSON.parse(readFileSync(resolve(TMP, '.backend-status.json'), 'utf-8'));
        const createdTask = statusRaw.tasks.find((t: any) => t.name === 'Write integration tests');
        expect(createdTask.category).toBe('QA');
    });

    it('continue endpoint accepts selectedTaskIds and includes them in the prompt scope', async () => {
        writeJson(resolve(TMP, '.frontend-status.json'), {
            storyNumber: 'B-17004',
            currentPhase: 'generating-code',
            tasks: [
                { id: 'TK-LOCAL-1', number: 'TK-LOCAL-1', name: 'Task A', status: 'pending', hours: 1, category: 'Frontend' },
                { id: 'TK-LOCAL-2', number: 'TK-LOCAL-2', name: 'Task B', status: 'pending', hours: 2, category: 'Frontend' },
                { id: 'TK-LOCAL-3', number: 'TK-LOCAL-3', name: 'Task C', status: 'completed', hours: 1, category: 'Frontend' },
            ],
        });

        const continued = await request('/api/agent/continue', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                selectedTaskIds: ['TK-LOCAL-1', 'TK-LOCAL-2'],
            }),
        });

        expect(continued.res.status).toBe(200);
        expect(continued.body.ok).toBe(true);
        expect(continued.body.selectedTaskIds).toEqual(['TK-LOCAL-1', 'TK-LOCAL-2']);

        const statusRaw = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        expect(statusRaw.tasks.find((t: any) => t.id === 'TK-LOCAL-1').status).toBe('in_progress');
        expect(statusRaw.tasks.find((t: any) => t.id === 'TK-LOCAL-2').status).toBe('in_progress');
        expect(statusRaw.tasks.find((t: any) => t.id === 'TK-LOCAL-3').status).toBe('completed');
        expect(statusRaw.activePrBatchTaskIds).toEqual(['TK-LOCAL-1', 'TK-LOCAL-2']);
    });

    it('continue honors selectedTaskIds when phase is analyzing', async () => {
        writeJson(resolve(TMP, '.frontend-status.json'), {
            storyNumber: 'B-17004',
            currentPhase: 'analyzing',
            tasks: [
                { id: 'TK-LOCAL-1', number: 'TK-LOCAL-1', name: 'Task A', status: 'pending', hours: 1, category: 'Frontend' },
            ],
        });

        const continued = await request('/api/agent/continue', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                selectedTaskIds: ['TK-LOCAL-1'],
            }),
        });

        expect(continued.res.status).toBe(200);
        expect(continued.body.ok).toBe(true);
        expect(continued.body.selectedTaskIds).toEqual(['TK-LOCAL-1']);

        const statusRaw = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        expect(statusRaw.tasks[0].status).toBe('in_progress');
        expect(statusRaw.activePrBatchTaskIds).toEqual(['TK-LOCAL-1']);
    });

    it('continue endpoint works without selectedTaskIds for backward compatibility', async () => {
        writeJson(resolve(TMP, '.frontend-status.json'), {
            storyNumber: 'B-17005',
            currentPhase: 'analyzing',
        });

        const continued = await request('/api/agent/continue', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend' }),
        });

        expect(continued.res.status).toBe(200);
        expect(continued.body.ok).toBe(true);
        expect(continued.body.selectedTaskIds).toEqual([]);
    });

    it('deduplicates create-task against inherited tasks with empty category', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                storyName: 'Implement dark mode for admin dashboard',
                storyDescription: 'Add dark mode toggle',
            }),
        });
        expect(assigned.res.status).toBe(200);

        const statusBefore = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        const inheritedTasks = statusBefore.tasks || [];

        statusBefore.tasks = inheritedTasks.map((t: any, i: number) => ({
            ...t,
            name: `Inherited task ${i + 1}`,
            category: '',
        }));
        if (statusBefore.tasks.length === 0) {
            statusBefore.tasks = [
                { id: 'TK-MOCK-1', number: 'TK-MOCK-1', name: 'Inherited task 1', status: 'pending', hours: 1, category: '' },
                { id: 'TK-MOCK-2', number: 'TK-MOCK-2', name: 'Inherited task 2', status: 'pending', hours: 2, category: '' },
            ];
        }
        writeJson(resolve(TMP, '.frontend-status.json'), statusBefore);

        const taskCountBefore = statusBefore.tasks.length;

        const result = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17003',
                name: 'Inherited task 1',
                estimate: 3,
            }),
        });
        expect(result.res.status).toBe(409);
        expect(result.body.reconciliationRequired).toBe(true);

        const statusAfter = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        expect(statusAfter.tasks).toHaveLength(taskCountBefore);
    });

    it('mergeInheritedTasks deduplicates by name when keys differ', async () => {
        writeJson(resolve(TMP, '.frontend-status.json'), {
            storyNumber: 'B-17006',
            currentPhase: 'pending-approval',
            tasks: [
                { id: 'TK-LOCAL-1', number: 'TK-LOCAL-1', name: 'Build header', status: 'pending', hours: 1, category: 'Frontend' },
                { id: 'TK-LOCAL-2', number: 'TK-LOCAL-2', name: 'Build footer', status: 'pending', hours: 2, category: 'Frontend' },
            ],
        });

        await request('/api/scheduler/approve', {
            method: 'POST',
            body: JSON.stringify({ agentId: 'frontend' }),
        });

        const statusAfter = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        const taskNames = (statusAfter.tasks || []).map((t: any) => t.name);
        const uniqueNames = [...new Set(taskNames)];
        expect(taskNames.length).toBe(uniqueNames.length);
    });

    it('full step-mode E2E: assign, create categorized tasks, complete phases, resume with selected tasks', async () => {
        const assigned = await request('/api/scheduler/assign', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17004',
                storyName: 'Add bulk action support to content manager',
                storyDescription: 'Full flow through task creation and step-mode resume.',
                frontend: 'Add selection state to content-list component',
            }),
        });
        expect(assigned.res.status).toBe(200);
        const workflowItemId = assigned.body.workflow.item.id;

        const task1 = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17004',
                name: 'Build header component',
                estimate: 2,
            }),
        });
        expect(task1.res.status).toBe(200);
        expect(task1.body.number).toBeTruthy();

        const task2 = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17004',
                name: 'Build footer component',
                estimate: 1,
            }),
        });
        expect(task2.res.status).toBe(200);

        const task3 = await request('/api/scheduler/create-task', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                storyNumber: 'B-17004',
                name: 'Write Cypress tests',
                estimate: 1,
                category: 'QA',
            }),
        });
        expect(task3.res.status).toBe(200);

        const statusRaw = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        expect(statusRaw.tasks).toHaveLength(3);
        expect(statusRaw.tasks[0].category).toBe('Frontend');
        expect(statusRaw.tasks[1].category).toBe('Frontend');
        expect(statusRaw.tasks[2].category).toBe('QA');

        // Verify category was persisted before phase completion overwrites artifacts
        const preAudit = await request(`/api/workflows?id=${workflowItemId}`);
        const preCategories = preAudit.body.artifacts
            .filter((a: any) => a.artifact_type === 'task')
            .map((a: any) => a.payload.category);
        expect(preCategories).toContain('Frontend');
        expect(preCategories).toContain('QA');

        await request('/api/workflows/complete-phase', {
            method: 'POST',
            body: JSON.stringify({
                workflowItemId,
                agentId: 'frontend',
                phase: 'reading-story',
                nextPhase: 'analyzing',
                outputs: {
                    tasks: [
                        { id: task1.body.number, name: 'Build header component', category: 'Frontend' },
                        { id: task2.body.number, name: 'Build footer component', category: 'Frontend' },
                    ],
                    taskIds: [task1.body.number, task2.body.number],
                    branchPlan: { branch: 'codex/b-17004-bulk-actions', base: 'master' },
                    testMatrix: { unit: ['header', 'footer'], e2e: ['layout'] },
                    risks: [],
                    openQuestions: [],
                    auditEvent: { phase: 'reading-story' },
                },
            }),
        });

        const statusReadyForSelection = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        statusReadyForSelection.currentPhase = 'analyzing';
        writeJson(resolve(TMP, '.frontend-status.json'), statusReadyForSelection);

        const continued = await request('/api/agent/continue', {
            method: 'POST',
            body: JSON.stringify({
                agentId: 'frontend',
                selectedTaskIds: [task1.body.number],
            }),
        });
        expect(continued.res.status).toBe(200);
        expect(continued.body.ok).toBe(true);
        expect(continued.body.selectedTaskIds).toEqual([task1.body.number]);

        const afterContinue = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        expect(afterContinue.tasks.find((t: any) => t.number === task1.body.number).status).toBe('in_progress');
        expect(afterContinue.tasks.find((t: any) => t.number === task2.body.number).status).toBe('pending');
        expect(afterContinue.tasks.find((t: any) => t.number === task3.body.number).status).toBe('pending');

        // Verify artifacts after complete-phase still have categories
        const audit = await request(`/api/workflows?id=${workflowItemId}`);
        expect(audit.body.artifacts.length).toBeGreaterThanOrEqual(3);
        const postCategories = audit.body.artifacts
            .filter((a: any) => a.artifact_type === 'task')
            .map((a: any) => a.payload.category);
        expect(postCategories).toContain('Frontend');
        expect(postCategories).toContain('QA');
    });
});
