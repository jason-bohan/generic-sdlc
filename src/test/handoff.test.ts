import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { resolve } from 'path';
import { readJson, writeJson } from './helpers/server-harness';
import { findStoryOwnerByPrId, applyReviewComplete, applyBuildComplete, applyDesignReady } from '../server/handoff';

const TMP_DIR = resolve(__dirname, '.handoff-test-tmp');

function cleanupFile(filename: string) {
    const p = resolve(TMP_DIR, filename);
    if (existsSync(p)) unlinkSync(p);
}

beforeEach(() => {
    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
    for (const f of ['.frontend-status.json', '.devops-status.json', '.reviewer-status.json', '.ux-status.json', '.sdlc-framework.config.json']) {
        cleanupFile(f);
    }
    if (existsSync(resolve(TMP_DIR, '.sdlc-framework'))) {
        rmSync(resolve(TMP_DIR, '.sdlc-framework'), { recursive: true, force: true });
    }
});

describe('findStoryOwnerByPrId', () => {
    it('finds the agent that owns a PR', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-100',
            currentPhase: 'watching-reviews',
            prs: [{ id: 999, title: 'Test PR', status: 'active' }],
        });
        const result = findStoryOwnerByPrId(TMP_DIR, 999);
        expect(result).not.toBeNull();
        expect(result!.agentId).toBe('frontend');
    });

    it('returns null when no agent owns the PR', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-100',
            currentPhase: 'idle',
            prs: [{ id: 111, title: 'Other PR', status: 'active' }],
        });
        const result = findStoryOwnerByPrId(TMP_DIR, 999);
        expect(result).toBeNull();
    });

    it('finds PR across multiple agents', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            prs: [{ id: 100, status: 'active' }],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            prs: [{ id: 200, status: 'active' }],
        });
        expect(findStoryOwnerByPrId(TMP_DIR, 200)!.agentId).toBe('devops');
    });
});

describe('applyReviewComplete', () => {
    it('writes .devops-status.json on approved verdict', () => {
        const result = applyReviewComplete(TMP_DIR, {
            prId: 500,
            verdict: 'approved',
            storyNumber: 'B-200',
            branch: 'feat/test',
        });
        expect(result.ok).toBe(true);
        expect(result.target).toBe('devops');
        expect(result.targetPhase).toBe('pending-build');

        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect(devops.currentPhase).toBe('pending-build');
        expect(devops.assignedPR.id).toBe(500);
        expect(devops.assignedPR.storyNumber).toBe('B-200');
        expect(devops.assignedPR.branch).toBe('feat/test');
    });

    it('is idempotent — does not overwrite devops if already pending-build for same PR', () => {
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'pending-build',
            assignedPR: { id: 500 },
            events: [{ timestamp: 'first', type: 'info', message: 'original' }],
        });
        applyReviewComplete(TMP_DIR, { prId: 500, verdict: 'approved' });
        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect(devops.events[0].message).toBe('original');
    });

    it('updates story-owner PR status on changes-requested', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-300',
            currentPhase: 'watching-reviews',
            prs: [{ id: 600, title: 'My PR', status: 'active' }],
        });
        const result = applyReviewComplete(TMP_DIR, { prId: 600, verdict: 'changes-requested' });
        expect(result.ok).toBe(true);
        expect(result.target).toBe('frontend');
        expect(result.targetPhase).toBe('addressing-feedback');

        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.prs[0].status).toBe('changes-requested');
    });

    it('creates per-comment review requests when comments are provided', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-301',
            currentPhase: 'watching-reviews',
            prs: [{ id: 601, title: 'PR 601', status: 'active' }],
            requests: [],
        });
        applyReviewComplete(TMP_DIR, {
            prId: 601,
            verdict: 'changes-requested',
            comments: [
                { id: 'REQ-thread-1', summary: 'Fix null handling', file: 'src/a.ts', line: 10, severity: 'warning' },
                { summary: 'Add tests', file: 'src/b.ts', line: 2 },
            ],
        });
        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.requests).toHaveLength(2);
        expect(frontend.requests[0]).toMatchObject({
            id: 'REQ-thread-1',
            type: 'review',
            source: 'reviewer',
            summary: 'Fix null handling',
            file: 'src/a.ts',
            line: 10,
            status: 'open',
            prId: 601,
        });
        expect(frontend.requests[1]).toMatchObject({
            id: 'R-601-2',
            summary: 'Add tests',
            file: 'src/b.ts',
            line: 2,
            status: 'open',
        });
    });

    it('returns unknown target when no agent owns the PR', () => {
        const result = applyReviewComplete(TMP_DIR, { prId: 999, verdict: 'changes-requested' });
        expect(result.target).toBe('unknown');
    });

    it('reads PR title from reviewer status when available', () => {
        writeJson(resolve(TMP_DIR, '.reviewer-status.json'), {
            currentPhase: 'approved',
            assignedPR: { id: 700, title: 'Reviewer knows this title', url: 'https://example.com/pr/700' },
        });
        applyReviewComplete(TMP_DIR, { prId: 700, verdict: 'approved' });
        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect(devops.assignedPR.title).toBe('Reviewer knows this title');
        expect(devops.assignedPR.url).toBe('https://example.com/pr/700');
    });

    it('moves reviewer to watching-build after approved handoff (resets to idle after build completes)', () => {
        writeJson(resolve(TMP_DIR, '.reviewer-status.json'), {
            currentPhase: 'pending-review',
            assignedPR: { id: 800, title: 'Test PR', url: 'https://example.com/pr/800' },
            events: [{ timestamp: 'old', type: 'info', message: 'assigned' }],
        });
        applyReviewComplete(TMP_DIR, { prId: 800, verdict: 'approved' });
        const reviewer = readJson(resolve(TMP_DIR, '.reviewer-status.json'));
        expect(reviewer.currentPhase).toBe('watching-build');
        expect(reviewer.handoffDispatched).toBe(true);
        expect(reviewer.events.length).toBeGreaterThan(1);
    });

    it('resolves the open PR feedback request when reviewer approves', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-300',
            currentPhase: 'addressing-feedback',
            prs: [{ id: 601, title: 'My PR', status: 'changes-requested' }],
            requests: [
                { id: 'R-601-feedback', type: 'review', source: 'reviewer', summary: 'Address review comments for PR #601', status: 'open', prId: 601, createdAt: 't' },
            ],
        });

        applyReviewComplete(TMP_DIR, { prId: 601, verdict: 'approved' });

        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.requests[0].status).toBe('resolved');
        expect(frontend.requests[0].resolvedAt).toMatch(/^\d{4}-/);
    });
});

