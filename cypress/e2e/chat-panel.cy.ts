const API = Cypress.env('apiUrl') || 'http://localhost:3001';

describe('Chat Panel', () => {
    afterEach(() => {
        cy.resetAgent('frontend');
    });

    it('opens the chat panel from the agent card /btw button', () => {
        cy.get('[data-testid="simple-agent-chat-frontend"]').click();
        cy.get('[role="dialog"][aria-label^="Chat with"]').should('be.visible');
        cy.contains('/btw').should('exist');
    });

    it('displays the empty state when no messages exist', () => {
        cy.get('[data-testid="simple-agent-chat-frontend"]').click();
        cy.get('[role="dialog"][aria-label^="Chat with"]').within(() => {
            cy.contains('Send a message').should('be.visible');
            cy.contains('context').should('be.visible');
        });
    });

    it('sends a message and intercepts the POST to /api/chat', () => {
        cy.intercept('POST', '/api/chat', (req) => {
            req.reply({ ok: true, messageId: 'test-msg-1' });
        }).as('chatSend');

        cy.get('[data-testid="simple-agent-chat-frontend"]').click();
        cy.get('[role="dialog"][aria-label^="Chat with"]').within(() => {
            cy.get('input[placeholder*="Message"]').type('Hello from Cypress');
            cy.get('button').contains('Send').click();
        });

        cy.wait('@chatSend').its('request.body').should((body) => {
            expect(body.agentId).to.eq('frontend');
            expect(body.message).to.deep.include({
                from: 'user',
                message: 'Hello from Cypress',
            });
        });
    });

    it('closes the chat panel with the close button', () => {
        cy.get('[data-testid="simple-agent-chat-frontend"]').click();
        cy.get('[role="dialog"][aria-label^="Chat with"]').should('be.visible');
        cy.get('[aria-label="Close chat"]').click();
        cy.get('[role="dialog"][aria-label^="Chat with"]').should('not.exist');
    });

    it('disables /btw button when chatCapability is unavailable', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'idle',
            storyNumber: null,
            chatCapability: 'unavailable',
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.request(`${API}/api/status?agentId=frontend`).its('body.chatCapability').should('eq', 'unavailable');
        cy.request('/api/status?agentId=frontend').its('body.chatCapability').should('eq', 'unavailable');
        cy.reload();
        cy.get('[data-testid="simple-agent-chat-frontend"]').should('be.disabled');
    });

    it('shows live session indicator when chatCapability is live', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'generating-code',
            storyNumber: 'B-99099',
            chatCapability: 'live',
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.request(`${API}/api/status?agentId=frontend`).its('body.chatCapability').should('eq', 'live');
        cy.request('/api/status?agentId=frontend').its('body.chatCapability').should('eq', 'live');
        cy.reload();
        cy.get('[data-testid="simple-agent-chat-frontend"]').click();
        cy.get('[role="dialog"][aria-label^="Chat with"]').within(() => {
            cy.contains('Live session').should('be.visible');
        });
    });
});
