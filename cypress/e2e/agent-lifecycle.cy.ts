const API = Cypress.env('apiUrl') || 'http://localhost:3001';

describe('Agent Lifecycle - Stopped State', () => {
    afterEach(() => {
        cy.resetAgent('frontend');
    });

    it('shows STOPPED badge when agent has a story but isRunning is false', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'generating-code',
            storyNumber: 'B-99099',
            storyName: 'Lifecycle test story',
            isRunning: false,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="stopped-badge-frontend"]')
            .should('be.visible')
            .and('contain', 'STOPPED');
    });

    it('opens resume popover when STOPPED badge is clicked', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'generating-code',
            storyNumber: 'B-99099',
            isRunning: false,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="stopped-badge-frontend"]').click();
        cy.contains('Agent was terminated mid-work').should('be.visible');
        cy.get('[data-testid="resume-btn-frontend"]')
            .should('be.visible')
            .and('contain', 'Resume');
    });

    it('calls /api/agent/continue when Resume is clicked', () => {
        cy.intercept('POST', '/api/agent/continue', (req) => {
            req.reply({ ok: true });
        }).as('continueAgent');

        cy.seedAgent('frontend', {
            currentPhase: 'generating-code',
            storyNumber: 'B-99099',
            isRunning: false,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="stopped-badge-frontend"]').click();
        cy.get('[data-testid="resume-btn-frontend"]').click();

        cy.wait('@continueAgent').its('request.body').should((body) => {
            expect(body.agentId).to.eq('frontend');
        });
    });

    it('does not show STOPPED badge when agent is idle', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'idle',
            storyNumber: null,
            isRunning: false,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="stopped-badge-frontend"]').should('not.exist');
    });
});

describe('Agent Lifecycle - Approve Start', () => {
    afterEach(() => {
        cy.resetAgent('frontend');
    });

    it('shows Approve Start button when agent is in pending-approval phase', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'pending-approval',
            storyNumber: 'B-99099',
            storyName: 'Approval test',
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-approve-frontend"]')
            .should('be.visible')
            .and('contain', 'Approve Start');
    });

    it('does not show Approve Start in non-approval phases', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'generating-code',
            storyNumber: 'B-99099',
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-approve-frontend"]').should('not.exist');
    });
});

describe('Agent Lifecycle - Phase Display', () => {
    afterEach(() => {
        cy.resetAgent('frontend');
    });

    it('shows Idle phase when agent has no story', () => {
        cy.get('[data-testid="simple-agent-card-frontend"]').within(() => {
            cy.contains('Idle').should('be.visible');
        });
    });

    it('shows Coding phase when agent is generating code', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'generating-code',
            storyNumber: 'B-99099',
            storyName: 'Phase test',
            currentTask: 'Building the login form',
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-card-frontend"]').within(() => {
            // Floor cards use short PHASE_LABELS (desk uses "Generating Code").
            cy.contains('Coding').should('be.visible');
            cy.contains('B-99099').should('be.visible');
        });
    });

    it('shows current task text on the card', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'generating-code',
            storyNumber: 'B-99099',
            currentTask: 'Building the login form',
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-card-frontend"]').within(() => {
            cy.contains('Building the login form').should('be.visible');
        });
    });
});