describe('applyBuildComplete', () => {
    it('sets story-owner PR to completed on passed', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-400',
            prs: [{ id: 800, status: 'active' }],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 800 },
            events: [],
        });

        const result = applyBuildComplete(TMP_DIR, { prId: 800, result: 'passed', buildId: 42 });
        expect(result.ok).toBe(true);
        expect(result.storyOwner).toBe('frontend');
        expect(result.newPrStatus).toBe('completed');

        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.prs[0].status).toBe('completed');
        expect(frontend.currentPhase).toBe('complete');
        expect(frontend.events[0].message).toContain('story complete');

        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect(devops.currentPhase).toBe('build-passed');
        expect(devops.events[0].message).toContain('#42');
        expect(devops.requests.some((r: { id: string }) => r.id === 'WRAPUP-B-400-PR-800')).toBe(true);
        expect(result.wrapUpRequestId).toBe('WRAPUP-B-400-PR-800');
    });

    it('sets story-owner PR to changes-requested on failed', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-400',
            prs: [{ id: 800, status: 'active' }],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            events: [],
        });

        const result = applyBuildComplete(TMP_DIR, { prId: 800, result: 'failed' });
        expect(result.newPrStatus).toBe('changes-requested');

        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.prs[0].status).toBe('changes-requested');
        expect(frontend.currentPhase).toBeUndefined();

        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect(devops.currentPhase).toBe('build-failed');
    });

    it('in mock external mode, marks mock ADO PR completed on pass so reviewer list drops it', () => {
        mkdirSync(resolve(TMP_DIR, '.sdlc-framework', 'mock'), { recursive: true });
        writeJson(resolve(TMP_DIR, '.sdlc-framework.config.json'), { externalMode: 'mock' });
        writeFileSync(
            resolve(TMP_DIR, '.sdlc-framework', 'mock', 'state.json'),
            JSON.stringify({
                prs: [{ pullRequestId: 800, id: 800, status: 'active', title: 'Test PR' }],
            }),
        );
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-400',
            prs: [{ id: 800, status: 'active' }],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 800 },
            events: [],
        });

        applyBuildComplete(TMP_DIR, { prId: 800, result: 'passed' });

        const mockState = JSON.parse(readFileSync(resolve(TMP_DIR, '.sdlc-framework', 'mock', 'state.json'), 'utf-8'));
        expect(mockState.prs[0].status).toBe('completed');
    });

    it('is idempotent — does not re-append events if phase already matches', () => {
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'build-passed',
            assignedPR: { id: 1 },
            events: [{ timestamp: 'x', type: 'success', message: 'already done' }],
        });
        applyBuildComplete(TMP_DIR, { prId: 999, result: 'passed' });
        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect(devops.events).toHaveLength(1);
    });

    it('adds wrap-up request on pass when DevOps desk has no assigned PR', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-400',
            prs: [{ id: 900, status: 'active' }],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            events: [],
        });

        applyBuildComplete(TMP_DIR, { prId: 900, result: 'passed', buildId: 1 });

        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect(devops.requests.some((r: { id: string }) => r.id === 'WRAPUP-B-400-PR-900')).toBe(true);
    });

    it('uses DevOps assignedPR story in wrap-up request id when present', () => {
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 5006, storyNumber: 'B-17021', title: 'feat: step toggle' },
            events: [],
        });
        applyBuildComplete(TMP_DIR, { prId: 5006, result: 'passed', buildId: 7015 });

        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        const row = devops.requests.find((r: { id: string }) => r.id === 'WRAPUP-B-17021-PR-5006');
        expect(row).toBeTruthy();
        expect(row.summary).toContain('B-17021');
        expect(row.storyNumber).toBe('B-17021');
    });

    it('uses WRAPUP-PR-{id} when story is unknown', () => {
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 111 },
            events: [],
        });
        applyBuildComplete(TMP_DIR, { prId: 111, result: 'passed' });

        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect(devops.requests.some((r: { id: string }) => r.id === 'WRAPUP-PR-111')).toBe(true);
    });

    it('does not add wrap-up when assigned PR id conflicts with build-complete prId', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-400',
            prs: [{ id: 999, status: 'active' }],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 800 },
            events: [],
        });

        applyBuildComplete(TMP_DIR, { prId: 999, result: 'passed' });

        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect((devops.requests ?? []).some((r: { id: string }) => String(r.id).includes('-PR-999'))).toBe(false);
    });

    it('does NOT mark story complete when tasks are still incomplete', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-500',
            currentPhase: 'watching-reviews',
            prs: [{ id: 800, status: 'active' }],
            tasks: [
                { id: 'TK-1', number: 'TK-1', name: 'Task 1', status: 'completed' },
                { id: 'TK-2', number: 'TK-2', name: 'Task 2', status: 'completed' },
                { id: 'TK-3', number: 'TK-3', name: 'Task 3', status: 'pending' },
            ],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 800 },
            events: [],
        });

        const result = applyBuildComplete(TMP_DIR, { prId: 800, result: 'passed', buildId: 1 });
        expect(result.ok).toBe(true);
        expect(result.hasIncompleteTasks).toBe(true);
        expect(result.incompleteTaskIds).toEqual(['TK-3']);

        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.currentPhase).toBe('reading-story');
        expect(frontend.events.some((e: { message: string }) => e.message.includes('task(s) remain'))).toBe(true);
    });

    it('completes only the PR batch task ids on build pass and returns step-mode owner to analyzing', () => {
        writeJson(resolve(TMP_DIR, '.sdlc-framework.config.json'), {
            scheduler: { agents: { frontend: { stepMode: true } } },
        });
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-501',
            currentPhase: 'watching-reviews',
            prs: [{ id: 803, status: 'active', batchTaskIds: ['TK-1', 'TK-2'] }],
            tasks: [
                { id: 'TK-1', number: 'TK-1', name: 'Task 1', status: 'in_progress' },
                { id: 'TK-2', number: 'TK-2', name: 'Task 2', status: 'in_progress' },
                { id: 'TK-3', number: 'TK-3', name: 'Task 3', status: 'pending' },
            ],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 803 },
            events: [],
        });

        const result = applyBuildComplete(TMP_DIR, { prId: 803, result: 'passed', buildId: 3 });
        expect(result.hasIncompleteTasks).toBe(true);
        expect(result.incompleteTaskIds).toEqual(['TK-3']);

        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.currentPhase).toBe('analyzing');
        expect(frontend.tasks.find((t: { id: string }) => t.id === 'TK-1').status).toBe('completed');
        expect(frontend.tasks.find((t: { id: string }) => t.id === 'TK-2').status).toBe('completed');
        expect(frontend.tasks.find((t: { id: string }) => t.id === 'TK-3').status).toBe('pending');

        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect((devops.requests ?? []).some((r: { id: string }) => String(r.id).includes('WRAPUP'))).toBe(false);
    });

    it('marks story complete when all tasks are completed', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-500',
            currentPhase: 'watching-reviews',
            prs: [{ id: 801, status: 'active' }],
            tasks: [
                { id: 'TK-1', number: 'TK-1', name: 'Task 1', status: 'completed' },
                { id: 'TK-2', number: 'TK-2', name: 'Task 2', status: 'completed' },
            ],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 801 },
            events: [],
        });

        const result = applyBuildComplete(TMP_DIR, { prId: 801, result: 'passed', buildId: 2 });
        expect(result.ok).toBe(true);
        expect(result.hasIncompleteTasks).toBeUndefined();

        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.currentPhase).toBe('complete');
        expect(frontend.events.some((e: { message: string }) => e.message.includes('story complete'))).toBe(true);
    });

    it('does not add wrap-up request when tasks are incomplete', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-600',
            prs: [{ id: 900, status: 'active' }],
            tasks: [
                { id: 'TK-1', number: 'TK-1', status: 'completed' },
                { id: 'TK-2', number: 'TK-2', status: 'pending' },
            ],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 900 },
            events: [],
        });

        applyBuildComplete(TMP_DIR, { prId: 900, result: 'passed', buildId: 1 });

        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        const wrapUpRequests = (devops.requests ?? []).filter((r: { id: string }) => String(r.id).includes('WRAPUP'));
        expect(wrapUpRequests).toHaveLength(0);
    });

    it('clears handoffDispatched when tasks are incomplete so agent can be re-spawned', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-500',
            currentPhase: 'watching-reviews',
            handoffDispatched: true,
            lastSessionId: 'sess-prev-123',
            prs: [{ id: 800, status: 'active' }],
            tasks: [
                { id: 'TK-1', number: 'TK-1', status: 'completed' },
                { id: 'TK-2', number: 'TK-2', status: 'pending' },
            ],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 800 },
            events: [],
        });

        applyBuildComplete(TMP_DIR, { prId: 800, result: 'passed', buildId: 1 });

        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.handoffDispatched).toBe(false);
        expect(frontend.lastSessionId).toBe('sess-prev-123');
        expect(frontend.currentPhase).toBe('reading-story');
    });

    it('treats tasks with status "done" as completed', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-700',
            prs: [{ id: 802, status: 'active' }],
            tasks: [
                { id: 'TK-1', number: 'TK-1', status: 'done' },
                { id: 'TK-2', number: 'TK-2', status: 'completed' },
            ],
        });
        writeJson(resolve(TMP_DIR, '.devops-status.json'), {
            currentPhase: 'monitoring-build',
            assignedPR: { id: 802 },
            events: [],
        });

        const result = applyBuildComplete(TMP_DIR, { prId: 802, result: 'passed' });
        expect(result.hasIncompleteTasks).toBeUndefined();
        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.currentPhase).toBe('complete');
    });
});

