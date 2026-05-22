declare namespace Cypress {
    interface Chainable {
        /**
         * Seed an agent's status file via `/api/agent/write-status` (mock mode only).
         * @param agentId - e.g. 'frontend', 'reviewer', 'qa'
         * @param status - partial status object to write
         */
        seedAgent(agentId: string, status: Record<string, unknown>): Chainable<Cypress.Response<any>>;

        /**
         * Reset an agent to idle state (null story, empty tasks/events/prs).
         * @param agentId - e.g. 'frontend', 'reviewer', 'qa'
         */
        resetAgent(agentId: string): Chainable<Cypress.Response<any>>;

        /**
         * Toggle global step mode on or off via `/api/agent/step-mode/global`.
         */
        setGlobalStepMode(enabled: boolean): Chainable<Cypress.Response<any>>;

        /**
         * Toggle per-agent step mode via `/api/agent/step-mode`.
         */
        setAgentStepMode(agentId: string, enabled: boolean): Chainable<Cypress.Response<any>>;

        /**
         * Click the "Open Desk" button for an agent card.
         * @param agentId - e.g. 'frontend', 'reviewer'
         */
        openDesk(agentId: string): Chainable<JQuery<HTMLElement>>;

        /**
         * Returns the configured API URL (from Cypress.env('apiUrl') or default).
         */
        apiUrl(): string;
    }
}
