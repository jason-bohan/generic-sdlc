const API = Cypress.env('apiUrl') || 'http://localhost:3001';

function seedAgent(agentId: string, status: Record<string, unknown>) {
    cy.request('POST', `${API}/api/agent/write-status`, { agentId, status });
}

function setGlobalStepMode(enabled: boolean) {
    cy.request('POST', `${API}/api/agent/step-mode/global`, { globalStepMode: enabled });
}

function waitForFrontendRequest(requestId: string, attempts = 8): Cypress.Chainable {
    return cy.request(`${API}/api/status?agentId=frontend`).then((res) => {
        const requests = Array.isArray(res.body.requests) ? res.body.requests : [];
        const found = requests.find((request: { id: string }) => request.id === requestId);
        if (found) return cy.wrap(found);
        if (attempts <= 0) throw new Error(`Timed out waiting for frontend request ${requestId}`);
        return cy.wait(1200).then(() => waitForFrontendRequest(requestId, attempts - 1));
    });
}

const tokens = { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } };
const cypressResults = { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

describe('Review feedback smoke', () => {
    beforeEach(() => {
        setGlobalStepMode(true);
    });

    afterEach(() => {
        setGlobalStepMode(false);
        seedAgent('frontend', { currentPhase: 'idle', storyNumber: null, tasks: [], requests: [], events: [], tokens, prs: [], cypress: cypressResults });
        seedAgent('reviewer', { currentPhase: 'idle', assignedPR: null, events: [] });
    });

    it('routes mock reviewer changes through the bridge into Lasair feedback UI', () => {
        seedAgent('frontend', {
            storyNumber: 'B-99123',
            storyName: 'Smoke review feedback',
            currentPhase: 'watching-reviews',
            currentTask: null,
            startedAt: new Date().toISOString(),
            tokens,
            tasks: [],
            requests: [],
            prs: [{ id: 99123, title: 'PR #99123 smoke', status: 'active', comments: 0, approvals: 0 }],
            cypress: cypressResults,
            events: [],
        });

        seedAgent('reviewer', {
            currentPhase: 'pending-review',
            assignedPR: {
                id: 99123,
                title: 'PR #99123 smoke',
                storyNumber: 'B-99123',
                branch: 'feature/B-99123-smoke',
                projectKey: 'YourProject',
            },
            events: [],
        });

        cy.request('POST', `${API}/api/agent/write-reviewer-comments`, {
            prId: 99123,
            threads: [
                {
                    id: 'smoke-1',
                    file: 'src/Smoke.tsx',
                    line: 21,
                    comment: 'Handle the empty response before rendering.',
                    severity: 'warning',
                },
            ],
        });

        cy.wait(2500);
        seedAgent('reviewer', {
            currentPhase: 'changes-requested',
            assignedPR: {
                id: 99123,
                title: 'PR #99123 smoke',
                storyNumber: 'B-99123',
                branch: 'feature/B-99123-smoke',
                projectKey: 'YourProject',
            },
            events: [],
        });

        waitForFrontendRequest('REQ-smoke-1').then((request) => {
            expect(request).to.deep.include({
                id: 'REQ-smoke-1',
                type: 'review',
                source: 'reviewer',
                summary: 'Handle the empty response before rendering.',
                file: 'src/Smoke.tsx',
                line: 21,
                status: 'open',
                prId: 99123,
            });
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-open-frontend"]').click();
        cy.get('[data-testid="frontend-context-action-bar"]').should('be.visible');
        cy.get('[data-testid="frontend-action-address-feedback"]').should('contain', 'Address Feedback');
        cy.get('[data-testid="frontend-request-REQ-smoke-1"]').within(() => {
            cy.contains('Handle the empty response before rendering.');
            cy.contains('Review');
            cy.contains('warning');
            cy.contains('src/Smoke.tsx:21');
        });
    });
});
