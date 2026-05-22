import './commands';

Cypress.on('uncaught:exception', (_err) => false);

beforeEach(() => {
    // Force the Simple Floor view for all tests — headless Electron has no
    // persisted localStorage, so the dashboard defaults to Floor3D otherwise.
    cy.visit('/', {
        onBeforeLoad(win) {
            win.localStorage.setItem('sdlc-framework-theme-palette', 'simple');
        },
    });
});
