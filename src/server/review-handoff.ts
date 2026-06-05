/**
 * Autonomous reviewer→dev handoff.
 *
 * When the reviewer finishes a review it writes a verdict to `.reviewer-status.json`
 * (via the explicit `verdict` field or inferred from `currentPhase`). The handoff
 * endpoint `/api/handoff/review-complete` routes that verdict back to the dev (changes)
 * or on to devops (approved) and spawns the next agent — but nothing was *calling* it:
 * the loop driver doesn't, and the opencode/cloud reviewer doesn't either, so the PR sat
 * with a verdict but no one picked it up.
 *
 * This closes the gap deterministically. The hook-runner already fires once per
 * (agent, phase) transition (its own idempotency gate), so we simply react to the
 * reviewer reaching a terminal verdict and POST the handoff for it. Fire-and-forget
 * so it never blocks the status-event bus.
 */

import type { StatusChangeEvent } from './status-events';
import { serverLog as log } from './logger';
import { normalizeReviewerVerdict } from './reviewer-verdict';

// Reviewer terminal phases → the verdict the /api/handoff/review-complete endpoint
// understands ('approved' | 'changes-requested'). Models don't reliably land on the
// bare 'changes-requested' string: 'waiting-for-fixes' (the post-changes-requested
// monitoring state) and 'rejected' carry the same routing (back to the author), so we
// normalize all of them. Without this, a reviewer that lands on 'waiting-for-fixes'
// leaves the verdict stranded — the handoff never fires and the loop never closes.
const VERDICT_BY_REVIEWER_PHASE: Record<string, 'approved' | 'changes-requested'> = {
    'approved': 'approved',
    'changes-requested': 'changes-requested',
    'waiting-for-fixes': 'changes-requested',
    'rejected': 'changes-requested',
};

export function maybeHandoffReviewVerdict(port: number, ev: StatusChangeEvent): void {
    if (ev.agentId !== 'reviewer') return;
    const status = ev.status as Record<string, unknown>;

    // Prefer an explicit verdict field — the model calls update_status with
    // verdict:"approved"|"changes-requested" instead of encoding the decision
    // in a phase string. Normalize the many spellings it emits (e.g. "request-changes")
    // so a real verdict isn't missed and silently demoted to phase inference (bug #10).
    // Fall back to phase-based inference for backwards compat.
    const explicitVerdict = normalizeReviewerVerdict(status.verdict);
    const phase = String(status.currentPhase ?? '');
    const verdict = explicitVerdict ?? (VERDICT_BY_REVIEWER_PHASE[phase] ?? null);
    if (!verdict) return;
    const pr = status.assignedPR as { id?: number; storyNumber?: string; branch?: string; projectKey?: string } | undefined;
    if (!pr?.id) return;

    const body = JSON.stringify({
        prId: pr.id,
        verdict,
        storyNumber: pr.storyNumber ?? null,
        branch: pr.branch ?? null,
        projectKey: pr.projectKey ?? null,
    });
    void fetch(`http://localhost:${port}/api/handoff/review-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20_000),
    })
        .then((r) => log.info(`[review-handoff] reviewer ${phase} → ${verdict} on PR #${pr.id} → routed (HTTP ${r.status})`))
        .catch((e) => log.warn(`[review-handoff] PR #${pr.id} ${phase} handoff failed: ${e instanceof Error ? e.message : String(e)}`));
}
