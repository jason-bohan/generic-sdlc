import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
    computeReviewerPrDeskUi,
    loadDismissedPrIds,
    dismissPrFromReviewerDesk,
    mergeThreadsForPr,
    mergeDeskUiIntoReviewerPrs,
    clearReviewerDeskToIdle,
    reviewerPickupBlockedForCompleted,
    isAzureDevOpsPrTerminalStatus,
} from '../server/reviewer-pr-desk';

const TMP = resolve(__dirname, '.reviewer-pr-desk-tmp');

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
});

describe('reviewer-pr-desk', () => {
    it('working when reviewer has PR in pending-review', () => {
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({
                currentPhase: 'pending-review',
                assignedPR: { id: 42 },
                events: [],
            }),
        );
        const dismissed = loadDismissedPrIds(TMP);
        const ownerByPr = new Map();
        const st = JSON.parse(JSON.stringify({ currentPhase: 'pending-review', assignedPR: { id: 42 }, events: [] }));
        const ui = computeReviewerPrDeskUi(TMP, 42, st, dismissed, ownerByPr);
        expect(ui.kind).toBe('pending');
    });

    it('approved_done from reviewer events after handoff', () => {
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({
                currentPhase: 'idle',
                assignedPR: null,
                events: [{ timestamp: 't', type: 'success', message: 'Review complete. PR #99 approved and handed off to devops.' }],
            }),
        );
        const dismissed = loadDismissedPrIds(TMP);
        const ownerByPr = new Map();
        const st = JSON.parse(readFileSync(resolve(TMP, '.reviewer-status.json'), 'utf-8'));
        const ui = computeReviewerPrDeskUi(TMP, 99, st, dismissed, ownerByPr);
        expect(ui.kind).toBe('approved_done');
    });

    it('dismiss hides approved_done overlay', () => {
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({
                currentPhase: 'idle',
                assignedPR: null,
                events: [{ timestamp: 't', type: 'success', message: 'Review complete. PR #7 approved and handed off to devops.' }],
            }),
        );
        dismissPrFromReviewerDesk(TMP, 7);
        const dismissed = loadDismissedPrIds(TMP);
        const ownerByPr = new Map();
        const st = JSON.parse(readFileSync(resolve(TMP, '.reviewer-status.json'), 'utf-8'));
        const ui = computeReviewerPrDeskUi(TMP, 7, st, dismissed, ownerByPr);
        expect(ui.kind).toBe('none');
    });

    it('dismiss removes PR-REVIEW task from reviewer status', () => {
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({
                currentPhase: 'idle',
                assignedPR: null,
                events: [],
                tasks: [
                    { id: 'PR-REVIEW-55', number: 'PR-REVIEW-55', name: 'Review PR #55', status: 'pending', hours: 1, category: 'Review' },
                    { id: 'OTHER', name: 'Keep me', status: 'pending', hours: 1 },
                ],
            }),
        );
        dismissPrFromReviewerDesk(TMP, 55);
        const after = JSON.parse(readFileSync(resolve(TMP, '.reviewer-status.json'), 'utf-8'));
        expect(after.tasks).toEqual([{ id: 'OTHER', name: 'Keep me', status: 'pending', hours: 1 }]);
    });

    it('mergeThreadsForPr reads array-shaped reviewer comments', () => {
        writeFileSync(
            resolve(TMP, '.reviewer-comments.json'),
            JSON.stringify([{ id: '1', prId: 5, file: 'a.ts', comment: 'hello' }]),
        );
        const threads = mergeThreadsForPr(TMP, 5);
        expect(threads.some((t) => t.comment === 'hello' && t.file === 'a.ts')).toBe(true);
    });

    it('mergeDeskUiIntoReviewerPrs attaches deskUi', () => {
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({ currentPhase: 'idle', assignedPR: null, events: [] }),
        );
        const merged = mergeDeskUiIntoReviewerPrs(TMP, [{ id: 1, title: 't', status: 'active', sourceBranch: 'b', targetBranch: 'm', url: 'http://x' }], null);
        expect(merged[0].deskUi.kind).toBe('none');
        expect(merged[0].reviewerPickupEligible).toBe(true);
    });

    it('mergeDeskUiIntoReviewerPrs marks dismissed PR ineligible for pickup', () => {
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({ currentPhase: 'idle', assignedPR: null, events: [] }),
        );
        dismissPrFromReviewerDesk(TMP, 88);
        const merged = mergeDeskUiIntoReviewerPrs(TMP, [{ id: 88, title: 'd', status: 'active', sourceBranch: 'b', targetBranch: 'm', url: 'http://x' }], null);
        expect(merged[0].deskUi.kind).toBe('none');
        expect(merged[0].reviewerPickupEligible).toBe(false);
    });

    it('mergeDeskUiIntoReviewerPrs marks ADO-completed PR ineligible for pickup', () => {
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({ currentPhase: 'idle', assignedPR: null, events: [] }),
        );
        const merged = mergeDeskUiIntoReviewerPrs(TMP, [{ id: 2, title: 't', status: 'completed', sourceBranch: 'b', targetBranch: 'm', url: 'http://x' }], null);
        expect(merged[0].reviewerPickupEligible).toBe(false);
    });

    it('reviewerPickupBlockedForCompleted uses story owner prs status', () => {
        writeFileSync(
            resolve(TMP, '.frontend-status.json'),
            JSON.stringify({ prs: [{ id: 400, status: 'completed', title: 'x' }] }),
        );
        expect(reviewerPickupBlockedForCompleted(TMP, 400, 'active')).toMatch(/completed/);
    });

    describe('isAzureDevOpsPrTerminalStatus (ADO GitPullRequest.status)', () => {
        it('treats completed and abandoned as terminal (merged PRs are completed in Azure)', () => {
            expect(isAzureDevOpsPrTerminalStatus('completed')).toBe(true);
            expect(isAzureDevOpsPrTerminalStatus('abandoned')).toBe(true);
            expect(isAzureDevOpsPrTerminalStatus('COMPLETED')).toBe(true);
        });
        it('treats active and missing status as non-terminal', () => {
            expect(isAzureDevOpsPrTerminalStatus('active')).toBe(false);
            expect(isAzureDevOpsPrTerminalStatus(undefined)).toBe(false);
            expect(isAzureDevOpsPrTerminalStatus(null)).toBe(false);
        });
    });

    describe('reviewerPickupBlockedForCompleted messages', () => {
        it('mentions abandoned when ADO status is abandoned', () => {
            expect(reviewerPickupBlockedForCompleted(TMP, 1, 'abandoned')).toMatch(/abandoned/i);
        });
    });

    it('treats assignedPR.id as string (JSON coerces to working match)', () => {
        const st = { currentPhase: 'pending-review', assignedPR: { id: '42' }, events: [] };
        const ui = computeReviewerPrDeskUi(TMP, 42, st, new Set(), new Map());
        expect(ui.kind).toBe('pending');
    });

    it('clearReviewerDeskToIdle resets file when prId matches', () => {
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({
                currentPhase: 'pending-review',
                assignedPR: { id: 9, title: 'T' },
                events: [],
                tasks: [{ id: 'x' }],
            }),
        );
        const r = clearReviewerDeskToIdle(TMP, { prId: 9 });
        expect(r.ok).toBe(true);
        const after = JSON.parse(readFileSync(resolve(TMP, '.reviewer-status.json'), 'utf-8'));
        expect(after.currentPhase).toBe('idle');
        expect(after.assignedPR).toBeNull();
        expect(after.tasks).toEqual([]);
    });
});
