import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { normalizeReviewerVerdict, reviewerPhaseForVerdict } from '../server/reviewer-verdict';
import { executeToolCall } from '../server/agent-runner/tools';

const TMP = resolve(__dirname, '.reviewer-verdict-tmp');

function readReviewerStatus() {
    return JSON.parse(readFileSync(resolve(TMP, '.reviewer-status.json'), 'utf-8'));
}

async function updateStatus(agentId: string, args: Record<string, unknown>) {
    return executeToolCall('update_status', args, TMP, TMP, agentId, resolve(TMP, '.sdlc-framework.config.json'));
}

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
});

describe('normalizeReviewerVerdict', () => {
    it('maps approve spellings to "approved"', () => {
        for (const raw of ['approved', 'Approve', 'APPROVAL', 'ApprovedWithSuggestions', 'approved-with-suggestions', 'lgtm']) {
            expect(normalizeReviewerVerdict(raw)).toBe('approved');
        }
    });

    it('maps change spellings to "changes-requested"', () => {
        for (const raw of ['changes-requested', 'request-changes', 'changes_requested', 'Rejected', 'reject', 'needs-work']) {
            expect(normalizeReviewerVerdict(raw)).toBe('changes-requested');
        }
    });

    it('returns null for unrecognized / empty input', () => {
        for (const raw of [undefined, null, '', '  ', 'maybe', 'pending']) {
            expect(normalizeReviewerVerdict(raw)).toBeNull();
        }
    });
});

describe('reviewerPhaseForVerdict', () => {
    it('keeps phase identical to the canonical verdict so they cannot diverge', () => {
        expect(reviewerPhaseForVerdict('approved')).toBe('approved');
        expect(reviewerPhaseForVerdict('changes-requested')).toBe('changes-requested');
    });
});

describe('update_status verdict/phase reconciliation (bug #10)', () => {
    it('forces the reviewer phase to match an approved verdict even when the model lands on waiting-for-fixes', async () => {
        // The bug: model says "approved (non-blocking nits)" but sets a changes phase.
        await updateStatus('reviewer', { phase: 'waiting-for-fixes', verdict: 'approved' });
        const status = readReviewerStatus();
        expect(status.verdict).toBe('approved');
        expect(status.currentPhase).toBe('approved'); // coerced from the verdict, not the requested phase
    });

    it('normalizes a loose verdict spelling and sets the matching phase', async () => {
        await updateStatus('reviewer', { phase: 'reviewing-pr', verdict: 'request-changes' });
        const status = readReviewerStatus();
        expect(status.verdict).toBe('changes-requested');
        expect(status.currentPhase).toBe('changes-requested');
    });

    it('leaves the phase alone when no recognizable verdict is given', async () => {
        await updateStatus('reviewer', { phase: 'reviewing-pr' });
        const status = readReviewerStatus();
        expect(status.currentPhase).toBe('reviewing-pr');
        expect(status.verdict).toBeUndefined();
    });

    it('does not coerce phase for non-reviewer agents', async () => {
        await executeToolCall('update_status', { phase: 'generating-code', verdict: 'approved' }, TMP, TMP, 'backend', resolve(TMP, '.sdlc-framework.config.json'));
        const status = JSON.parse(readFileSync(resolve(TMP, '.backend-status.json'), 'utf-8'));
        expect(status.currentPhase).toBe('generating-code'); // untouched
    });
});
