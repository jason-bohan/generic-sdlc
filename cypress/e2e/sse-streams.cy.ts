/**
 * SSE stream tests.
 *
 * EventSource connects directly to the API server (bypassing the Vite proxy,
 * which buffers streaming responses). The API URL comes from Cypress.env('apiUrl').
 *
 * These tests verify that the server pushes status and chat events over SSE
 * and that the /api/agent/write-status endpoint triggers an immediate push.
 */

const API = Cypress.env('apiUrl') || 'http://localhost:3001';

// ── /api/status/stream ───────────────────────────────────────────────────────

describe('SSE status stream', () => {
    it('delivers initial snapshot for all six agents within 5s', () => {
        const expected = ['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops'];

        cy.window().then((win) => {
            return new Cypress.Promise<string[]>((resolve, reject) => {
                const received = new Set<string>();
                const es = new win.EventSource(`${API}/api/status/stream?agentId=all`);
                const t = win.setTimeout(() => {
                    es.close();
                    reject(new Error(`Only got agents: ${[...received].join(', ')} (expected all six)`));
                }, 5000);

                es.onmessage = (e) => {
                    try {
                        const ev = JSON.parse(e.data);
                        if (ev.agentId) received.add(ev.agentId);
                        if (expected.every((id) => received.has(id))) {
                            win.clearTimeout(t);
                            es.close();
                            resolve([...received]);
                        }
                    } catch { /* skip */ }
                };

                es.onerror = () => {
                    win.clearTimeout(t);
                    es.close();
                    reject(new Error(`SSE connection error — is the API server running at ${API}?`));
                };
            });
        }).then((agents) => {
            expect(agents).to.include.members(expected);
        });
    });

    it('snapshot events contain currentPhase and isRunning', () => {
        cy.window().then((win) => {
            return new Cypress.Promise<Record<string, unknown>>((resolve, reject) => {
                const es = new win.EventSource(`${API}/api/status/stream?agentId=frontend`);
                const t = win.setTimeout(() => { es.close(); reject(new Error('No snapshot event received within 5s')); }, 5000);

                es.onmessage = (e) => {
                    win.clearTimeout(t);
                    es.close();
                    try { resolve(JSON.parse(e.data)); } catch { reject(new Error('Bad JSON in SSE event')); }
                };

                es.onerror = () => {
                    win.clearTimeout(t);
                    es.close();
                    reject(new Error(`SSE connection error — is the API server running at ${API}?`));
                };
            });
        }).then((ev: Record<string, unknown>) => {
            expect(ev).to.have.property('agentId', 'frontend');
            expect(ev).to.have.nested.property('status.currentPhase');
            expect(ev).to.have.nested.property('status.isRunning');
        });
    });

    it('pushes updated status when write-status API is called', () => {
        const sseStatusPayload = {
            currentPhase: 'sse-cypress-test',
            tasks: [],
            events: [],
            requests: [],
            prs: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        };

        cy.window().then((win) => {
            (win as unknown as { __sseStatusPush?: Cypress.Promise<Record<string, unknown>> }).__sseStatusPush =
                new Cypress.Promise<Record<string, unknown>>((resolve, reject) => {
                    const es = new win.EventSource(`${API}/api/status/stream?agentId=frontend`);
                    let seenInit = false;
                    const t = win.setTimeout(() => {
                        es.close();
                        reject(new Error('No push received within 8s after write-status'));
                    }, 8000);

                    es.onmessage = (e) => {
                        if (!seenInit) { seenInit = true; return; }
                        win.clearTimeout(t);
                        es.close();
                        try { resolve(JSON.parse(e.data)); } catch { reject(new Error('Bad JSON')); }
                    };

                    es.onerror = () => {
                        win.clearTimeout(t);
                        es.close();
                        reject(new Error(`SSE connection error — is the API server running at ${API}?`));
                    };
                });
        });

        cy.wait(500);
        cy.request({
            method: 'POST',
            url: `${API}/api/agent/write-status`,
            body: { agentId: 'frontend', status: sseStatusPayload },
        });

        cy.window().then((win) => {
            const pending = (win as unknown as { __sseStatusPush?: Cypress.Promise<Record<string, unknown>> }).__sseStatusPush;
            if (!pending) throw new Error('SSE listener not initialized');
            return pending;
        }).then((ev: Record<string, unknown>) => {
            expect(ev).to.have.property('agentId', 'frontend');
        });

        cy.request({
            method: 'POST',
            url: `${API}/api/agent/write-status`,
            body: {
                agentId: 'frontend',
                status: {
                    currentPhase: 'idle',
                    tasks: [],
                    events: [],
                    requests: [],
                    prs: [],
                    tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
                    cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
                },
            },
            failOnStatusCode: false,
        });
    });
});

