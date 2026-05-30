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

export function fetchAiQaEval() {
    return fetch('/api/aiqa/eval');
}

export function fetchAiQaDatasets() {
    return fetch('/api/aiqa/eval/datasets');
}

export function fetchAiQaHallucinations() {
    return fetch('/api/aiqa/hallucinations');
}

export function fetchAiQaRedTeam() {
    return fetch('/api/aiqa/redteam');
}

export function postAiQaRedTeamRun() {
    return fetch('/api/aiqa/redteam/run', { method: 'POST' });
}

export function postAiQaSemanticEval(body: { expected: string; actual: string; threshold?: number }) {
    return fetch('/api/aiqa/eval/semantic', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaJudgeEval(body: { agentOutput: string; expectedBehavior: string; criteria?: Array<{ name: string; description: string; weight: number }> }) {
    return fetch('/api/aiqa/eval/judge', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaDrift(body: { baseline: Array<{ values: number[] }>; current: Array<{ values: number[] }>; metricLabels?: string[] }) {
    return fetch('/api/aiqa/drift', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaSchemaCheck(body: { records: Record<string, unknown>[]; schema: Array<{ name: string; type: string; required: boolean }> }) {
    return fetch('/api/aiqa/drift/schema', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaConfidenceShift(body: { baseline: Array<Record<string, unknown>>; current: Array<Record<string, unknown>>; field?: string }) {
    return fetch('/api/aiqa/confidence', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaSilentFailure(body: { entries: Array<Record<string, unknown>>; field?: string }) {
    return fetch('/api/aiqa/confidence/silent-failure', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaOod(body: { count?: number }) {
    return fetch('/api/aiqa/ood', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaStratified(body: { samplePerStratum?: number }) {
    return fetch('/api/aiqa/stratified', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function fetchAiQaRiskMetrics() {
    return fetch('/api/aiqa/risk-metrics');
}

export function postAiQaRiskEvaluate(body: { truePositives: number; falsePositives: number; trueNegatives: number; falseNegatives: number; domain: string }) {
    return fetch('/api/aiqa/risk-metrics/evaluate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaBiasTest(body: { groups: Array<{ label: string; approved: number; total: number }> }) {
    return fetch('/api/aiqa/bias', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaIntersectionalBias(body: { groups: Array<{ label: string; approved: number; total: number }> }) {
    return fetch('/api/aiqa/bias/intersectional', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function postAiQaGuardrails(body: { output: string }) {
    return fetch('/api/aiqa/guardrails', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
}

export function fetchAiQaGuardrailPrompts() {
    return fetch('/api/aiqa/guardrails/prompts');
}

export function postAiQaSchemaValidation(body: { output: string; schema: Record<string, string> }) {
    return fetch('/api/aiqa/guardrails/schema', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    });
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

export function fetchDemoMode() {
    return fetch('/api/demo-mode');
}

export function putDemoMode(mode: string) {
    return fetch('/api/demo-mode', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ mode }),
    });
}
