/** Matches live `/api/reviewer/prs` shape (hook splits desk vs available via deskUi.kind). */
function mockReviewerPrs(prs: unknown[]) {
    return { prs };
}

describe('Reviewer Desk Panel', () => {
    afterEach(() => {
        cy.resetAgent('reviewer');
    });

    it('opens the reviewer desk and shows empty state', () => {
        cy.intercept('GET', '/api/reviewer/prs', {
            body: mockReviewerPrs([]),
        }).as('getPrs');
        cy.intercept('GET', '/api/reviewer/auto-pick-config', {
            body: { autoPickPullRequests: false },
        });

        cy.openDesk('reviewer');

        cy.contains("Nothing on desk").should('be.visible');
    });

    it('displays PRs on the reviewer desk with correct badges', () => {
        cy.intercept('GET', '/api/reviewer/prs', {
            body: mockReviewerPrs([
                {
                    id: 101, title: 'Add user auth', status: 'active',
                    sourceBranch: 'feature/auth', targetBranch: 'main',
                    url: 'https://dev.azure.com/pr/101',
                    storyNumber: 'B-17013',
                    createdBy: { displayName: 'Lasair' },
                    deskUi: { kind: 'pending', commentCount: 0 },
                },
                {
                    id: 102, title: 'Fix null check', status: 'active',
                    sourceBranch: 'fix/null-check', targetBranch: 'main',
                    url: 'https://dev.azure.com/pr/102',
                    storyNumber: 'B-17014',
                    createdBy: { displayName: 'Cairn' },
                    deskUi: { kind: 'changes_on_desk', commentCount: 3 },
                },
            ]),
        }).as('getPrs');
        cy.intercept('GET', '/api/reviewer/auto-pick-config', { body: { autoPickPullRequests: false } });

        cy.openDesk('reviewer');

        cy.get('[data-testid="reviewer-pr-101"]').should('be.visible');
        cy.get('[data-testid="reviewer-pr-101"]').within(() => {
            cy.contains('#101').should('exist');
            cy.contains('Add user auth').should('exist');
            cy.contains('B-17013').should('exist');
        });

        cy.get('[data-testid="reviewer-pr-102"]').should('be.visible');
        cy.get('[data-testid="reviewer-desk-badge-102"]')
            .should('contain', 'Changes requested');
    });

    it('shows Start Review button for pending PRs when not running', () => {
        cy.intercept('GET', '/api/reviewer/prs', {
            body: mockReviewerPrs([
                {
                    id: 101, title: 'Add auth', status: 'active',
                    sourceBranch: 'feature/auth', targetBranch: 'main',
                    url: 'https://dev.azure.com/pr/101',
                    createdBy: { displayName: 'Lasair' },
                    deskUi: { kind: 'pending', commentCount: 0 },
                },
            ]),
        });
        cy.intercept('GET', '/api/reviewer/auto-pick-config', { body: { autoPickPullRequests: false } });

        cy.openDesk('reviewer');

        cy.get('[data-testid="reviewer-start-review-101"]')
            .should('be.visible')
            .and('contain', 'Start Review');
    });

    it('shows available PRs with Pick Up button', () => {
        cy.intercept('GET', '/api/reviewer/prs', {
            body: mockReviewerPrs([
                {
                    id: 201, title: 'Update dashboard', status: 'active',
                    sourceBranch: 'teams/update-dash', targetBranch: 'main',
                    url: 'https://dev.azure.com/pr/201',
                    createdBy: { displayName: 'Dev Team' },
                    deskUi: { kind: 'none', commentCount: 0 },
                    reviewerPickupEligible: true,
                },
            ]),
        });
        cy.intercept('GET', '/api/reviewer/auto-pick-config', { body: { autoPickPullRequests: false } });

        cy.openDesk('reviewer');

        cy.get('[data-testid="reviewer-pick-pr-201"]')
            .should('be.visible')
            .and('contain', 'Pick Up');
    });

    it('calls pick-pr endpoint when Pick Up is clicked', () => {
        cy.intercept('GET', '/api/reviewer/prs', {
            body: mockReviewerPrs([
                {
                    id: 201, title: 'Update dashboard', status: 'active',
                    sourceBranch: 'teams/dash', targetBranch: 'main',
                    url: 'https://dev.azure.com/pr/201',
                    createdBy: { displayName: 'Dev' },
                    deskUi: { kind: 'none', commentCount: 0 },
                    reviewerPickupEligible: true,
                },
            ]),
        });
        cy.intercept('GET', '/api/reviewer/auto-pick-config', { body: { autoPickPullRequests: false } });
        cy.intercept('POST', '/api/reviewer/pick-pr', (req) => {
            req.reply({ ok: true });
        }).as('pickPr');

        cy.openDesk('reviewer');
        cy.get('[data-testid="reviewer-pick-pr-201"]').click();

        cy.wait('@pickPr').its('request.body').should((body) => {
            expect(body.prId).to.eq(201);
        });
    });

    it('shows Approved badge for completed reviews', () => {
        cy.intercept('GET', '/api/reviewer/prs', {
            body: mockReviewerPrs([
                {
                    id: 103, title: 'Reviewed PR', status: 'active',
                    sourceBranch: 'feature/done', targetBranch: 'main',
                    url: 'https://dev.azure.com/pr/103',
                    createdBy: { displayName: 'Cairn' },
                    deskUi: { kind: 'approved_done', commentCount: 2 },
                },
            ]),
        });
        cy.intercept('GET', '/api/reviewer/auto-pick-config', { body: { autoPickPullRequests: false } });

        cy.openDesk('reviewer');

        cy.get('[data-testid="reviewer-desk-badge-103"]')
            .should('contain', 'Approved');
    });

    it('shows View feedback and Dismiss buttons for approved PRs', () => {
        cy.intercept('GET', '/api/reviewer/prs', {
            body: mockReviewerPrs([
                {
                    id: 103, title: 'Approved PR', status: 'active',
                    sourceBranch: 'feature/ok', targetBranch: 'main',
                    url: 'https://dev.azure.com/pr/103',
                    createdBy: { displayName: 'Lasair' },
                    deskUi: { kind: 'approved_done', commentCount: 1 },
                },
            ]),
        });
        cy.intercept('GET', '/api/reviewer/auto-pick-config', { body: { autoPickPullRequests: false } });

        cy.openDesk('reviewer');

        cy.get('[data-testid="reviewer-pr-103"]').within(() => {
            cy.contains('View feedback').should('be.visible');
            cy.contains('Dismiss').should('be.visible');
        });
    });
});