describe('applyDesignReady', () => {
    it('writes target agent status with design spec', () => {
        const result = applyDesignReady(TMP_DIR, {
            storyNumber: 'B-500',
            storyName: 'Test Story',
            designSpec: '.ux-design-spec.md',
        });
        expect(result.ok).toBe(true);
        expect(result.targetAgent).toBe('frontend');
        expect(result.targetPhase).toBe('pending-approval');

        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.storyNumber).toBe('B-500');
        expect(frontend.currentPhase).toBe('pending-approval');
        expect(frontend.collaborators).toContain('ux');
        expect(frontend.designSpec).toBe('.ux-design-spec.md');
    });

    it('updates ux status to collaborating', () => {
        writeJson(resolve(TMP_DIR, '.ux-status.json'), {
            storyNumber: 'B-500',
            currentPhase: 'spec-ready',
            events: [],
        });
        applyDesignReady(TMP_DIR, { storyNumber: 'B-500' });
        const ux = readJson(resolve(TMP_DIR, '.ux-status.json'));
        expect(ux.currentPhase).toBe('collaborating');
        expect(ux.collaborators).toContain('frontend');
    });

    it('is idempotent — does not overwrite if already assigned with collaborator', () => {
        writeJson(resolve(TMP_DIR, '.frontend-status.json'), {
            storyNumber: 'B-500',
            currentPhase: 'reading-story',
            collaborators: ['ux'],
            events: [{ timestamp: 'orig', type: 'info', message: 'original event' }],
        });
        applyDesignReady(TMP_DIR, { storyNumber: 'B-500' });
        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.currentPhase).toBe('reading-story');
        expect(frontend.events[0].message).toBe('original event');
    });

    it('targets a custom agent', () => {
        const result = applyDesignReady(TMP_DIR, {
            storyNumber: 'B-600',
            targetAgent: 'devops',
        });
        expect(result.targetAgent).toBe('devops');
        expect(existsSync(resolve(TMP_DIR, '.devops-status.json'))).toBe(true);
        const devops = readJson(resolve(TMP_DIR, '.devops-status.json'));
        expect(devops.storyNumber).toBe('B-600');
        expect(devops.collaborators).toContain('ux');
    });

    it('autonomous workflow skips pending approval', () => {
        const result = applyDesignReady(TMP_DIR, {
            storyNumber: 'B-700',
            storyName: 'Auto Design',
            workflowMode: 'autonomous',
        });
        expect(result.targetPhase).toBe('reading-story');
        const frontend = readJson(resolve(TMP_DIR, '.frontend-status.json'));
        expect(frontend.currentPhase).toBe('reading-story');
        expect(frontend.startedAt).toMatch(/^\d{4}-/);
    });
});
