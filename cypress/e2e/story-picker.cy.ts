const API = Cypress.env('apiUrl') || 'http://localhost:3001';

describe('Story Picker', () => {
    afterEach(() => {
        cy.resetAgent('frontend');
    });

    it('shows Pick Up Story button when agent is idle', () => {
        cy.seedAgent('frontend', {
            currentPhase: 'idle',
            storyNumber: null,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-assign-frontend"]')
            .should('be.visible')
            .and('contain', 'Pick Up Story');
    });

    it('opens the story picker modal when Pick Up Story is clicked', () => {
        cy.intercept('GET', '/api/planning/teams', {
            body: { teams: [{ id: 'team-1', name: 'Fusion' }, { id: 'team-2', name: 'Platform' }] },
        }).as('getTeams');

        cy.intercept('GET', '/api/active-project', {
            body: { profile: { environments: [] } },
        }).as('getProject');

        cy.seedAgent('frontend', {
            currentPhase: 'idle',
            storyNumber: null,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-assign-frontend"]').click();
        cy.wait('@getTeams');
        cy.get('[role="dialog"]').should('be.visible');
        cy.contains('Pick Up Story for').should('be.visible');
    });

    it('displays team list from the API', () => {
        cy.intercept('GET', '/api/planning/teams', {
            body: { teams: [{ id: 'team-1', name: 'Fusion' }, { id: 'team-2', name: 'Platform' }] },
        }).as('getTeams');
        cy.intercept('GET', '/api/active-project', { body: { profile: {} } });

        cy.seedAgent('frontend', {
            currentPhase: 'idle',
            storyNumber: null,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-assign-frontend"]').click();
        cy.wait('@getTeams');
        cy.contains('Fusion').should('be.visible');
        cy.contains('Platform').should('be.visible');
    });

    it('navigates to stories list when a team is selected', () => {
        cy.intercept('GET', '/api/planning/teams', {
            body: { teams: [{ id: 'team-1', name: 'Fusion' }] },
        });
        cy.intercept('GET', '/api/active-project', { body: { profile: {} } });
        cy.intercept('GET', '/api/planning/stories?team=Fusion', {
            body: {
                stories: [
                    { id: 's-1', number: 'B-17013', name: 'Add dark mode', status: 'Ready', team: 'Fusion', estimate: 5, priority: 'High' },
                    { id: 's-2', number: 'B-17014', name: 'Fix login bug', status: 'Ready', team: 'Fusion', estimate: 3, priority: 'Medium' },
                ],
            },
        }).as('getStories');

        cy.seedAgent('frontend', {
            currentPhase: 'idle',
            storyNumber: null,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-assign-frontend"]').click();
        cy.contains('Fusion').click();
        cy.wait('@getStories');

        cy.contains('B-17013').should('be.visible');
        cy.contains('Add dark mode').should('be.visible');
        cy.contains('B-17014').should('be.visible');
    });

    it('shows story detail and Assign button when a story is selected', () => {
        cy.intercept('GET', '/api/planning/teams', {
            body: { teams: [{ id: 'team-1', name: 'Fusion' }] },
        });
        cy.intercept('GET', '/api/active-project', { body: { profile: {} } });
        cy.intercept('GET', '/api/planning/stories?team=Fusion', {
            body: {
                stories: [
                    { id: 's-1', number: 'B-17013', name: 'Add dark mode', status: 'Ready', team: 'Fusion', estimate: 5, priority: 'High' },
                ],
            },
        });
        cy.intercept('GET', '/api/planning/story?number=B-17013', {
            body: {
                id: 's-1',
                number: 'B-17013',
                name: 'Add dark mode toggle',
                description: '<p>Allow users to toggle dark mode</p>',
                status: 'Ready',
                team: 'Fusion',
                estimate: 5,
                priority: 'High',
                classOfService: 'Standard',
                acceptanceCriteria: '<ul><li>Toggle visible in settings</li></ul>',
                frontend: '<p>Build the toggle component</p>',
                backend: '',
                qa: '<p>Write Cypress tests</p>',
                project: 'YourProject',
                url: 'https://example.com/story/B-17013',
            },
        }).as('getDetail');

        cy.seedAgent('frontend', {
            currentPhase: 'idle',
            storyNumber: null,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-assign-frontend"]').click();
        cy.contains('Fusion').click();
        cy.contains('B-17013').click();
        cy.wait('@getDetail');

        cy.contains('Add dark mode toggle').should('be.visible');
        cy.contains('Description').should('be.visible');
        cy.contains('Assign to').should('be.visible');
    });

    it('calls /api/scheduler/assign when Assign button is clicked', () => {
        cy.intercept('GET', '/api/planning/teams', { body: { teams: [{ id: 't1', name: 'Fusion' }] } });
        cy.intercept('GET', '/api/active-project', { body: { profile: {} } });
        cy.intercept('GET', '/api/planning/stories?team=Fusion', {
            body: { stories: [{ id: 's-1', number: 'B-17013', name: 'Add dark mode', status: 'Ready', team: 'Fusion', estimate: 5, priority: 'High' }] },
        });
        cy.intercept('GET', '/api/planning/story?number=B-17013', {
            body: {
                id: 's-1', number: 'B-17013', name: 'Add dark mode', description: '', status: 'Ready',
                team: 'Fusion', estimate: 5, priority: 'High', classOfService: 'Standard',
                acceptanceCriteria: '', frontend: '', backend: '', qa: '', project: 'YourProject',
                url: '',
            },
        });
        cy.intercept('POST', '/api/scheduler/assign', (req) => {
            req.reply({ ok: true });
        }).as('assignStory');

        cy.seedAgent('frontend', {
            currentPhase: 'idle',
            storyNumber: null,
            tasks: [],
            events: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        });

        cy.reload();
        cy.get('[data-testid="simple-agent-assign-frontend"]').click();
        cy.contains('Fusion').click();
        cy.contains('B-17013').click();
        cy.contains('Assign to').click();

        cy.wait('@assignStory').its('request.body').should((body) => {
            expect(body.agentId).to.eq('frontend');
            expect(body.storyNumber).to.eq('B-17013');
            expect(body.storyName).to.eq('Add dark mode');
        });
    });

    it('hides Pick Up Story when agent is in an active phase', () => {
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
        cy.get('[data-testid="simple-agent-assign-frontend"]').should('not.exist');
    });
});
