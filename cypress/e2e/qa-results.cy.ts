const API = Cypress.env('apiUrl') || 'http://localhost:3001';

describe('QA Results Panel', () => {
    afterEach(() => {
        cy.resetAgent('qa');
    });

    it('shows ALL TESTS PASS when latest run has zero failures', () => {
        cy.intercept('GET', '**/api/test-results?agentId=qa&latest=1', {
            body: { passed: 10, failed: 0, skipped: 0, recorded_at: new Date().toISOString() },
        }).as('qaResults');

        cy.seedAgent('qa', {
            currentPhase: 'running-tests',
            storyNumber: 'B-99099',
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 10, passed: 10, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.wait('@qaResults');
        cy.get('[data-testid="qa-results-qa"]').should('be.visible');
        cy.get('[data-testid="qa-results-qa"]').within(() => {
            cy.contains('ALL TESTS PASS').should('be.visible');
            cy.contains('10 passed').should('be.visible');
            cy.contains('0 failed').should('be.visible');
        });
    });

    it('shows TESTS FAILING with failure details when tests fail', () => {
        cy.intercept('GET', '**/api/test-results?agentId=qa&latest=1', {
            body: {
                passed: 8,
                failed: 2,
                skipped: 1,
                recorded_at: new Date().toISOString(),
                failures_json: JSON.stringify([
                    { test: 'renders agent cards', error: 'Expected 5 cards, got 4' },
                    { test: 'shows QA badge', error: 'Element not found' },
                ]),
            },
        }).as('qaResults');

        cy.seedAgent('qa', {
            currentPhase: 'running-tests',
            storyNumber: 'B-99099',
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 11, passed: 8, failed: 2, skipped: 1, failures: [] },
        });

        cy.reload();
        cy.wait('@qaResults');
        cy.get('[data-testid="qa-results-qa"]').should('be.visible');
        cy.get('[data-testid="qa-results-qa"]').within(() => {
            cy.contains('TESTS FAILING').should('be.visible');
            cy.contains('8 passed').should('be.visible');
            cy.contains('2 failed').should('be.visible');
            cy.contains('1 skipped').should('be.visible');
            cy.contains('renders agent cards').should('be.visible');
        });
    });

    it('does not show QA panel when agent has no story', () => {
        cy.intercept('GET', '**/api/test-results?agentId=qa&latest=1', {
            body: { empty: true },
        });

        cy.seedAgent('qa', {
            currentPhase: 'idle',
            storyNumber: null,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="qa-results-qa"]').should('not.exist');
    });
});

describe('QA Test Results API', () => {
    it('POST /api/test-results records a run and returns runId', () => {
        cy.request('POST', `${API}/api/test-results`, {
            agentId: 'qa',
            specFile: 'cypress/e2e/dashboard.cy.ts',
            passed: 5,
            failed: 1,
            skipped: 0,
            durationMs: 8000,
            failures: [
                { test: 'renders cards', error: 'Timeout', spec: 'dashboard.cy.ts' },
            ],
        }).then((res) => {
            expect(res.status).to.eq(200);
            expect(res.body.ok).to.be.true;
            expect(res.body.runId).to.exist;
        });
    });

    it('GET /api/test-results?summary=1 returns aggregated summary', () => {
        cy.request(`${API}/api/test-results?summary=1`).then((res) => {
            expect(res.status).to.eq(200);
        });
    });

    it('GET /api/test-results?agentId=qa returns run history', () => {
        cy.request(`${API}/api/test-results?agentId=qa`).then((res) => {
            expect(res.status).to.eq(200);
            expect(res.body.runs).to.be.an('array');
        });
    });
});
