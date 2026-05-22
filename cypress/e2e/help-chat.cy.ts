const API = Cypress.env('apiUrl') || 'http://localhost:3001';

describe('Help Chat API (/api/help/chat)', () => {
    it('rejects GET with 405', () => {
        cy.request({ url: `${API}/api/help/chat`, failOnStatusCode: false })
            .then((res) => {
                expect(res.status).to.eq(405);
                expect(res.body).to.have.property('error');
            });
    });

    it('rejects empty message with 400', () => {
        cy.request({
            method: 'POST',
            url: `${API}/api/help/chat`,
            body: { message: '' },
            failOnStatusCode: false,
        }).then((res) => {
            expect(res.status).to.eq(400);
        });
    });

    it('returns 200 with answer + source for a valid question', () => {
        cy.request({
            method: 'POST',
            url: `${API}/api/help/chat`,
            body: { message: 'what is step mode?', history: [] },
            timeout: 120_000,   // Ollama cold-start can be slow
        }).then((res) => {
            expect(res.status).to.eq(200);
            expect(res.body).to.have.property('answer').that.is.a('string').and.have.length.greaterThan(0);
            expect(res.body).to.have.property('source');
            expect(['kb', 'ollama', 'driver', 'offline']).to.include(res.body.source);
        });
    });

    it('accepts multi-turn history', () => {
        cy.request({
            method: 'POST',
            url: `${API}/api/help/chat`,
            body: {
                message: 'how do I advance past a paused step?',
                history: [
                    { role: 'user', content: 'what is step mode?' },
                    { role: 'assistant', content: 'Step mode pauses agents at phase checkpoints.' },
                ],
            },
            timeout: 120_000,
        }).then((res) => {
            expect(res.status).to.eq(200);
            expect(res.body.answer).to.be.a('string');
        });
    });
});
