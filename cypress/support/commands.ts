const API = Cypress.env('apiUrl') || 'http://localhost:3001';

const REQUEST_TIMEOUT_MS = 30000;

const idleStatus: Record<string, unknown> = {
    storyNumber: null,
    storyName: null,
    currentPhase: 'idle',
    currentTask: null,
    startedAt: null,
    tasks: [],
    requests: [],
    tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
    prs: [],
    cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
    events: [],
    handoffDispatched: false,
};

function writeAgentStatus(agentId: string, status: Record<string, unknown>): void {
    cy.request({
        method: 'POST',
        url: `${API}/api/agent/write-status`,
        body: { agentId, status },
        timeout: REQUEST_TIMEOUT_MS,
        retryOnNetworkFailure: true,
        failOnStatusCode: false,
    }).then((res) => {
        if (res.status >= 200 && res.status < 300) return;
        const detail = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        throw new Error(
            `POST ${API}/api/agent/write-status -> ${res.status}: ${detail.slice(0, 300)}. `
            + 'E2E requires mock API (bin/ci-e2e.sh / bin/docker-test.ps1 sets CYPRESS_API_URL to the Docker server).',
        );
    });
}

Cypress.Commands.add('seedAgent', (agentId: string, status: Record<string, unknown>) => {
    writeAgentStatus(agentId, status);
});

Cypress.Commands.add('resetAgent', (agentId: string) => {
    writeAgentStatus(agentId, idleStatus);
});

Cypress.Commands.add('setGlobalStepMode', (enabled: boolean) => {
    cy.request('POST', `${API}/api/agent/step-mode/global`, { globalStepMode: enabled });
});

Cypress.Commands.add('setAgentStepMode', (agentId: string, enabled: boolean) => {
    cy.request('POST', `${API}/api/agent/step-mode`, { agentId, stepMode: enabled });
});

Cypress.Commands.add('openDesk', (agentId: string) => {
    cy.get(`[data-testid="simple-agent-open-${agentId}"]`).click();
});

Cypress.Commands.add('apiUrl', () => API);
