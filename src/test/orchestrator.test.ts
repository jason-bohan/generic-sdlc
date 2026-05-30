import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { closeDb, dbGetWorkflowItemByStory, dbGetWorkflowItemsByStory, initDb } from '../server/db';
import { classifyStory, completePhase, getWorkflowAudit, resolveStoryAgent, startWorkflow, superviseWorkflow, triageStoryAgent } from '../server/orchestrator';

const TMP = resolve(__dirname, '.orchestrator-tmp');

beforeEach(() => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    initDb(TMP);
});

afterEach(() => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
});

describe('orchestrator-lite', () => {
    it('classifies full-stack work and assigns backend as primary with frontend collaborator', () => {
        const decision = classifyStory({
            number: 'B-17001',
            frontend: '<ul><li>Add settings UI</li></ul>',
            backend: '<ul><li>Add preferences API</li></ul>',
            qa: '<ul><li>Regression around settings</li></ul>',
            affectedRepo: 'YourProject',
        });

        expect(decision).toMatchObject({
            classification: 'full-stack',
            primaryAgent: 'backend',
            collaboratorAgents: ['frontend'],
            startPhase: 'reading-story',
            affectedRepo: 'YourProject',
        });
    });

    it('starts a durable workflow item and records assignment audit', () => {
        const result = startWorkflow({
            externalMode: 'mock',
            story: {
                number: 'B-17002',
                name: 'Add audit history endpoint',
                backend: 'Create endpoint and service',
                projectKey: 'YourProject',
                affectedRepo: 'YourProject',
            },
        });

        expect(result.ok).toBe(true);
        expect(result.value?.item).toMatchObject({
            story_number: 'B-17002',
            classification: 'backend',
            active_agent_id: 'backend',
            active_phase: 'reading-story',
            external_mode: 'mock',
            project_key: 'YourProject',
        });

        const stored = dbGetWorkflowItemByStory('B-17002');
        expect(stored?.id).toBe(result.value?.item.id);

        const audit = getWorkflowAudit(result.value!.item.id);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
            agent_id: 'orchestrator',
            phase: 'story-intake',
            event_type: 'assigned',
        });
        expect(JSON.parse(audit[0].outputs_json)).toMatchObject({
            classification: 'backend',
            auditEvent: { externalMode: 'mock' },
        });
    });

    it('rejects incomplete phase output contracts before transition', () => {
        const started = startWorkflow({
            externalMode: 'mock',
            story: { number: 'B-17003', frontend: 'Add profile card' },
        });
        const item = started.value!.item;

        const result = completePhase({
            workflowItemId: item.id,
            agentId: 'frontend',
            phase: 'reading-story',
            nextPhase: 'analyzing',
            outputs: {
                tasks: [{ name: 'Build card' }],
                taskIds: ['TK-1'],
            },
        });

        expect(result.ok).toBe(false);
        expect(result.missing).toEqual(expect.arrayContaining(['branchPlan', 'testMatrix', 'risks', 'openQuestions', 'auditEvent']));
    });

    it('transitions when the phase output contract and role graph allow it', () => {
        const started = startWorkflow({
            externalMode: 'mock',
            story: { number: 'B-17004', frontend: 'Add profile card' },
        });
        const item = started.value!.item;

        const result = completePhase({
            workflowItemId: item.id,
            agentId: 'frontend',
            phase: 'reading-story',
            nextPhase: 'analyzing',
            outputs: {
                tasks: [{ name: 'Build card' }],
                taskIds: ['TK-1'],
                branchPlan: { branch: 'feat/b-17004-profile-card' },
                testMatrix: { unit: true },
                risks: [],
                openQuestions: [],
                auditEvent: { completedBy: 'frontend' },
            },
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            active_agent_id: 'frontend',
            active_phase: 'analyzing',
            status: 'active',
        });

        const audit = getWorkflowAudit(item.id);
        expect(audit.map(e => e.event_type)).toEqual(['assigned', 'phase-completed', 'transitioned']);
    });

    it('rejects transitions outside the agent workflow graph', () => {
        const started = startWorkflow({
            externalMode: 'mock',
            story: { number: 'B-17005', frontend: 'Add profile card' },
        });
        const item = started.value!.item;

        const result = completePhase({
            workflowItemId: item.id,
            agentId: 'frontend',
            phase: 'reading-story',
            nextPhase: 'pending-build',
            outputs: {
                tasks: [{ name: 'Build card' }],
                taskIds: ['TK-1'],
                branchPlan: { branch: 'feat/b-17005-profile-card' },
                testMatrix: { unit: true },
                risks: [],
                openQuestions: [],
                auditEvent: { completedBy: 'frontend' },
            },
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('frontend cannot transition reading-story -> pending-build');
    });

    it('classifies as unknown when story has no frontend/backend fields', () => {
        const decision = classifyStory({
            number: 'B-17010',
            name: 'Some story',
            description: 'Some description with no structured work fields',
        });
        expect(decision.classification).toBe('unknown');
        expect(decision.primaryAgent).toBe('frontend');
    });

    it('infers backend from story text when no fields are tagged (e.g. a route/endpoint)', () => {
        const decision = classifyStory({
            number: 'LOCAL-B-0015',
            name: 'Add a GET /health endpoint returning JSON status',
            description: 'Add a GET /health route to the server returning HTTP 200, plus a unit test.',
        });
        expect(decision.classification).toBe('backend');
        expect(decision.primaryAgent).toBe('backend');
    });

    it('infers frontend from story text (component/UI)', () => {
        const decision = classifyStory({
            number: 'F-1',
            name: 'Add a settings page component',
            description: 'Render a new settings UI with a save button.',
        });
        expect(decision.classification).toBe('frontend');
        expect(decision.primaryAgent).toBe('frontend');
    });

    it('stays unknown (frontend default) when text mentions both disciplines ambiguously', () => {
        const decision = classifyStory({
            number: 'X-1',
            name: 'Wire the settings page to the preferences API',
            description: 'Connect the UI component to the backend endpoint.',
        });
        // Mentions both UI and endpoint → not decidable by keywords → escalate via 'unknown'
        expect(decision.classification).toBe('unknown');
    });

    it('triageStoryAgent maps a model answer to a valid agent', async () => {
        const agent = await triageStoryAgent({ number: 'x', name: 'thing', description: 'desc' }, { chat: async () => 'backend' });
        expect(agent).toBe('backend');
    });

    it('triageStoryAgent extracts the agent from a verbose answer', async () => {
        const agent = await triageStoryAgent({ number: 'x' }, { chat: async () => 'This should go to the frontend team.' });
        expect(agent).toBe('frontend');
    });

    it('triageStoryAgent returns null on an unrecognized answer', async () => {
        const agent = await triageStoryAgent({ number: 'x' }, { chat: async () => 'banana' });
        expect(agent).toBeNull();
    });

    it('resolveStoryAgent uses the heuristic without calling the model for a clear backend story', async () => {
        let called = false;
        const agent = await resolveStoryAgent(
            { number: 'x', name: 'Add a GET /health endpoint', description: 'a server route' },
            { chat: async () => { called = true; return 'frontend'; } },
        );
        expect(agent).toBe('backend');
        expect(called).toBe(false);
    });

    it('resolveStoryAgent escalates to LLM triage when the story is ambiguous', async () => {
        const agent = await resolveStoryAgent(
            { number: 'x', name: 'Connect the UI component to the backend endpoint', description: '' },
            { chat: async () => 'qa' },
        );
        expect(agent).toBe('qa');
    });

    it('startWorkflow with assignedAgentId on full-stack story removes agent from collaborators', () => {
        // Dashboard assigns directly to frontend on a story that classifies as full-stack
        // Frontend should be primary, NOT also listed as its own collaborator
        const result = startWorkflow({
            externalMode: 'mock',
            assignedAgentId: 'frontend',
            story: {
                number: 'B-17011',
                name: 'Full-stack story assigned to frontend',
                frontend: 'Add settings UI',
                backend: 'Add preferences API',
            },
        });

        expect(result.ok).toBe(true);
        const { item, decision } = result.value!;
        expect(decision.primaryAgent).toBe('frontend');
        expect(decision.collaboratorAgents).not.toContain('frontend');
        // Classification still reflects the story content
        expect(decision.classification).toBe('full-stack');
        expect(item.active_agent_id).toBe('frontend');
    });

    it('startWorkflow with assignedAgentId preserves backend collaborator when frontend is overridden primary', () => {
        // Story has frontend+backend; user assigns to frontend; backend should still be a collaborator
        // (backend is NOT removed because the override is frontend, not backend)
        const result = startWorkflow({
            externalMode: 'mock',
            assignedAgentId: 'frontend',
            story: {
                number: 'B-17012',
                frontend: 'Add table UI',
                backend: 'Add pagination API',
            },
        });

        expect(result.ok).toBe(true);
        const { decision } = result.value!;
        expect(decision.primaryAgent).toBe('frontend');
        // Backend is not the overridden agent, so it's NOT in the collaborator list
        // (inferred collaborators for full-stack are ['frontend'] — backend is primary by default)
        expect(decision.collaboratorAgents).not.toContain('frontend');
    });

    it('recommends supervisor actions from durable workflow state', () => {
        const started = startWorkflow({
            externalMode: 'mock',
            story: {
                number: 'B-17006',
                frontend: 'Build settings UI',
                backend: 'Add preferences API',
            },
        });

        const decision = superviseWorkflow(started.value!.item.id);

        expect(decision.ok).toBe(true);
        expect(decision.value?.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'assign-collaborator',
                agentId: 'frontend',
                phase: 'reading-story',
            }),
            expect.objectContaining({
                type: 'run-active-phase',
                agentId: 'backend',
                phase: 'reading-story',
            }),
        ]));
    });

    it('creates independent workflow items for two agents on the same story', () => {
        const backendResult = startWorkflow({
            externalMode: 'mock',
            assignedAgentId: 'backend',
            story: { number: 'B-20001', name: 'Multi-agent pagination', frontend: 'Lazy table', backend: 'Page/size API' },
        });
        const frontendResult = startWorkflow({
            externalMode: 'mock',
            assignedAgentId: 'frontend',
            story: { number: 'B-20001', name: 'Multi-agent pagination', frontend: 'Lazy table', backend: 'Page/size API' },
        });

        expect(backendResult.ok).toBe(true);
        expect(frontendResult.ok).toBe(true);
        expect(backendResult.value!.item.id).not.toBe(frontendResult.value!.item.id);

        const backendRow = dbGetWorkflowItemByStory('B-20001', 'backend');
        const frontendRow = dbGetWorkflowItemByStory('B-20001', 'frontend');
        expect(backendRow).toBeDefined();
        expect(frontendRow).toBeDefined();
        expect(backendRow!.active_agent_id).toBe('backend');
        expect(frontendRow!.active_agent_id).toBe('frontend');

        const allRows = dbGetWorkflowItemsByStory('B-20001');
        expect(allRows).toHaveLength(2);
    });

    it('allows both agents to independently complete phases on the same story', () => {
        const backendResult = startWorkflow({
            externalMode: 'mock',
            assignedAgentId: 'backend',
            story: { number: 'B-20002', backend: 'API work' },
        });
        const frontendResult = startWorkflow({
            externalMode: 'mock',
            assignedAgentId: 'frontend',
            story: { number: 'B-20002', frontend: 'UI work' },
        });

        const fullOutputs = {
            tasks: [{ name: 'Task 1' }],
            taskIds: ['TK-1'],
            branchPlan: { branch: 'feat/b-20002' },
            testMatrix: { unit: true },
            risks: [],
            openQuestions: [],
            auditEvent: { completedBy: 'test' },
        };

        const backendComplete = completePhase({
            workflowItemId: backendResult.value!.item.id,
            agentId: 'backend',
            phase: 'reading-story',
            nextPhase: 'analyzing',
            outputs: fullOutputs,
        });
        expect(backendComplete.ok).toBe(true);
        expect(backendComplete.value!.active_phase).toBe('analyzing');

        const frontendComplete = completePhase({
            workflowItemId: frontendResult.value!.item.id,
            agentId: 'frontend',
            phase: 'reading-story',
            nextPhase: 'analyzing',
            outputs: fullOutputs,
        });
        expect(frontendComplete.ok).toBe(true);
        expect(frontendComplete.value!.active_phase).toBe('analyzing');

        const backendRow = dbGetWorkflowItemByStory('B-20002', 'backend');
        const frontendRow = dbGetWorkflowItemByStory('B-20002', 'frontend');
        expect(backendRow!.active_phase).toBe('analyzing');
        expect(frontendRow!.active_phase).toBe('analyzing');
    });

    it('rejects completePhase when agentId does not match the workflow item', () => {
        const started = startWorkflow({
            externalMode: 'mock',
            assignedAgentId: 'backend',
            story: { number: 'B-20003', backend: 'API work' },
        });

        const result = completePhase({
            workflowItemId: started.value!.item.id,
            agentId: 'frontend',
            phase: 'reading-story',
            nextPhase: 'analyzing',
            outputs: {
                tasks: [{ name: 'Task 1' }],
                taskIds: ['TK-1'],
                branchPlan: { branch: 'feat/b-20003' },
                testMatrix: { unit: true },
                risks: [],
                openQuestions: [],
                auditEvent: { completedBy: 'frontend' },
            },
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('backend');
        expect(result.error).toContain('frontend');
    });
});
