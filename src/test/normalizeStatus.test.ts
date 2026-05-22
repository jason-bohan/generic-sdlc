import { describe, it, expect } from 'vitest';
import { normalizeStatus as normalizeServerStatus } from '../server/status-normalize';

/**
 * Mirror of the normalizeStatus and getDefaultStatus functions from vite.config.ts.
 * Kept in sync manually — if these tests fail after a vite.config change, update both.
 */
function getDefaultStatus() {
    return {
        storyNumber: null,
        storyName: null,
        storyDescription: null,
        currentPhase: 'idle',
        currentTask: null,
        startedAt: null,
        tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
        tasks: [],
        prs: [],
        requests: [],
        cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        events: [],
    };
}

function normalizeStatus(raw: any, agentId: string) {
    const defaults = getDefaultStatus();
    const assignedPRs = raw.assignedPR
        ? [{ id: raw.assignedPR.id, title: raw.assignedPR.title, status: 'active', url: raw.assignedPR.url }]
        : [];
    if (raw.storyNumber !== undefined || raw.tasks !== undefined) {
        let mergedPrs = (raw.prs && raw.prs.length > 0) ? raw.prs : assignedPRs;
        let tasks = (raw.tasks ?? []).map((t: any) => ({
            ...t,
            id: t.id ?? t.number ?? '',
            number: t.number ?? t.id,
            status: t.status === 'complete' ? 'completed' : (t.status ?? 'pending'),
        }));
        if (agentId === 'reviewer' && !raw.assignedPR) {
            const phase = String(raw.currentPhase ?? 'idle');
            if (phase === 'idle' || phase === 'complete' || phase === 'approved') {
                mergedPrs = [];
                tasks = tasks.map((t: Record<string, any>) => {
                    const tid = String(t.id ?? t.number ?? '');
                    const st = String(t.status ?? '');
                    if (tid.startsWith('PR-REVIEW-') && st !== 'completed' && st !== 'failed') {
                        return { ...t, status: 'completed' };
                    }
                    return t;
                });
            }
        }
        return {
            ...defaults,
            ...raw,
            tokens: raw.tokens ?? defaults.tokens,
            tasks,
            prs: mergedPrs,
            requests: raw.requests ?? [],
            cypress: raw.cypress ?? defaults.cypress,
            events: raw.events ?? [],
        };
    }
    const prs = assignedPRs;
    return {
        ...defaults,
        storyNumber: raw.assignedPR?.storyNumber || null,
        storyName: raw.assignedPR?.title || null,
        currentPhase: raw.currentPhase ?? 'idle',
        startedAt: raw.requestedAt ?? null,
        prs,
        requests: raw.requests ?? [],
        events: raw.events ?? [],
    };
}

