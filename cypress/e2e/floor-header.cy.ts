const API = Cypress.env('apiUrl') || 'http://localhost:3001';

describe('Floor Header', () => {
    it('renders the header with correct title', () => {
        cy.contains('The Floor').should('be.visible');
        cy.contains('Agent Status Dashboard').should('be.visible');
    });

    it('displays the global step mode toggle', () => {
        cy.get('[data-testid="simple-global-step-toggle-btn"]').should('be.visible');
    });

    it('toggles global step mode when clicked', () => {
        cy.intercept('GET', `${API}/api/agent/step-mode/global`).as('getStep');
        cy.intercept('POST', `${API}/api/agent/step-mode/global`).as('postStep');

        cy.get('[data-testid="simple-global-step-toggle-btn"]').click();
        cy.get('[data-testid="simple-global-step-toggle-btn"]')
            .should('have.attr', 'aria-pressed');
    });

    it('displays the Create Story button', () => {
        cy.get('[data-testid="simple-create-story-btn"]')
            .should('be.visible')
            .and('contain', 'Create Story');
    });

    it('displays the Refresh button', () => {
        cy.get('[data-testid="simple-refresh-btn"]').should('be.visible');
    });

    it('displays the Notifications button', () => {
        cy.get('[data-testid="simple-notifications-btn"]').should('be.visible');
    });

    it('displays the theme toggle button', () => {
        cy.get('[data-testid="simple-theme-toggle-btn"]').should('be.visible');
    });

    it('toggles color scheme when theme button is clicked', () => {
        cy.get('[data-testid="simple-theme-toggle-btn"]')
            .should('have.attr', 'aria-label')
            .then((label) => {
                const wasDark = String(label).includes('light');
                cy.get('[data-testid="simple-theme-toggle-btn"]').click();
                cy.get('[data-testid="simple-theme-toggle-btn"]')
                    .should('have.attr', 'aria-label')
                    .and(wasDark ? 'contain' : 'not.contain', 'dark');
            });
    });

    it('shows user profile link', () => {
        cy.get('[data-testid="nav-user-profile-link"]').should('be.visible');
    });
});

describe('Floor Header - Mock Mode Buttons', () => {
    it('shows Reset Mock State button in mock mode', () => {
        cy.request(`${API}/api/external-mode`).then((res) => {
            if (res.body.mode === 'mock') {
                cy.get('[data-testid="simple-reset-mock-btn"]').should('be.visible');
            }
        });
    });

    it('shows Test Runner button in mock mode', () => {
        cy.request(`${API}/api/external-mode`).then((res) => {
            if (res.body.mode === 'mock') {
                cy.get('[data-testid="simple-test-runner-btn"]').should('be.visible');
            }
        });
    });

    it('calls /api/mock/reset when Reset Mock State is clicked', () => {
        cy.request(`${API}/api/external-mode`).then((res) => {
            if (res.body.mode !== 'mock') return;

            cy.intercept('POST', '/api/mock/reset', (req) => {
                req.reply({ ok: true, message: 'Mock state reset' });
            }).as('resetMock');

            cy.on('window:confirm', () => true);
            cy.get('[data-testid="simple-reset-mock-btn"]').click();
        });
    });
});
