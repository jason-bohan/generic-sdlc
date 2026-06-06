import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { harvestReviewerFindingFromStatus } from '../server/routes/handoffs';

const TMP = resolve(__dirname, '.reviewer-finding-harvest-tmp');
const writeReviewer = (v: unknown) => writeFileSync(resolve(TMP, '.reviewer-status.json'), JSON.stringify(v, null, 2));

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
});

describe('harvestReviewerFindingFromStatus — feedback of last resort', () => {
    it('harvests the substantive finding from the reviewer status events', () => {
        writeReviewer({
            assignedPR: { id: 31 },
            events: [
                { type: 'info', message: 'PR #31 assigned for review' },
                { type: 'phase', message: 'Reviewing PR #31 - Adding pingpong endpoint' },
                { type: 'phase', message: 'Found critical indentation issue in PR #31 - endpoint placed incorrectly' },
                { type: 'phase', message: 'Requesting changes for PR #31 - critical indentation issue found' },
            ],
        });
        const out = harvestReviewerFindingFromStatus(TMP, 31);
        expect(out).toHaveLength(1);
        expect(out![0].summary).toMatch(/indentation issue/i);
        expect(out![0].summary).toMatch(/placed incorrectly/i);
        // The content-free "assigned for review" opener is dropped.
        expect(out![0].summary).not.toMatch(/assigned for review/i);
    });

    it('returns undefined when the reviewer status is about a different PR', () => {
        writeReviewer({ assignedPR: { id: 99 }, events: [{ type: 'phase', message: 'Found a bug in PR #99' }] });
        expect(harvestReviewerFindingFromStatus(TMP, 31)).toBeUndefined();
    });

    it('returns undefined when there are no substantive events', () => {
        writeReviewer({ assignedPR: { id: 31 }, events: [{ type: 'info', message: 'PR #31 assigned for review' }, { type: 'info', message: 'Reset to idle.' }] });
        const out = harvestReviewerFindingFromStatus(TMP, 31);
        // 'Reset to idle.' is dropped; nothing actionable remains.
        expect(out).toBeUndefined();
    });

    it('returns undefined when no reviewer status file exists', () => {
        expect(harvestReviewerFindingFromStatus(TMP, 31)).toBeUndefined();
    });
});
