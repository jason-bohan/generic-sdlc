import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseJsonUtf8File } from './json-file';

/**
 * Per-PR rework-round counter for the dev↔reviewer loop.
 *
 * The local 14B can loop forever against the reviewer — either because it genuinely
 * can't satisfy a real finding, or because the reviewer over-reaches past the story.
 * We cap the loop: after REWORK_CAP changes-requested rounds the framework escalates the
 * dev to the cloud brain for one attempt; if that round is also rejected it pauses for a
 * human instead of spinning. Counts persist in `.rework-counts.json` (keyed by PR id) and
 * are cleared on approval.
 */
export const REWORK_CAP = 3;

const MAX_KEYS = 500;

function countsFile(baseDir: string): string {
    return resolve(baseDir, '.rework-counts.json');
}

function readCounts(baseDir: string): Record<string, number> {
    const file = countsFile(baseDir);
    if (!existsSync(file)) return {};
    try {
        const raw = parseJsonUtf8File(file) as Record<string, unknown>;
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw)) {
            const n = Number(v);
            if (Number.isFinite(n)) out[k] = n;
        }
        return out;
    } catch {
        return {};
    }
}

function writeCounts(baseDir: string, counts: Record<string, number>): void {
    // Bound the file so a long-lived workspace can't grow it without limit.
    let entries = Object.entries(counts);
    if (entries.length > MAX_KEYS) entries = entries.slice(-MAX_KEYS);
    try { writeFileSync(countsFile(baseDir), JSON.stringify(Object.fromEntries(entries), null, 2)); } catch { /* non-fatal */ }
}

/** Increment and persist the rework round for a PR; returns the new (1-based) round. */
export function bumpReworkRound(baseDir: string, prId: number): number {
    const counts = readCounts(baseDir);
    const next = (counts[String(prId)] ?? 0) + 1;
    counts[String(prId)] = next;
    writeCounts(baseDir, counts);
    return next;
}

/** Clear a PR's rework counter (call on approval so a later re-open starts fresh). */
export function resetReworkRound(baseDir: string, prId: number): void {
    const counts = readCounts(baseDir);
    if (counts[String(prId)] === undefined) return;
    delete counts[String(prId)];
    writeCounts(baseDir, counts);
}

/**
 * Decide what a given rework round should do:
 *  - rounds 1..CAP-1 → normal local rework
 *  - round CAP        → escalate the dev to the cloud brain (one shot)
 *  - rounds > CAP     → cloud already tried and still rejected → pause for a human
 */
export function reworkAction(round: number): 'local' | 'escalate-cloud' | 'pause-human' {
    if (round > REWORK_CAP) return 'pause-human';
    if (round >= REWORK_CAP) return 'escalate-cloud';
    return 'local';
}

/**
 * Flag a dev's desk as stuck so the loop stops auto-retrying and a human can pick it up.
 * Sets `reworkStuck` and appends a warning event with the supplied reason.
 */
function markStuck(baseDir: string, agentId: string, message: string): void {
    const file = resolve(baseDir, `.${agentId}-status.json`);
    if (!existsSync(file)) return;
    try {
        const s = parseJsonUtf8File(file) as Record<string, unknown>;
        s.reworkStuck = true;
        if (!Array.isArray(s.events)) s.events = [];
        (s.events as unknown[]).push({ timestamp: new Date().toISOString(), type: 'warning', message });
        writeFileSync(file, JSON.stringify(s, null, 2));
    } catch { /* non-fatal */ }
}

/** Reviewer-rework cap exhausted (cloud-brain attempt also rejected). */
export function markReworkStuck(baseDir: string, prId: number, agentId: string, round: number): void {
    markStuck(baseDir, agentId, `Rework cap reached for PR #${prId} (round ${round}, incl. a cloud-brain attempt). Paused for human review — not auto-retrying.`);
}

/**
 * Dev-side validating-loop escalation. The local 14B can grind generating-code↔validating
 * forever (validation keeps failing; the per-phase auto-resume cap never trips because the
 * bounce alternates phases). We count dev-loop phase entries for the story: past
 * VALIDATION_ESCALATE_AT, escalate the dev to the cloud brain (one shot); past
 * VALIDATION_PAUSE_AT, pause for a human. Thresholds assume a clean first pass is
 * ~3 phase entries (analyzing→generating-code→validating) and each failed rework adds ~2.
 */
export const VALIDATION_ESCALATE_AT = 6;
export const VALIDATION_PAUSE_AT = 9;

export function devLoopAction(devLoopStarts: number): 'local' | 'escalate-cloud' | 'pause-human' {
    if (devLoopStarts >= VALIDATION_PAUSE_AT) return 'pause-human';
    if (devLoopStarts >= VALIDATION_ESCALATE_AT) return 'escalate-cloud';
    return 'local';
}

/** Validating-loop escalation exhausted (cloud-brain dev attempt still can't pass validation). */
export function markDevLoopStuck(baseDir: string, agentId: string, storyNumber: string, starts: number): void {
    markStuck(baseDir, agentId, `Validating loop stuck for ${storyNumber} (${starts} dev-loop attempts, incl. a cloud-brain attempt that still failed validation). Paused for human review — not auto-retrying.`);
}
