/**
 * Build the reviewer's spawn prompt.
 *
 * The reviewer's cwd is the FRAMEWORK repo, not the project under review, so any
 * bare `git`/`gh` the model runs to "fetch the diff" resolves against the wrong
 * repo and comes back empty — which the model then misreads as "the PR has no
 * changes" and wrongly requests changes (bug: reviewer false-negative on a real PR).
 *
 * The framework already pre-computes the authoritative committed diff into
 * `.reviewer-diff.patch` (see writeReviewerDiff / bug #8). Telling the model to go
 * read that file was not enough — it still reached for `git`. So we INLINE the diff
 * directly into the prompt (same pattern that made bug #9's inline feedback work):
 * the change set is right there, with an explicit instruction not to fetch its own.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { skillSubdirForAgentId } from '../shared/agentSkillDirs';

// Cap the inlined diff so a huge PR can't blow the model's context window.
// Beyond this the model is pointed back at the file for the remainder.
const MAX_INLINE_DIFF_CHARS = 24000;

export function buildReviewerPrompt(rootDir: string, prId: number | string): string {
    const skillPath = `skills/${skillSubdirForAgentId('reviewer')}/SKILL.md`;
    const base = `Review PR #${prId}. Read ${skillPath} and .reviewer-status.json, then perform a code review.`;

    const diffFile = resolve(rootDir, '.reviewer-diff.patch');
    if (!existsSync(diffFile)) return base;

    let diff: string;
    try {
        diff = readFileSync(diffFile, 'utf8');
    } catch {
        return base; // unreadable — fall back to the SKILL-directed prompt
    }
    if (!diff.trim()) return base;

    let truncated = false;
    if (diff.length > MAX_INLINE_DIFF_CHARS) {
        diff = diff.slice(0, MAX_INLINE_DIFF_CHARS);
        truncated = true;
    }

    return `${base}

The COMPLETE, authoritative diff for PR #${prId} (committed changes only, target...branch) is inlined below. This IS the change set — review ONLY what appears here.
Do NOT run git or gh to fetch a diff, and do NOT inspect the project working tree: your cwd is the FRAMEWORK repo, so those return empty/wrong results and will make you falsely conclude the PR is empty.

----- BEGIN PR #${prId} DIFF -----
${diff}
----- END PR #${prId} DIFF -----${truncated ? `\n(diff truncated at ${MAX_INLINE_DIFF_CHARS} chars; read .reviewer-diff.patch for the remainder)` : ''}`;
}
