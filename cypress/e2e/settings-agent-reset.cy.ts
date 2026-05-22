/** Confirmation string must match src/shared/agentResetConfirm.ts (AGENT_RESET_CONFIRM_PHRASE). */
const CONFIRM_PHRASE = 'RESET_ALL_AGENTS';

function openSettingsPanel() {
    cy.get('[data-testid="app-settings-btn"]').should('be.visible').click();
    cy.contains('h2, span', 'Settings').should('be.visible');
    cy.get('[data-testid="settings-reset-agents-open"]').should('be.visible');
}

function openResetAgentsModal() {
    cy.get('[data-testid="settings-reset-agents-open"]').click();
    cy.contains('Reset all agents?').should('be.visible');
    cy.get('[data-testid="settings-reset-agents-phrase"]').should('be.visible');
}

describe('Settings panel - reset all agents', () => {
    describe('reset API (intercepted)', () => {
        beforeEach(() => {
            cy.intercept('POST', '**/api/agents/reset-to-idle', {
                statusCode: 200,
                body: { ok: true },
            }).as('resetIdle');
        });

        it('POSTs the typed confirmation phrase and closes the modal on success', () => {
            openSettingsPanel();
            openResetAgentsModal();

            cy.get('[data-testid="settings-reset-agents-phrase"]').type(CONFIRM_PHRASE);
            cy.get('[data-testid="settings-reset-agents-confirm"]').click();

            cy.wait('@resetIdle').then((interception) => {
                expect(interception.request.method).to.eq('POST');
                expect(interception.request.body).to.deep.equal({ confirm: CONFIRM_PHRASE });
            });

            cy.get('[data-testid="settings-reset-agents-phrase"]').should('not.exist');
            cy.contains('Reset all agents?').should('not.exist');
            cy.get('[data-testid="settings-reset-agents-open"]').should('be.visible');
        });
    });

    describe('reset API errors (intercepted)', () => {
        beforeEach(() => {
            cy.intercept('POST', '**/api/agents/reset-to-idle', {
                statusCode: 400,
                body: { error: 'Confirm phrase mismatch' },
            }).as('resetFail');
        });

        it('shows the server error and leaves the modal open', () => {
            openSettingsPanel();
            openResetAgentsModal();

            cy.get('[data-testid="settings-reset-agents-phrase"]').type(CONFIRM_PHRASE);
            cy.get('[data-testid="settings-reset-agents-confirm"]').click();

            cy.wait('@resetFail');
            cy.get('[data-testid="settings-reset-agents-phrase"]').should('be.visible');
            cy.get('[role="alert"]')
                .should('be.visible')
                .and('contain', 'Confirm phrase mismatch');
        });
    });

    describe('confirmation UX', () => {
        it('disables confirm until the phrase matches exactly', () => {
            openSettingsPanel();
            openResetAgentsModal();

            cy.get('[data-testid="settings-reset-agents-confirm"]').should('be.disabled');

            cy.get('[data-testid="settings-reset-agents-phrase"]').type('wrong-phrase');
            cy.get('[data-testid="settings-reset-agents-confirm"]').should('be.disabled');

            cy.get('[data-testid="settings-reset-agents-phrase"]').clear().type(CONFIRM_PHRASE);
            cy.get('[data-testid="settings-reset-agents-confirm"]').should('not.be.disabled').and('contain', 'Reset agents');
        });

        it('closes the reset dialog on Cancel without calling the API', () => {
            cy.intercept('POST', '**/api/agents/reset-to-idle', {
                statusCode: 200,
                body: { ok: true },
            }).as('resetIfCalled');

            openSettingsPanel();
            openResetAgentsModal();

            cy.contains('button', 'Cancel').click();

            cy.get('[data-testid="settings-reset-agents-phrase"]').should('not.exist');
            cy.get('@resetIfCalled.all').then((interceptions) => {
                expect(interceptions, 'reset endpoint should not be called').to.have.length(0);
            });
        });
    });
});
