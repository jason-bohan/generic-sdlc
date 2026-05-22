import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '../dashboard/types';
import { collectHeaderOpenPullRequests, reviewerCompletedPrIds } from '../dashboard/types';

const baseStatus = (partial: Partial<AgentStatus>): AgentStatus => ({
    storyNumber: null,
    storyName: null,
    currentPhase: 'idle',
    currentTask: null,
    startedAt: null,
    tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
    tasks: [],
    prs: [],
    cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
    events: [],
    ...partial,
});

describe('collectHeaderOpenPullRequests', () => {
    it('excludes PRs Brehon marks completed even if DevOps still has active', () => {
        const agentStatuses: Record<string, AgentStatus | null> = {
            reviewer: baseStatus({
                currentPhase: 'idle',
                prs: [
                    { id: 5006, title: 'Step toggle', status: 'completed', comments: 0, approvals: 0 },
                    { id: 5001, title: 'Audit trail', status: 'active', comments: 0, approvals: 0 },
                ],
            }),
            devops: baseStatus({
                currentPhase: 'build-passed',
                prs: [{ id: 5006, title: 'Step toggle', status: 'active', comments: 0, approvals: 0 }],
            }),
            frontend: null,
            backend: null,
            qa: null,
            ux: null,
        };
        const open = collectHeaderOpenPullRequests(agentStatuses, {});
        expect(open.map((p) => p.id)).toEqual([5001]);
        expect(reviewerCompletedPrIds(agentStatuses)).toEqual(new Set([5006]));
    });
});
