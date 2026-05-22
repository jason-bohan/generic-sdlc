const API = Cypress.env('apiUrl') || 'http://localhost:3001';

function seedAgent(agentId: string, status: Record<string, unknown>) {
    cy.request('POST', `${API}/api/agent/write-status`, { agentId, status });
}

function setGlobalStepMode(enabled: boolean) {
    cy.request('POST', `${API}/api/agent/step-mode/global`, { globalStepMode: enabled });
}

function setAgentStepMode(agentId: string, enabled: boolean) {
    cy.request('POST', `${API}/api/agent/step-mode`, { agentId, stepMode: enabled });
}

const baseStatus = {
    storyNumber: 'B-99099',
    storyName: 'Cypress test story',
    currentPhase: 'addressing-feedback',
    currentTask: null,
    startedAt: new Date().toISOString(),
    tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
    prs: [{ id: 99, title: 'PR #99 test', status: 'active', comments: 2, approvals: 0 }],
    cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
    events: [],
    handoffDispatched: false,
};

describe('Step-mode request pills', () => {
    beforeEach(() => {
        setGlobalStepMode(true);
    });

    afterEach(() => {
        setGlobalStepMode(false);
        seedAgent('frontend', { currentPhase: 'idle', storyNumber: null, tasks: [], events: [], tokens: baseStatus.tokens, prs: [], cypress: baseStatus.cypress });
    });

    it('renders request pills with distinct styling alongside task pills', () => {
        seedAgent('frontend', {
            ...baseStatus,
            tasks: [
                { id: 'TK-1', name: 'Fix button color', status: 'in_progress', hours: 2, category: 'Frontend' },
            ],
            requests: [
                { id: 'R-99-1', type: 'review', source: 'reviewer', summary: 'Extract helper function', file: 'src/utils.ts', line: 42, severity: 'warning', status: 'open', prId: 99, createdAt: new Date().toISOString() },
                { id: 'D-99-1', type: 'design', source: 'ux', summary: 'Button contrast too low', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();

        cy.get('[data-testid="frontend-task-list"]').should('exist');
        cy.get('[data-testid="frontend-task-TK-1"]').should('exist');
        cy.get('[data-testid="frontend-request-R-99-1"]').should('exist');
        cy.get('[data-testid="frontend-request-D-99-1"]').should('exist');

        cy.get('[data-testid="frontend-request-R-99-1"]').within(() => {
            cy.contains('Extract helper function');
            cy.contains('Review');
            cy.contains('warning');
            cy.contains('src/utils.ts:42');
        });

        cy.get('[data-testid="frontend-request-D-99-1"]').within(() => {
            cy.contains('Button contrast too low');
            cy.contains('Design');
        });
    });

    it('shows build request pills with red styling', () => {
        seedAgent('frontend', {
            ...baseStatus,
            tasks: [],
            requests: [
                { id: 'B-99-1', type: 'build', source: 'devops', summary: 'Build #500 failed for PR #99', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();
        cy.get('[data-testid="frontend-request-B-99-1"]').should('exist');
        cy.get('[data-testid="frontend-request-B-99-1"]').within(() => {
            cy.contains('Build');
            cy.contains('failed');
        });
    });

    it('can select and deselect request pills in step mode', () => {
        seedAgent('frontend', {
            ...baseStatus,
            tasks: [
                { id: 'TK-1', name: 'Fix button', status: 'in_progress', hours: 1 },
            ],
            requests: [
                { id: 'R-99-1', type: 'review', source: 'reviewer', summary: 'Extract helper', status: 'open', prId: 99, createdAt: new Date().toISOString() },
                { id: 'R-99-2', type: 'review', source: 'reviewer', summary: 'Add null check', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-open-frontend"]').click();
        cy.get('[data-testid="frontend-select-actions"]').should('exist');

        cy.get('[data-testid="frontend-request-R-99-1"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('contain', '1 request selected');

        cy.get('[data-testid="frontend-request-R-99-2"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('contain', '2 requests selected');

        cy.get('[data-testid="frontend-request-R-99-1"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('contain', '1 request selected');
    });

    it('Select All includes both tasks and requests', () => {
        seedAgent('frontend', {
            ...baseStatus,
            currentPhase: 'generating-code',
            tasks: [
                { id: 'TK-1', name: 'Fix button', status: 'in_progress', hours: 1 },
                { id: 'TK-2', name: 'Fix modal', status: 'pending', hours: 2 },
            ],
            requests: [
                { id: 'R-99-1', type: 'review', source: 'reviewer', summary: 'Extract helper', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();

        cy.get('[data-testid="frontend-select-all"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('contain', '1 task, 1 request selected');

        cy.get('[data-testid="frontend-resume-btn"]').should('contain', 'Resume with 2 items');
    });

    it('Deselect All clears both tasks and requests', () => {
        seedAgent('frontend', {
            ...baseStatus,
            currentPhase: 'generating-code',
            tasks: [
                { id: 'TK-1', name: 'Fix button', status: 'pending', hours: 1 },
            ],
            requests: [
                { id: 'R-99-1', type: 'review', source: 'reviewer', summary: 'Extract helper', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();

        cy.get('[data-testid="frontend-select-all"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('contain', '1 task, 1 request selected');

        cy.get('[data-testid="frontend-deselect-all"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('not.exist');
        cy.get('[data-testid="frontend-resume-btn"]').should('contain', 'Next Step');
    });

    it('resolved requests are dimmed and not selectable', () => {
        seedAgent('frontend', {
            ...baseStatus,
            tasks: [],
            requests: [
                { id: 'R-99-1', type: 'review', source: 'reviewer', summary: 'Already fixed', status: 'resolved', prId: 99, createdAt: new Date().toISOString() },
                { id: 'R-99-2', type: 'review', source: 'reviewer', summary: 'Still open', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();

        // Wait for step-mode state to load (async fetch) before interacting
        cy.get('[data-testid="frontend-select-actions"]').should('exist');

        cy.get('[data-testid="frontend-request-R-99-1"]').should('have.css', 'opacity', '0.55');

        cy.get('[data-testid="frontend-request-R-99-1"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('not.exist');

        cy.get('[data-testid="frontend-request-R-99-2"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('contain', '1 request selected');
    });

    it('resume button label reflects mixed task + request selection', () => {
        seedAgent('frontend', {
            ...baseStatus,
            currentPhase: 'generating-code',
            tasks: [
                { id: 'TK-1', name: 'Fix button', status: 'pending', hours: 1 },
            ],
            requests: [
                { id: 'R-99-1', type: 'review', source: 'reviewer', summary: 'Extract helper', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();

        cy.get('[data-testid="frontend-resume-btn"]').should('contain', 'Next Step');

        cy.get('[data-testid="frontend-task-TK-1"]').click();
        cy.get('[data-testid="frontend-resume-btn"]').should('contain', 'Resume with 1 item');

        cy.get('[data-testid="frontend-request-R-99-1"]').click();
        cy.get('[data-testid="frontend-resume-btn"]').should('contain', 'Resume with 2 items');
    });

    it('dismiss button removes a completed task pill', () => {
        seedAgent('frontend', {
            ...baseStatus,
            tasks: [
                { id: 'TK-1', name: 'Fix button', status: 'completed', hours: 1 },
                { id: 'TK-2', name: 'Fix modal', status: 'in_progress', hours: 2 },
            ],
            requests: [],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();
        cy.get('[data-testid="frontend-task-TK-1"]').should('exist');
        cy.get('[data-testid="frontend-dismiss-task-TK-1"]').click();
        cy.get('[data-testid="frontend-task-TK-1"]').should('not.exist');
        cy.get('[data-testid="frontend-task-TK-2"]').should('exist');
    });

    it('dismiss button removes a resolved request pill', () => {
        seedAgent('frontend', {
            ...baseStatus,
            tasks: [],
            requests: [
                { id: 'R-99-1', type: 'review', source: 'reviewer', summary: 'Already fixed', status: 'resolved', prId: 99, createdAt: new Date().toISOString() },
                { id: 'R-99-2', type: 'review', source: 'reviewer', summary: 'Still open', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();
        cy.get('[data-testid="frontend-request-R-99-1"]').should('exist');
        cy.get('[data-testid="frontend-dismiss-request-R-99-1"]').click();
        cy.get('[data-testid="frontend-request-R-99-1"]').should('not.exist');
        cy.get('[data-testid="frontend-request-R-99-2"]').should('exist');
    });

    it('dismiss button does not appear on in-progress tasks', () => {
        seedAgent('frontend', {
            ...baseStatus,
            currentPhase: 'generating-code',
            tasks: [
                { id: 'TK-1', name: 'Active task', status: 'in_progress', hours: 1 },
            ],
            requests: [],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();
        cy.get('[data-testid="frontend-task-TK-1"]').should('exist');
        cy.get('[data-testid="frontend-dismiss-task-TK-1"]').should('not.exist');
    });

    it('section title changes to Tasks & Requests when requests exist', () => {
        seedAgent('frontend', {
            ...baseStatus,
            tasks: [{ id: 'TK-1', name: 'Fix button', status: 'in_progress', hours: 1 }],
            requests: [
                { id: 'R-99-1', type: 'review', source: 'reviewer', summary: 'Fix this', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();
        cy.contains('Tasks & Requests').should('be.visible');
    });
});

describe('Step-mode contextual action bar', () => {
    beforeEach(() => {
        setGlobalStepMode(true);
    });

    afterEach(() => {
        setGlobalStepMode(false);
        seedAgent('frontend', { currentPhase: 'idle', storyNumber: null, tasks: [], events: [], tokens: baseStatus.tokens, prs: [], cypress: baseStatus.cypress });
    });

    it('shows the action bar when all tasks are completed at a step-mode creating-pr phase', () => {
        seedAgent('frontend', {
            ...baseStatus,
            currentPhase: 'creating-pr',
            tasks: [{ id: 'TK-1', name: 'Done task', status: 'completed', hours: 1, category: 'Frontend' }],
            requests: [],
        });

        cy.get('[data-testid="simple-agent-open-frontend"]').click();

        cy.get('[data-testid="frontend-context-action-bar"]').should('be.visible');
        cy.contains("completed all assigned tasks");
        cy.get('[data-testid="frontend-action-create-pr"]').should('contain', 'Create PR');
        cy.get('[data-testid="frontend-action-continue-auto"]').should('contain', 'Continue Autonomously');
        cy.get('[data-testid="frontend-action-assign-more"]').should('be.visible');
    });

    it('submits selected review request ids from the Address Feedback action', () => {
        seedAgent('frontend', {
            ...baseStatus,
            currentPhase: 'addressing-feedback',
            tasks: [],
            requests: [
                {
                    id: 'R-99-1',
                    type: 'review',
                    source: 'reviewer',
                    summary: 'Handle missing preference before reading theme.',
                    file: 'src/api.ts',
                    line: 18,
                    severity: 'warning',
                    status: 'open',
                    prId: 99,
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        cy.intercept('POST', '/api/agent/continue', (req) => {
            req.reply({ ok: true, selectedRequestIds: req.body.selectedRequestIds ?? [] });
        }).as('continueAgent');

        cy.get('[data-testid="simple-agent-open-frontend"]').click();

        cy.get('[data-testid="frontend-context-action-bar"]').should('be.visible');
        cy.contains('Lasair has feedback to address');
        cy.get('[data-testid="frontend-action-address-feedback"]').should('contain', 'Address Feedback');

        cy.get('[data-testid="frontend-request-R-99-1"]').within(() => {
            cy.contains('Handle missing preference before reading theme.');
            cy.contains('Review');
            cy.contains('warning');
            cy.contains('src/api.ts:18');
        });

        cy.get('[data-testid="frontend-request-R-99-1"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('contain', '1 request selected');
        cy.contains("1 selected request will be passed into Lasair's next run");

        cy.get('[data-testid="frontend-action-address-feedback"]').click();
        cy.wait('@continueAgent').its('request.body').should((body) => {
            expect(body.agentId).to.eq('frontend');
            expect(body.selectedRequestIds).to.deep.eq(['R-99-1']);
            expect(body.selectedTaskIds).to.be.undefined;
        });
    });

    it('Assign More Tasks clears completed tasks from the resume selection', () => {
        const midSeed = {
            ...baseStatus,
            currentPhase: 'generating-code',
            tasks: [
                { id: 'TK-1', name: 'Was active', status: 'pending', hours: 1, category: 'Frontend' },
                { id: 'TK-2', name: 'Pending next', status: 'pending', hours: 1, category: 'Frontend' },
            ],
            requests: [],
        };
        seedAgent('frontend', midSeed);

        cy.get('[data-testid="simple-agent-open-frontend"]').click();
        cy.get('[data-testid="frontend-select-actions"]').should('exist');
        cy.get('[data-testid="frontend-task-TK-1"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('contain', '1 task selected');

        cy.request('POST', `${API}/api/agent/write-status`, {
            agentId: 'frontend',
            status: {
                ...midSeed,
                tasks: [
                    { id: 'TK-1', name: 'Was active', status: 'completed', hours: 1, category: 'Frontend' },
                    { id: 'TK-2', name: 'Pending next', status: 'pending', hours: 1, category: 'Frontend' },
                ],
            },
        });

        cy.wait(3000);
        cy.get('[data-testid="frontend-selected-count"]').should('contain', '1 task selected');

        cy.get('[data-testid="frontend-action-assign-more"]').click();
        cy.get('[data-testid="frontend-selected-count"]').should('not.exist');
    });
});

describe('Request data flow through API', () => {
    it('review-complete with comments creates requests in status file', () => {
        seedAgent('frontend', {
            ...baseStatus,
            currentPhase: 'watching-reviews',
            requests: undefined,
        });

        cy.request('POST', `${API}/api/handoff/review-complete`, {
            prId: 99,
            verdict: 'changes-requested',
            storyNumber: 'B-99099',
            commentCount: 1,
            comments: [
                { summary: 'Refactor this method', file: 'src/app.ts', line: 10 },
            ],
        }).then((res) => {
            expect(res.status).to.eq(200);
            expect(res.body.ok).to.be.true;
        });

        cy.request(`${API}/api/status?agentId=frontend`).then((res) => {
            expect(res.body.currentPhase).to.eq('addressing-feedback');
            expect(res.body.requests).to.have.length(1);
            expect(res.body.requests[0]).to.deep.include({
                id: 'R-99-1',
                type: 'review',
                source: 'reviewer',
                summary: 'Refactor this method',
                file: 'src/app.ts',
                line: 10,
                status: 'open',
            });
        });
    });

    it('continue endpoint accepts selectedRequestIds', () => {
        seedAgent('frontend', {
            ...baseStatus,
            currentPhase: 'addressing-feedback',
            requests: [
                { id: 'R-99-1', type: 'review', source: 'reviewer', summary: 'Refactor this', status: 'open', prId: 99, createdAt: new Date().toISOString() },
            ],
        });

        cy.request('POST', `${API}/api/agent/continue`, {
            agentId: 'frontend',
            selectedTaskIds: [],
            selectedRequestIds: ['R-99-1'],
        }).then((res) => {
            expect(res.status).to.eq(200);
            expect(res.body.ok).to.be.true;
            expect(res.body.selectedRequestIds).to.deep.eq(['R-99-1']);
        });
    });
});
