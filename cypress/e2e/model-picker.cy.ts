describe('Model Picker (Simple Floor)', () => {
    it('shows a model pill on active agent cards', () => {
        cy.get('[data-testid^="simple-agent-model-"]').should('have.length.greaterThan', 0);
    });

    it('opens the model popup when clicking the pill', () => {
        cy.get('[data-testid="simple-agent-model-frontend"]').click();
        cy.get('[data-testid="simple-agent-card-frontend"]')
            .contains('Default').should('exist');
        cy.get('[data-testid="simple-agent-card-frontend"]')
            .contains('Local').should('exist');
    });

    it('has a search box in the model popup', () => {
        cy.get('[data-testid="simple-agent-model-frontend"]').click();
        cy.get('input[placeholder*="Search"]').should('be.visible');
    });

    it('closes popup when clicking outside', () => {
        cy.get('[data-testid="simple-agent-model-frontend"]').click();
        cy.get('input[placeholder*="Search"]').should('be.visible');
        cy.get('body').click(0, 0);
        cy.get('input[placeholder*="Search"]').should('not.exist');
    });

    it('shows the Cursor Settings hint', () => {
        cy.get('[data-testid="simple-agent-model-frontend"]').click();
        cy.get('[data-testid="simple-agent-card-frontend"]')
            .contains('Cursor Settings').should('exist');
    });
});
