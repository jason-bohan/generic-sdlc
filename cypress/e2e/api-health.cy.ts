describe('API Health', () => {
    const apiBase = Cypress.env('apiUrl') || 'http://localhost:3001';

    it('returns agent status for each agent', () => {
        const agents = ['frontend', 'reviewer', 'devops', 'ux', 'qa', 'backend'];
        agents.forEach((id) => {
            cy.request(`${apiBase}/api/status?agentId=${id}`).then((res) => {
                expect(res.status).to.eq(200);
                expect(res.body).to.have.property('currentPhase');
            });
        });
    });

    it('returns the model list', () => {
        cy.request(`${apiBase}/api/agent/models`).then((res) => {
            expect(res.status).to.eq(200);
            expect(res.body.models).to.be.an('array');
            expect(res.body.models.length).to.be.greaterThan(0);
            const auto = res.body.models.find((m: { id: string }) => m.id === 'auto');
            expect(auto).to.exist;
        });
    });

    it('returns execution mode', () => {
        cy.request(`${apiBase}/api/execution-mode`).then((res) => {
            expect(res.status).to.eq(200);
            expect(res.body).to.have.property('mode');
        });
    });

    it('returns active project', () => {
        cy.request(`${apiBase}/api/active-project`).then((res) => {
            expect(res.status).to.eq(200);
            expect(res.body).to.have.property('active');
        });
    });
});