describe('normalizeStatus', () => {
    it('passes through a complete Frontend-shaped status', () => {
        const frontendStatus = {
            storyNumber: 'B-16924',
            storyName: 'Fix floor',
            currentPhase: 'watching-reviews',
            currentTask: null,
            startedAt: '2026-05-01T16:00:00Z',
            tokens: { cloud: { input: 100, output: 50 }, meshllm: { input: 0, output: 0 }, ollama: { input: 10, output: 5 } },
            tasks: [{ number: 'TK-1', name: 'Do thing', status: 'complete' }],
            prs: [{ id: 123, title: 'PR', status: 'active', url: 'http://example.com' }],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
            events: [{ timestamp: '2026-05-01T16:00:00Z', type: 'info', message: 'Started' }],
        };
        const result = normalizeStatus(frontendStatus, 'frontend');
        expect(result.storyNumber).toBe('B-16924');
        expect(result.currentPhase).toBe('watching-reviews');
        expect(result.tokens.cloud.input).toBe(100);
        expect(result.tasks).toHaveLength(1);
        expect(result.prs).toHaveLength(1);
    });

    it('normalizes a Reviewer-shaped status into AgentStatus shape', () => {
        const reviewerStatus = {
            currentPhase: 'pending-review',
            assignedPR: {
                id: 57465,
                title: 'feat: floor patterns',
                url: 'https://dev.azure.com/pr/57465',
                storyNumber: 'B-16924',
                branch: 'feature/frontend/B-16924-floor-patterns',
            },
            requestedAt: '2026-05-01T16:56:00Z',
            events: [{ timestamp: '2026-05-01T16:56:00Z', type: 'info', message: 'Review requested' }],
        };
        const result = normalizeStatus(reviewerStatus, 'reviewer');

        expect(result.currentPhase).toBe('pending-review');
        expect(result.storyNumber).toBe('B-16924');
        expect(result.storyName).toBe('feat: floor patterns');
        expect(result.tokens).toEqual({ cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } });
        expect(result.tasks).toEqual([]);
        expect(result.prs).toHaveLength(1);
        expect(result.prs[0].id).toBe(57465);
        expect(result.prs[0].status).toBe('active');
        expect(result.cypress).toBeDefined();
        expect(result.cypress.failures).toEqual([]);
        expect(result.events).toHaveLength(1);
    });

    it('handles Reviewer status with no assigned PR (idle)', () => {
        const reviewerIdle = {
            currentPhase: 'idle',
            assignedPR: null,
            requestedAt: null,
            events: [],
        };
        const result = normalizeStatus(reviewerIdle, 'reviewer');

        expect(result.currentPhase).toBe('idle');
        expect(result.storyNumber).toBeNull();
        expect(result.storyName).toBeNull();
        expect(result.prs).toEqual([]);
        expect(result.tokens).toBeDefined();
        expect(result.tasks).toEqual([]);
    });

    it('Reviewer idle drops stale prs[] left by CLI after desk was cleared', () => {
        const raw = {
            currentPhase: 'idle',
            assignedPR: null,
            tasks: [],
            prs: [{ id: 5006, title: 'feat(B-17021): Step Toggle', status: 'active', url: 'http://localhost/mock-prs/5006' }],
            events: [],
        };
        const result = normalizeStatus(raw, 'reviewer');
        expect(result.prs).toEqual([]);
    });

    it('Reviewer idle marks stale PR-REVIEW-* tasks completed for dashboard Tasks pills', () => {
        const raw = {
            currentPhase: 'idle',
            assignedPR: null,
            tasks: [{ id: 'PR-REVIEW-5006', number: 'PR-REVIEW-5006', name: 'Review PR #5006', status: 'pending', hours: 1, category: 'Review' }],
            prs: [],
            events: [],
        };
        const result = normalizeStatus(raw, 'reviewer');
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].status).toBe('completed');
    });

    it('fills in missing fields on a partial Frontend agent status', () => {
        const partial = {
            storyNumber: 'B-100',
            currentPhase: 'idle',
        };
        const result = normalizeStatus(partial, 'frontend');

        expect(result.tokens).toEqual({ cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } });
        expect(result.tasks).toEqual([]);
        expect(result.prs).toEqual([]);
        expect(result.cypress.failures).toEqual([]);
        expect(result.events).toEqual([]);
    });

    it('preserves request items on both story and reviewer statuses', () => {
        const storyStatus = normalizeStatus({
            storyNumber: 'B-100',
            currentPhase: 'addressing-feedback',
            requests: [{ id: 'R-1', status: 'open' }],
        }, 'frontend');
        expect(storyStatus.requests).toEqual([{ id: 'R-1', status: 'open' }]);

        const reviewerStatus = normalizeStatus({
            currentPhase: 'addressing-feedback',
            assignedPR: { id: 1, title: 'PR', url: 'http://x', storyNumber: 'B-100' },
            requests: [{ id: 'R-2', status: 'open' }],
        }, 'reviewer');
        expect(reviewerStatus.requests).toEqual([{ id: 'R-2', status: 'open' }]);
    });

    it('does not treat empty storyNumber string as truthy', () => {
        const reviewerWithEmptyStory = {
            currentPhase: 'pending-review',
            assignedPR: { id: 1, title: 'PR', url: 'http://x', storyNumber: '', branch: 'b' },
            events: [],
        };
        const result = normalizeStatus(reviewerWithEmptyStory, 'reviewer');
        expect(result.storyNumber).toBeNull();
    });

    it('server normalization preserves pending tasks during partial PR phases', () => {
        const result = normalizeServerStatus({
            storyNumber: 'B-17004',
            currentPhase: 'watching-reviews',
            tasks: [
                { id: 'TK-1', number: 'TK-1', name: 'Selected task', status: 'completed' },
                { id: 'TK-2', number: 'TK-2', name: 'Later task', status: 'pending' },
            ],
            prs: [{ id: 42, title: 'PR #42', status: 'active' }],
        }, 'frontend', '');

        expect(result.tasks.find((t: any) => t.id === 'TK-1')?.status).toBe('completed');
        expect(result.tasks.find((t: any) => t.id === 'TK-2')?.status).toBe('pending');
    });
});
