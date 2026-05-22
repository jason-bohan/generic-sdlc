import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '../dashboard/types';
import { devopsWrapUpAttentionCount, openWrapUpRequestCount, wrapUpDeskRequestId } from '../dashboard/types';

function minimalStatus(partial: Partial<AgentStatus>): AgentStatus {
    return {
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
    };
}

describe('openWrapUpRequestCount', () => {
    it('counts story-scoped WRAPUP ids', () => {
        const s = minimalStatus({
            requests: [
                { id: 'WRAPUP-B-17021-PR-5006', type: 'build', source: 'sdlc-framework', summary: 'x', status: 'open', createdAt: 't', storyNumber: 'B-17021' },
            ],
        });
        expect(openWrapUpRequestCount(s)).toBe(1);
    });

    it('counts open WRAPUP rows', () => {
        const s = minimalStatus({
            requests: [
                { id: 'WRAPUP-PR-12', type: 'build', source: 'sdlc-framework', summary: 'x', status: 'open', createdAt: 't' },
            ],
        });
        expect(openWrapUpRequestCount(s)).toBe(1);
    });

    it('ignores resolved WRAPUP rows', () => {
        const s = minimalStatus({
            requests: [
                { id: 'WRAPUP-PR-12', type: 'build', source: 'sdlc-framework', summary: 'x', status: 'resolved', createdAt: 't' },
            ],
        });
        expect(openWrapUpRequestCount(s)).toBe(0);
    });
});

describe('devopsWrapUpAttentionCount', () => {
    it('returns 0 when phase is build-passed but no WRAPUP rows (wrap-up is shown on DevOps desk)', () => {
        const s = minimalStatus({ currentPhase: 'build-passed', requests: [] });
        expect(devopsWrapUpAttentionCount(s)).toBe(0);
    });

    it('uses request count when multiple WRAPUP rows are open', () => {
        const s = minimalStatus({
            currentPhase: 'idle',
            requests: [
                { id: 'WRAPUP-PR-1', type: 'build', source: 'sdlc-framework', summary: 'a', status: 'open', createdAt: 't' },
                { id: 'WRAPUP-PR-2', type: 'build', source: 'sdlc-framework', summary: 'b', status: 'open', createdAt: 't' },
            ],
        });
        expect(devopsWrapUpAttentionCount(s)).toBe(2);
    });
});

describe('wrapUpDeskRequestId', () => {
    it('matches server handoff: story slug and PR id', () => {
        expect(wrapUpDeskRequestId('B-17021', 5006)).toBe('WRAPUP-B-17021-PR-5006');
        expect(wrapUpDeskRequestId(null, 12)).toBe('WRAPUP-PR-12');
    });
});
