describe('Dashboard (Simple Floor)', () => {
    it('loads the dashboard page', () => {
        cy.get('body').should('be.visible');
        cy.title().should('not.be.empty');
    });

    it('renders agent cards for all active agents', () => {
        const agents = ['frontend', 'qa', 'ux', 'reviewer', 'devops'];
        agents.forEach((agent) => {
            cy.get(`[data-testid="simple-agent-card-${agent}"]`).should('exist');
        });
    });

    it('displays the header stats bar', () => {
        cy.contains('Agents').should('be.visible');
        cy.contains('Tokens').should('be.visible');
    });

    it('shows agent names on cards', () => {
        cy.contains('Frontend').should('be.visible');
        cy.contains('QA').should('be.visible');
        cy.contains('Reviewer').should('be.visible');
    });

    it('has Open Desk buttons on each card', () => {
        cy.get('[data-testid^="simple-agent-open-"]').should('have.length.greaterThan', 0);
    });

    it('shows QA card as active (not greyed out)', () => {
        cy.get('[data-testid="simple-agent-card-qa"]')
            .should('have.css', 'opacity', '1');
    });
});
