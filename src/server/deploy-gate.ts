// Deploy gate — "merged" is not "shipped".
//
// The SDLC loop ends at merge (complete). But the merged change still has to *deploy*, and a
// deploy can fail after merge (external platform — Vercel/Netlify/Render/etc., reported
// out-of-band, not in GitHub Actions). Without a gate, a failed deploy leaves prod broken with
// the story falsely "done" and nobody re-working it.
//
// This closes the loop: a deploy result is ingested (the platform's webhook POSTs it), and on
// failure the story is requeued for rework with the failure reason attached — so the orchestrator
// re-picks it, the dev fixes it, and it re-merges + re-deploys. On success it's just acknowledged.

import { findLocalStory, updateLocalStory } from './local-planning';

export type DeployResult = 'success' | 'failed';

export interface DeployGateOutcome {
  ok: boolean;
  action: 'requeued' | 'acknowledged' | 'not-found';
  storyNumber?: string;
  note: string;
}

/** Pull a story number (LOCAL-B-0064, UNW-122, …) out of free text (PR title / commit message). */
export function parseStoryNumber(text: string): string | undefined {
  const m = (text || '').match(/\b([A-Z][A-Z0-9]*-(?:B-)?\d+)\b/);
  return m ? m[1] : undefined;
}

/**
 * Apply a deploy result to the story. On failure: requeue to Backlog with the reason prepended to
 * the description so the orchestrator re-assigns it and the dev fixes the right thing. On success:
 * acknowledge (no change). Unknown story → not-found (caller decides; never throws).
 */
export function applyDeployResult(rootDir: string, storyNumber: string, result: DeployResult, reason?: string): DeployGateOutcome {
  const story = findLocalStory(rootDir, storyNumber);
  if (!story) return { ok: false, action: 'not-found', storyNumber, note: `story ${storyNumber} not found` };

  if (result === 'failed') {
    const tag = `[Deploy failed${reason ? `: ${reason}` : ''}] `;
    const desc = String(story.description ?? '');
    const newDesc = desc.startsWith('[Deploy failed') ? desc : `${tag}${desc}`;
    updateLocalStory(rootDir, storyNumber, { status: 'Backlog', description: newDesc });
    return { ok: true, action: 'requeued', storyNumber, note: `deploy failed — ${storyNumber} requeued for rework` };
  }
  return { ok: true, action: 'acknowledged', storyNumber, note: `deploy succeeded — ${storyNumber}` };
}