// ── /api/chat/stream ─────────────────────────────────────────────────────────

describe('SSE chat stream', () => {
    it('seeds recent messages on connect after a message is posted', () => {
        cy.request({
            method: 'POST',
            url: `${API}/api/chat`,
            body: {
                agentId: 'frontend',
                message: {
                    id: `sse-seed-${Date.now()}`,
                    from: 'user',
                    message: 'SSE seed check',
                    timestamp: new Date().toISOString(),
                },
            },
            failOnStatusCode: false,
        });

        cy.window().then((win) => {
            return new Cypress.Promise<Record<string, unknown>>((resolve, reject) => {
                const es = new win.EventSource(`${API}/api/chat/stream?agentId=frontend`);
                const t = win.setTimeout(() => { es.close(); reject(new Error('No chat seed event received within 5s')); }, 5000);

                es.onmessage = (e) => {
                    win.clearTimeout(t);
                    es.close();
                    try { resolve(JSON.parse(e.data)); } catch { reject(new Error('Bad JSON')); }
                };

                es.onerror = () => {
                    win.clearTimeout(t);
                    es.close();
                    reject(new Error(`SSE connection error — is the API server running at ${API}?`));
                };
            });
        }).then((ev: Record<string, unknown>) => {
            expect(ev).to.have.property('agentId', 'frontend');
            expect(ev).to.have.property('message');
        });
    });

    it('pushes new message immediately after POST /api/chat', () => {
        const msgId = `sse-live-${Date.now()}`;
        const chatBody = {
            agentId: 'frontend',
            message: {
                id: msgId,
                from: 'user',
                message: 'live SSE push test',
                timestamp: new Date().toISOString(),
            },
        };

        cy.window().then((win) => {
            (win as unknown as { __sseChatPush?: Cypress.Promise<Record<string, unknown>> }).__sseChatPush =
                new Cypress.Promise<Record<string, unknown>>((resolve, reject) => {
                    const es = new win.EventSource(`${API}/api/chat/stream?agentId=frontend`);
                    const t = win.setTimeout(() => {
                        es.close();
                        reject(new Error('Live message not received within 8s'));
                    }, 8000);
                    const seenIds = new Set<string>();

                    es.onmessage = (e) => {
                        try {
                            const ev = JSON.parse(e.data) as { agentId: string; message: { id: string } };
                            seenIds.add(ev.message?.id);
                            if (seenIds.has(msgId)) {
                                win.clearTimeout(t);
                                es.close();
                                resolve(ev as unknown as Record<string, unknown>);
                            }
                        } catch { /* skip */ }
                    };

                    es.onerror = () => {
                        win.clearTimeout(t);
                        es.close();
                        reject(new Error(`SSE connection error — is the API server running at ${API}?`));
                    };
                });
        });

        cy.wait(500);
        cy.request({ method: 'POST', url: `${API}/api/chat`, body: chatBody });

        cy.window().then((win) => {
            const pending = (win as unknown as { __sseChatPush?: Cypress.Promise<Record<string, unknown>> }).__sseChatPush;
            if (!pending) throw new Error('SSE listener not initialized');
            return pending;
        }).then((ev: Record<string, unknown>) => {
            expect(ev).to.have.property('agentId', 'frontend');
            const msg = ev.message as { id: string };
            expect(msg.id).to.eq(msgId);
        });
    });
});
