const API = Cypress.env('apiUrl') || 'http://localhost:3001';

function seedAgent(agentId: string, status: Record<string, unknown>) {
    cy.request('POST', `${API}/api/agent/write-status`, { agentId, status });
}

function setGlobalStepMode(enabled: boolean) {
    cy.request('POST', `${API}/api/agent/step-mode/global`, { globalStepMode: enabled });
}

const idleCleanupStatus = {
    storyNumber: null,
    storyName: null,
    currentPhase: 'idle',
    currentTask: null,
    startedAt: null,
    tasks: [],
    tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
    prs: [],
    cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
    events: [],
    handoffDispatched: false,
};

const baseStatus = {
    storyNumber: 'B-99099',
    storyName: 'Paused card Cypress story',
    currentPhase: 'analyzing',
    currentTask: null,
    startedAt: new Date().toISOString(),
    tasks: [] as Array<{ id: string; name: string; status: string; hours: number }>,
    tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
    prs: [{ id: 99, title: 'PR #99 test', status: 'active', comments: 0, approvals: 0 }],
    cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
    events: [],
    handoffDispatched: false,
};

function stepPillLabelSpan() {
    return cy.get('[title*="Global step mode"]').first().find('span').first();
}

describe('Paused card state (global step mode)', () => {
    afterEach(() => {
        setGlobalStepMode(false);
        (['frontend', 'reviewer', 'qa', 'ux', 'devops'] as const).forEach((id) => {
            seedAgent(id, { ...idleCleanupStatus });
        });
    });

    it('shows PAUSED badge when global step mode is ON and agent is at a checkpoint phase', () => {
        setGlobalStepMode(true);
        seedAgent('frontend', { ...baseStatus, currentPhase: 'analyzing' });
        cy.reload();
        cy.get('[data-testid="paused-badge-frontend"]').should('be.visible').and('contain', 'PAUSED');
    });

    it('does not show PAUSED badge when global step mode is OFF even at a checkpoint phase', () => {
        setGlobalStepMode(false);
        seedAgent('frontend', { ...baseStatus, currentPhase: 'analyzing' });
        cy.reload();
        cy.get('[data-testid="paused-badge-frontend"]').should('not.exist');
    });

    it('shows Review & Continue on paused agent cards when step mode is ON', () => {
        setGlobalStepMode(true);
        seedAgent('frontend', { ...baseStatus, currentPhase: 'analyzing' });
        cy.reload();
        cy.get('[data-testid="simple-agent-review-frontend"]').should('be.visible').and('contain', 'Review & Continue');
    });

    it('does not show Review & Continue when step mode is OFF', () => {
        setGlobalStepMode(false);
        seedAgent('frontend', { ...baseStatus, currentPhase: 'analyzing' });
        cy.reload();
        cy.get('[data-testid="simple-agent-review-frontend"]').should('not.exist');
    });

    it('Step pill shows paused count when multiple agents are at checkpoint phases', () => {
        setGlobalStepMode(true);
        seedAgent('frontend', { ...baseStatus, currentPhase: 'analyzing' });
        seedAgent('reviewer', { ...baseStatus, currentPhase: 'validating' });
        cy.reload();
        stepPillLabelSpan().should('have.text', 'Global step (2)');
    });

    it('Step pill shows plain Step when step mode ON but no agents are at checkpoint phases', () => {
        setGlobalStepMode(true);
        seedAgent('frontend', { ...baseStatus, currentPhase: 'idle' });
        seedAgent('reviewer', { ...baseStatus, currentPhase: 'complete' });
        cy.reload();
        stepPillLabelSpan().should('have.text', 'Global step');
    });

    it('Step pill shows plain Step when global step mode is OFF', () => {
        setGlobalStepMode(false);
        seedAgent('frontend', { ...baseStatus, currentPhase: 'analyzing' });
        seedAgent('reviewer', { ...baseStatus, currentPhase: 'validating' });
        cy.reload();
        stepPillLabelSpan().should('have.text', 'Global step');
    });

    it('does not show PAUSED for idle, complete, or error when step mode is ON', () => {
        setGlobalStepMode(true);
        (['idle', 'complete', 'error'] as const).forEach((phase) => {
            seedAgent('frontend', { ...baseStatus, currentPhase: phase });
            cy.reload();
            cy.get('[data-testid="paused-badge-frontend"]').should('not.exist');
        });
    });
});
