/**
 * Autonomous reviewer→dev handoff.
 *
 * When the reviewer finishes a review it writes a verdict to `.reviewer-status.json`
 * (`currentPhase` = `changes-requested` or `approved`). The handoff endpoint
 * `/api/handoff/review-complete` routes that verdict back to the dev (changes) or on
 * to devops (approved) and spawns the next agent — but nothing was *calling* it: the
 * loop driver doesn't, and the opencode/cloud reviewer doesn't either, so the PR sat
 * with a verdict but no one picked it up.
 *
 * This closes the gap deterministically. The hook-runner already fires once per
 * (agent, phase) transition (its own idempotency gate), so we simply react to the
 * reviewer reaching a terminal verdict and POST the handoff for it. Fire-and-forget
 * so it never blocks the status-event bus.
 */

import type { StatusChangeEvent } from './status-events';
import { serverLog as log } from './logger';

const TERMINAL_VERDICTS = new Set(['changes-requested', 'approved']);

export function maybeHandoffReviewVerdict(port: number, ev: StatusChangeEvent): void {
    if (ev.agentId !== 'reviewer') return;
    const status = ev.status as Record<string, unknown>;
    const verdict = String(status.currentPhase ?? '');
    if (!TERMINAL_VERDICTS.has(verdict)) return;
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
        .then((r) => log.info(`[review-handoff] reviewer ${verdict} on PR #${pr.id} → routed to dev (HTTP ${r.status})`))
        .catch((e) => log.warn(`[review-handoff] PR #${pr.id} ${verdict} handoff failed: ${e instanceof Error ? e.message : String(e)}`));
}
