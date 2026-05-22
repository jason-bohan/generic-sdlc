import { existsSync, writeFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { parseJsonUtf8File } from './json-file';

const DISMISSED_REL = '.reviewer-pr-dismissed.json';

/**
 * Azure DevOps Git `GitPullRequest.status` (REST). There is no separate "merged" string: after merge the PR is **`completed`**.
 * `abandoned` is closed without merging. Listing uses `searchCriteria.status=active`, so completed PRs normally never appear; we still check
 * status on pickup and in eligibility so stale local JSON / race windows cannot queue a review. See Microsoft Learn "Pull requests - Get".
 */
export const AZURE_DEVOPS_PR_TERMINAL_STATUSES = new Set(['completed', 'abandoned']);

/** True when ADO (or same vocabulary in our status files) says the PR is no longer active. */
export function isAzureDevOpsPrTerminalStatus(adoStatus: string | undefined | null): boolean {
    const st = String(adoStatus ?? 'active').trim().toLowerCase();
    return AZURE_DEVOPS_PR_TERMINAL_STATUSES.has(st);
}

export const REVIEWER_WORKING_PHASES = new Set(['pending-review', 'reviewing', 'commenting']);

export interface ReviewerPrThread {
    id?: string;
    file?: string;
    line?: number;
    category?: string;
    status?: string;
    comment: string;
}

export type ReviewerDeskUiKind = 'none' | 'pending' | 'working' | 'changes_on_desk' | 'approved_done' | 'changes_followup' | 'watching_build';

export interface ReviewerPrDeskUi {
    kind: ReviewerDeskUiKind;
    commentCount: number;
}

interface OwnerPrOverlay {
    prStatus: string;
    codeReviewVerdict?: string;
}

/** Normalize assigned PR id from JSON (ADO/mock sometimes stores numeric strings). */
export function parseReviewerAssignedPrId(reviewerStatus: Record<string, unknown> | null): number | null {
    if (!reviewerStatus) return null;
    const assigned = reviewerStatus.assignedPR as { id?: unknown } | undefined;
    const raw = assigned?.id;
    if (raw == null || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Clear reviewer desk (idle, no assigned PR). Optionally require matching prId. */
export function clearReviewerDeskToIdle(rootDir: string, options?: { prId?: number }): { ok: boolean; error?: string } {
    const p = resolve(rootDir, '.reviewer-status.json');
    if (!existsSync(p)) return { ok: false, error: 'No reviewer status file' };
    let raw: Record<string, unknown>;
    try {
        raw = parseJsonUtf8File(p) as Record<string, unknown>;
    } catch {
        return { ok: false, error: 'Invalid reviewer status file' };
    }
    const curId = parseReviewerAssignedPrId(raw);
    if (options?.prId != null) {
        if (curId == null) return { ok: false, error: 'Reviewer desk has no assigned PR' };
        if (curId !== options.prId) return { ok: false, error: 'Reviewer desk has a different PR assigned' };
    } else if (curId == null && raw.currentPhase === 'idle') {
        return { ok: true };
    }
    const events = Array.isArray(raw.events) ? [...(raw.events as unknown[])] : [];
    const msg = options?.prId != null
        ? `PR #${options.prId} removed from reviewer desk (manual).`
        : 'Reviewer desk cleared (manual).';
    events.push({ timestamp: new Date().toISOString(), type: 'info', message: msg });
    const next = {
        ...raw,
        currentPhase: 'idle',
        assignedPR: null,
        handoffDispatched: false,
        tasks: [],
        events };
    writeFileSync(p, JSON.stringify(next, null, 2));
    return { ok: true };
}

function readJson(path: string): unknown | null {
    if (!existsSync(path)) return null;
    try {
        return parseJsonUtf8File(path);
    } catch {
        return null;
    }
}

export function loadDismissedPrIds(rootDir: string): Set<number> {
    const data = readJson(resolve(rootDir, DISMISSED_REL)) as { prIds?: unknown } | null;
    const raw = data?.prIds;
    if (!Array.isArray(raw)) return new Set();
    const ids = new Set<number>();
    for (const x of raw) {
        const n = Number(x);
        if (Number.isFinite(n) && n > 0) ids.add(n);
    }
    return ids;
}

const PR_REVIEW_TASK_RE = /^PR-REVIEW-(\d+)$/;

/** True if this task row is the synthetic pickup row from pick-pr / pr/created (`PR-REVIEW-<prId>`). */
function isReviewerPickupTaskForPr(t: unknown, prId: number): boolean {
    const o = t as { id?: unknown; number?: unknown };
    for (const raw of [o.id, o.number]) {
        if (raw == null) continue;
        const m = PR_REVIEW_TASK_RE.exec(String(raw).trim());
        if (m && Number(m[1]) === prId) return true;
    }
    return false;
}

/** Drop `PR-REVIEW-<prId>` tasks from `.reviewer-status.json` (handoff leaves them after changes-requested; approve clears the whole file). */
export function removePrReviewTaskFromReviewerStatus(rootDir: string, prId: number): void {
    const p = resolve(rootDir, '.reviewer-status.json');
    if (!existsSync(p)) return;
    let raw: Record<string, unknown>;
    try {
        raw = parseJsonUtf8File(p) as Record<string, unknown>;
    } catch {
        return;
    }
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    const nextTasks = tasks.filter((t) => !isReviewerPickupTaskForPr(t, prId));
    if (nextTasks.length === tasks.length) return;
    raw.tasks = nextTasks;
    writeFileSync(p, JSON.stringify(raw, null, 2));
}

export function dismissPrFromReviewerDesk(rootDir: string, prId: number): void {
    const p = resolve(rootDir, DISMISSED_REL);
    const cur = loadDismissedPrIds(rootDir);
    cur.add(prId);
    writeFileSync(p, JSON.stringify({ prIds: [...cur].sort((a, b) => a - b) }, null, 2));
    removePrReviewTaskFromReviewerStatus(rootDir, prId);
}

export function undismissPrFromReviewerDesk(rootDir: string, prId: number): void {
    const p = resolve(rootDir, DISMISSED_REL);
    const cur = loadDismissedPrIds(rootDir);
    if (!cur.delete(prId)) return;
    const next = [...cur].sort((a, b) => a - b);
    if (next.length === 0 && existsSync(p)) {
        writeFileSync(p, JSON.stringify({ prIds: [] }, null, 2));
        return;
    }
    writeFileSync(p, JSON.stringify({ prIds: next }, null, 2));
}

function hasApprovedHandoffEvent(events: unknown, prId: number): boolean {
    if (!Array.isArray(events)) return false;
    const re = new RegExp(`PR #${prId} approved and handed off to devops`, 'i');
    return events.some((e) => {
        const msg = (e as { message?: string })?.message;
        return typeof msg === 'string' && re.test(msg);
    });
}

/** Per-PR info from non-reviewer agent status files (story owner). */
export function buildOwnerPrOverlayMap(rootDir: string): Map<number, OwnerPrOverlay> {
    const map = new Map<number, OwnerPrOverlay>();
    let names: string[];
    try {
        names = readdirSync(rootDir);
    } catch {
        return map;
    }
    for (const file of names) {
        if (!/^\.[a-z]+-status\.json$/.test(file) || file === '.reviewer-status.json') continue;
        const raw = readJson(resolve(rootDir, file)) as { prs?: unknown } | null;
        const prs = Array.isArray(raw?.prs) ? raw!.prs : [];
        for (const p of prs) {
            const row = p as { id?: number; status?: string; codeReview?: { verdict?: string } };
            if (typeof row.id !== 'number' || !Number.isFinite(row.id)) continue;
            const cv = row.codeReview?.verdict;
            map.set(row.id, {
                prStatus: String(row.status || 'active'),
                ...(typeof cv === 'string' && cv.trim() ? { codeReviewVerdict: cv.trim() } : {}) });
        }
    }
    return map;
}

export function loadReviewerThreadsForPr(rootDir: string, prId: number): ReviewerPrThread[] {
    const path = resolve(rootDir, '.reviewer-comments.json');
    if (!existsSync(path)) return [];
    try {
        const data = parseJsonUtf8File(path) as unknown;
        if (Array.isArray(data)) {
            const out: ReviewerPrThread[] = [];
            for (const row of data) {
                const r = row as { prId?: number; comment?: string; id?: string; file?: string; line?: number; category?: string; status?: string };
                if (r.prId !== prId) continue;
                if (typeof r.comment !== 'string' || !r.comment.trim()) continue;
                out.push({
                    ...(typeof r.id === 'string' ? { id: r.id } : {}),
                    ...(typeof r.file === 'string' ? { file: r.file } : {}),
                    ...(typeof r.line === 'number' ? { line: r.line } : {}),
                    ...(typeof r.category === 'string' ? { category: r.category } : {}),
                    ...(typeof r.status === 'string' ? { status: r.status } : {}),
                    comment: r.comment.trim() });
            }
            return out;
        }
        const obj = data as { prId?: number; threads?: Array<{ id?: string; file?: string; line?: number; comment?: string; severity?: string }> };
        if (typeof obj.prId !== 'number' || obj.prId !== prId || !Array.isArray(obj.threads)) return [];
        return obj.threads
            .filter((t) => typeof t.comment === 'string' && t.comment.trim())
            .map((t) => ({
                ...(typeof t.id === 'string' ? { id: t.id } : {}),
                ...(typeof t.file === 'string' ? { file: t.file } : {}),
                ...(typeof t.line === 'number' ? { line: t.line } : {}),
                ...(typeof t.severity === 'string' ? { category: t.severity } : {}),
                comment: String(t.comment).trim() }));
    } catch {
        return [];
    }
}

export function loadOwnerReviewRequestsForPr(rootDir: string, prId: number): ReviewerPrThread[] {
    let names: string[];
    try {
        names = readdirSync(rootDir);
    } catch {
        return [];
    }
    const out: ReviewerPrThread[] = [];
    for (const file of names) {
        if (!/^\.[a-z]+-status\.json$/.test(file) || file === '.reviewer-status.json') continue;
        const raw = readJson(resolve(rootDir, file)) as { requests?: unknown } | null;
        const requests = Array.isArray(raw?.requests) ? raw!.requests : [];
        for (const r of requests) {
            const row = r as { type?: string; prId?: number; summary?: string; file?: string; line?: number; severity?: string; status?: string; id?: string };
            if (row.type !== 'review' || row.prId !== prId) continue;
            if (typeof row.summary !== 'string' || !row.summary.trim()) continue;
            out.push({
                ...(typeof row.id === 'string' ? { id: row.id } : {}),
                ...(typeof row.file === 'string' ? { file: row.file } : {}),
                ...(typeof row.line === 'number' ? { line: row.line } : {}),
                ...(typeof row.severity === 'string' ? { category: row.severity } : {}),
                ...(typeof row.status === 'string' ? { status: row.status } : {}),
                comment: row.summary.trim() });
        }
    }
    return out;
}

export function mergeThreadsForPr(rootDir: string, prId: number): ReviewerPrThread[] {
    const a = loadReviewerThreadsForPr(rootDir, prId);
    const b = loadOwnerReviewRequestsForPr(rootDir, prId);
    if (b.length === 0) return a;
    if (a.length === 0) return b;
    const seen = new Set(a.map((t) => `${t.file ?? ''}:${t.comment.slice(0, 80)}`));
    const merged = [...a];
    for (const t of b) {
        const key = `${t.file ?? ''}:${t.comment.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(t);
    }
    return merged;
}

export function computeReviewerPrDeskUi(
    rootDir: string,
    prId: number,
    reviewerStatus: Record<string, unknown> | null,
    dismissed: Set<number>,
    ownerByPr: Map<number, OwnerPrOverlay>,
): ReviewerPrDeskUi {
    const merged = mergeThreadsForPr(rootDir, prId);
    const commentCount = merged.length;

    const phase = typeof reviewerStatus?.currentPhase === 'string' ? reviewerStatus.currentPhase : 'idle';
    const assignedId = parseReviewerAssignedPrId(reviewerStatus);
    const activeDesk = assignedId != null && assignedId === prId && phase !== 'idle';

    if (activeDesk) {
        if (phase === 'changes-requested') {
            return { kind: 'changes_on_desk', commentCount };
        }
        if (phase === 'pending-review') {
            return { kind: 'pending', commentCount };
        }
        if (phase === 'watching-build') {
            return { kind: 'watching_build', commentCount };
        }
        if (REVIEWER_WORKING_PHASES.has(phase)) {
            return { kind: 'working', commentCount };
        }
        return { kind: 'working', commentCount };
    }

    if (dismissed.has(prId) && !activeDesk) {
        return { kind: 'none', commentCount: 0 };
    }

    const owner = ownerByPr.get(prId);
    if (owner?.codeReviewVerdict === 'approved' || hasApprovedHandoffEvent(reviewerStatus?.events, prId)) {
        return { kind: 'approved_done', commentCount };
    }

    if (owner?.prStatus === 'changes-requested') {
        return { kind: 'changes_followup', commentCount };
    }

    return { kind: 'none', commentCount: 0 };
}

/**
 * False for auto-pick and optional UI: dismissed overlays, ADO/story-completed PRs, or any desk row that is not a plain list row (`kind !== 'none'`).
 * `POST /api/reviewer/pick-pr` still allows reassignment for dismissed cards; completed PRs are rejected on the server.
 */
export function computeReviewerPickupEligible(
    prId: number,
    deskUi: ReviewerPrDeskUi,
    dismissed: Set<number>,
    ownerByPr: Map<number, OwnerPrOverlay>,
    adoStatus: string | undefined,
): boolean {
    if (dismissed.has(prId)) return false;
    if (isAzureDevOpsPrTerminalStatus(adoStatus)) return false;
    const owner = ownerByPr.get(prId);
    if (owner && isAzureDevOpsPrTerminalStatus(owner.prStatus)) return false;
    return deskUi.kind === 'none';
}

/** Block manual pick when ADO or story owner shows a terminal PR status (mirrors Azure `completed` / `abandoned`). */
export function reviewerPickupBlockedForCompleted(rootDir: string, prId: number, adoStatus: string | undefined): string | null {
    if (isAzureDevOpsPrTerminalStatus(adoStatus)) {
        const st = String(adoStatus ?? '').trim().toLowerCase();
        if (st === 'abandoned') return 'Pull request is abandoned in Azure DevOps';
        return 'Pull request is completed in Azure DevOps (merged or otherwise finished)';
    }
    const owner = buildOwnerPrOverlayMap(rootDir).get(prId);
    if (owner && isAzureDevOpsPrTerminalStatus(owner.prStatus)) {
        return 'Story workspace shows this pull request as completed or abandoned';
    }
    return null;
}

export function mergeDeskUiIntoReviewerPrs<T extends { id: number; status?: string }>(
    rootDir: string,
    prs: T[],
    reviewerStatus: Record<string, unknown> | null,
): Array<T & { deskUi: ReviewerPrDeskUi; reviewerPickupEligible: boolean }> {
    const dismissed = loadDismissedPrIds(rootDir);
    const ownerByPr = buildOwnerPrOverlayMap(rootDir);
    return prs.map((pr) => {
        const deskUi = computeReviewerPrDeskUi(rootDir, pr.id, reviewerStatus, dismissed, ownerByPr);
        const reviewerPickupEligible = computeReviewerPickupEligible(pr.id, deskUi, dismissed, ownerByPr, pr.status);
        return {
            ...pr,
            deskUi,
            reviewerPickupEligible };
    });
}
