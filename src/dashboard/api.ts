const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export function fetchAgentStatus(agentId: string) {
    return fetch(`/api/status?agentId=${encodeURIComponent(agentId)}`);
}

export function fetchModels() {
    return fetch('/api/agent/models');
}

export function fetchAgentModel(agentId: string) {
    return fetch(`/api/agent/model/${encodeURIComponent(agentId)}`);
}

export function postAgentModel(agentId: string, model: string) {
    return fetch('/api/agent/model', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ agentId, model }),
    });
}

/**
 * POST /api/agent/continue — optional fields (e.g. selectedTaskIds, selectedRequestIds, phaseHint) are merged into the body.
 */
export function postContinue(agentId: string, options?: Record<string, unknown>) {
    return fetch('/api/agent/continue', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ agentId, ...(options ?? {}) }),
    });
}

/**
 * POST /api/agent/step-mode — pass either `{ stepMode: boolean }` or `{ enabled: boolean }` (server accepts both shapes in different flows).
 */
export function postStepMode(agentId: string, mode: { stepMode?: boolean; enabled?: boolean }) {
    return fetch('/api/agent/step-mode', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ agentId, ...mode }),
    });
}

export function fetchAgentStepMode(agentId: string) {
    return fetch(`/api/agent/step-mode/${encodeURIComponent(agentId)}`);
}

export function fetchChatMessages(agentId: string) {
    return fetch(`/api/chat/messages?agentId=${encodeURIComponent(agentId)}`);
}

export function postChat(agentId: string, message: unknown) {
    return fetch('/api/chat', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ agentId, message }),
    });
}

export function fetchDisplayNames() {
    return fetch('/api/agent/display-names');
}

export function fetchExternalMode() {
    return fetch('/api/external-mode');
}

export function putExternalMode(mode: string) {
    return fetch('/api/external-mode', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ mode }),
    });
}

export function fetchGlobalStepMode() {
    return fetch('/api/agent/step-mode/global');
}

export function postGlobalStepMode(globalStepMode: boolean) {
    return fetch('/api/agent/step-mode/global', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ globalStepMode }),
    });
}

export function fetchExecutionMode() {
    return fetch('/api/execution-mode');
}

export function putExecutionMode(mode: string) {
    return fetch('/api/execution-mode', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ mode }),
    });
}

export function fetchTokenLedger(storyNumber?: string) {
    const q = storyNumber ? `?story=${encodeURIComponent(storyNumber)}` : '';
    return fetch(`/api/tokens/ledger${q}`);
}

export function fetchActiveProject() {
    return fetch('/api/active-project');
}

export function putActiveProject(project: string) {
    return fetch('/api/active-project', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ project }),
    });
}

export function fetchTestResultsSummary() {
    return fetch('/api/test-results?summary=1');
}

export function fetchTestResultsForAgent(agentId: string, latest?: boolean) {
    const params = new URLSearchParams({ agentId });
    if (latest) params.set('latest', '1');
    return fetch(`/api/test-results?${params.toString()}`);
}

export function fetchAiQaScorecard() {
    return fetch('/api/aiqa/scorecard');
}

export function postAiQaSweep() {
    return fetch('/api/aiqa/sweep', { method: 'POST' });
}

export function postSchedulerApprove(agentId: string) {
    return fetch(`${window.location.origin}/api/scheduler/approve`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ agentId }),
    });
}

export function postPlanningTasksSync(agentId: string, storyNumber: string) {
    return fetch('/api/planning/tasks/sync', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ agentId, storyNumber }),
    });
}
