import { describe, expect, it } from 'vitest';
import { normalizeReviewerWorkCardPrs } from '../server/reviewer-work-card';

describe('normalizeReviewerWorkCardPrs', () => {
    it('keeps assigned PR Active while phase is waiting-for-fixes (after changes requested)', () => {
        const raw = {
            currentPhase: 'waiting-for-fixes',
            assignedPR: { id: 5001, title: 'feat(B-17001): pagination', url: 'http://x/5001' },
            prs: [{ id: 5001, title: 'feat(B-17001): pagination', status: 'active', comments: 0, approvals: 0 }],
            events: [],
        };
        const rows = normalizeReviewerWorkCardPrs(raw);
        const row = rows.find((r) => r.id === 5001);
        expect(row?.status).toBe('active');
    });

    it('marks assigned PR Complete only when reviewer is idle (desk cleared)', () => {
        const raw = {
            currentPhase: 'idle',
            assignedPR: null,
            prs: [{ id: 5001, title: 'Old PR', status: 'active', comments: 0, approvals: 0 }],
            events: [],
        };
        const rows = normalizeReviewerWorkCardPrs(raw);
        const row = rows.find((r) => r.id === 5001);
        expect(row?.status).toBe('completed');
    });
});
