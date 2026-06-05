/**
 * Canonical reviewer verdict handling (bug #10).
 *
 * The reviewer communicates its decision two ways that MUST agree: an explicit
 * `verdict` and the `currentPhase` it lands on. When they diverge — e.g. the model
 * writes "Verdict: approved (non-blocking nits)" but sets `currentPhase: waiting-for-fixes`
 * — the phase-based handoff routes the PR back to the author over nits instead of
 * forward to devops. And the model is loose with the verdict string itself
 * (`request-changes` vs the `changes-requested` the routing expects).
 *
 * So we (a) normalize the many spellings the model emits to one of two canonical
 * verdicts, and (b) make the phase a pure function of the verdict, so update_status
 * can keep them in lock-step instead of trusting the model to.
 */

export type ReviewVerdict = 'approved' | 'changes-requested';

// Every spelling we've seen (or reasonably expect) the model emit, lower-cased.
const APPROVE_SYNONYMS = new Set([
    'approved', 'approve', 'approval',
    'approvedwithsuggestions', 'approved-with-suggestions', 'approve-with-suggestions',
    'lgtm', 'accept', 'accepted',
]);
const CHANGES_SYNONYMS = new Set([
    'changes-requested', 'changes_requested', 'changesrequested',
    'request-changes', 'request_changes', 'requestchanges', 'request changes',
    'rejected', 'reject', 'wait-for-author', 'needs-changes', 'needs-work',
]);

/** Coerce any verdict-ish string to a canonical verdict, or null if unrecognized. */
export function normalizeReviewerVerdict(raw: unknown): ReviewVerdict | null {
    if (raw == null) return null;
    const v = String(raw).trim().toLowerCase();
    if (!v) return null;
    if (APPROVE_SYNONYMS.has(v)) return 'approved';
    if (CHANGES_SYNONYMS.has(v)) return 'changes-requested';
    return null;
}

/**
 * The canonical reviewer phase for a verdict. Keeping phase === verdict string means
 * the phase-based handoff inference and the explicit verdict can never disagree.
 */
export function reviewerPhaseForVerdict(verdict: ReviewVerdict): string {
    return verdict; // 'approved' | 'changes-requested' are themselves valid terminal phases
}
