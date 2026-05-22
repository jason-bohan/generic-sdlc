/**
 * Shared JSON-shaped status payloads for API / handoff tests.
 */

export const minimalStatus = {
    storyNumber: 'B-17003',
    storyName: 'Implement dark mode',
    currentPhase: 'watching-reviews',
    tasks: [],
    prs: [{ id: 42, title: 'PR #42', status: 'active', comments: 0, approvals: 0 }],
    events: [],
    tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
    cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
} as const;

export const workingStatus = {
    storyNumber: 'B-99999',
    currentPhase: 'generating-code',
    lastSessionId: 'sess-abc-123',
    tasks: [
        { id: 'TK-1', number: 'TK-1', name: 'Task A', status: 'completed' },
        { id: 'TK-2', number: 'TK-2', name: 'Task B', status: 'in-progress' },
    ],
    events: [],
    tokens: { cloud: { input: 100, output: 200 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
} as const;

export const stoppedStatus = {
    storyNumber: 'B-99999',
    currentPhase: 'analyzing',
    handoffDispatched: true,
    tasks: [],
    events: [],
} as const;
