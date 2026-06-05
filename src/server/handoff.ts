import { writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { defaultTokenState } from './tokens';
import { isMockExternalMode } from './external-mode';
import { setMockPullRequestStatus } from './mock-external';
import { isAgentStepMode } from './stepMode';
import { parseJsonUtf8File } from './json-file';
import { dbGetWorkflowItemByStory } from './db';

interface RequestEntry {
    id: string;
    type: 'review' | 'design' | 'build';
    source: string;
    summary: string;
    file?: string;
    line?: number;
    status: 'open' | 'resolved';
    prId?: number;
    createdAt: string;
    severity?: string;
    storyNumber?: string;
    comments?: ReviewComment[];
    resolvedAt?: string;
}

export interface StoryOwnerResult {
    agentId: string;
    statusFile: string;
    status: Record<string, unknown>;
}

export function findStoryOwnerByPrId(baseDir: string, prId: number): StoryOwnerResult | null {
    const files = readdirSync(baseDir).filter((f: string) => /^\.[a-z]+-status\.json$/.test(f));
    for (const file of files) {
        const fullPath = resolve(baseDir, file);
        try {
            const raw = parseJsonUtf8File(fullPath);
            const prs = Array.isArray(raw.prs) ? raw.prs : [];
            if (prs.some((p: { id: number }) => p.id === prId)) {
                const agentId = file.replace(/^\./, '').replace(/-status\.json$/, '');
                return { agentId, statusFile: fullPath, status: raw };
            }
        } catch { /* skip unreadable files */ }
    }
    return null;
}

export interface ReviewComment {
    id?: string;
    summary: string;
    file?: string;
    line?: number;
    severity?: string;
}

/** Map `.reviewer-comments.json` threads to handoff comments when the verdict is changes-requested. */
export function loadReviewerCommentsAsReviewComments(baseDir: string, prId: number): ReviewComment[] | undefined {
    const path = resolve(baseDir, '.reviewer-comments.json');
    if (!existsSync(path)) return undefined;
    try {
        const data = parseJsonUtf8File(path) as {
            prId?: number;
            threads?: Array<{ id?: string; file?: string; line?: number; comment?: string; severity?: string }>;
        };
        if (typeof data.prId !== 'number' || data.prId !== prId) return undefined;
        if (!Array.isArray(data.threads)) return undefined;
        const out: ReviewComment[] = [];
        for (const t of data.threads) {
            if (typeof t.comment !== 'string' || !t.comment.trim()) continue;
            const rc: ReviewComment = { summary: t.comment.trim() };
            if (typeof t.id === 'string' && t.id.trim()) rc.id = `REQ-${t.id}`;
            const f = typeof t.file === 'string' ? t.file.trim() : '';
            if (f && f !== 'general') rc.file = f;
            if (typeof t.line === 'number') rc.line = t.line;
            if (typeof t.severity === 'string' && t.severity.trim()) rc.severity = t.severity.trim();
            out.push(rc);
        }
        return out.length ? out : undefined;
    } catch {
        return undefined;
    }
}

export interface ReviewCompleteInput {
    prId: number;
    verdict: 'approved' | 'changes-requested';
    storyNumber?: string;
    branch?: string;
    prUrlBase?: string;
    projectKey?: string;
    comments?: ReviewComment[];
}

export interface ReviewCompleteResult {
    ok: boolean;
    target: string;
    targetPhase: string;
    /**
     * True when devops already owns this PR (the approval was processed before and devops
     * is mid-build). The caller must NOT re-transition the workflow item or re-spawn devops —
     * the review-verdict handoff re-fires on every reviewer status write, and re-transitioning
     * drags an already-advanced devops back to pending-build (409 churn). See bug #6.
     */
    alreadyDispatched?: boolean;
}

// Devops build phases that mean "this PR is already in flight on the devops desk" — any
// of these (for the same PR) makes a repeat review-complete a no-op rather than a reset.
const DEVOPS_INFLIGHT_PHASES = new Set(['pending-build', 'monitoring-build', 'build-passed', 'build-failed']);

export function applyReviewComplete(baseDir: string, input: ReviewCompleteInput): ReviewCompleteResult {
    const now = new Date().toISOString();

    if (input.verdict === 'approved') {
        // Parallel design review gate: if UX is also reviewing this PR, wait for both
        const owner = findStoryOwnerByPrId(baseDir, input.prId);
        if (owner) {
            const prs = Array.isArray(owner.status.prs) ? owner.status.prs : [];
            const pr = prs.find((p: { id: number }) => p.id === input.prId) as Record<string, unknown> | undefined;
            if (pr) {
                pr.codeReview = { verdict: 'approved', reviewedAt: now };
                resolveOpenReviewRequestsForPr(owner.status, input.prId, now);
                writeFileSync(owner.statusFile, JSON.stringify(owner.status, null, 2));
                if (pr.designReview && (pr.designReview as { verdict: string }).verdict !== 'approved') {
                    clearReviewerAfterApproval(baseDir, input.prId, now);
                    return { ok: true, target: 'waiting-for-design-review', targetPhase: 'watching-reviews' };
                }
            }
        }

        const devopsFile = resolve(baseDir, '.devops-status.json');
        let alreadyDispatched = false;
        if (existsSync(devopsFile)) {
            try {
                const existing = parseJsonUtf8File(devopsFile);
                // Idempotency: if devops already holds this PR in any in-flight build phase,
                // a re-fired review-complete must leave its desk alone (don't reset to
                // pending-build). Only the first approval writes/advances the devops desk.
                if (existing.assignedPR?.id === input.prId && DEVOPS_INFLIGHT_PHASES.has(existing.currentPhase)) {
                    alreadyDispatched = true;
                }
            } catch { /* overwrite */ }
        }
        if (!alreadyDispatched) {
            const reviewerFile = resolve(baseDir, '.reviewer-status.json');
            let prTitle = `PR #${input.prId}`;
            let prUrl = `${input.prUrlBase || ''}/${input.prId}`;
            if (existsSync(reviewerFile)) {
                try {
                    const bs = parseJsonUtf8File(reviewerFile);
                    prTitle = bs.assignedPR?.title || prTitle;
                    prUrl = bs.assignedPR?.url || prUrl;
                    input.projectKey = input.projectKey || bs.assignedPR?.projectKey || bs.projectKey;
                } catch { /* use defaults */ }
            }
            const ownerForManualGate = findStoryOwnerByPrId(baseDir, input.prId);
            const configPath = resolve(baseDir, '.sdlc-framework.config.json');
            const manualStartRequired = !!(
                (ownerForManualGate && isAgentStepMode(ownerForManualGate.agentId, configPath))
                || isAgentStepMode('devops', configPath)
            );
            const buildTask = { id: `PR-BUILD-${input.prId}`, number: `PR-BUILD-${input.prId}`, name: `Monitor build for PR #${input.prId}: ${prTitle}`, status: 'pending', hours: 1, category: 'DevOps' };
            // Register the story's workflow item id on the devops desk (bug #6). The
            // review handoff also transitions that item to devops/pending-build, but
            // complete_phase reads workflowItemId from THIS file — without it every
            // devops complete_phase is rejected ("workflow must be registered") and the
            // agent dies after the auto-resume cap, never reaching build → merge. The id
            // is stable regardless of which agent is currently active, so writing it here
            // (before devops is spawned) is race-free.
            let devopsWorkflowItemId: number | undefined;
            if (input.storyNumber) {
                try {
                    const wf = dbGetWorkflowItemByStory(input.storyNumber);
                    if (typeof wf?.id === 'number') devopsWorkflowItemId = wf.id;
                } catch { /* db not initialized (some unit tests) — non-fatal */ }
            }
            const devopsStatus = {
                currentPhase: 'pending-build',
                manualStartRequired,
                projectKey: input.projectKey || null,
                ...(devopsWorkflowItemId !== undefined ? { workflowItemId: devopsWorkflowItemId } : {}),
                assignedPR: { id: input.prId, title: prTitle, url: prUrl, storyNumber: input.storyNumber || null, branch: input.branch || null, projectKey: input.projectKey || null },
                tasks: [buildTask],
                events: [{ timestamp: now, type: 'info', message: `PR #${input.prId} approved by reviewer agent, queued for CI` }] };
            writeFileSync(devopsFile, JSON.stringify(devopsStatus, null, 2));

            clearReviewerAfterApproval(baseDir, input.prId, now);
        }
        return { ok: true, target: 'devops', targetPhase: 'pending-build', alreadyDispatched };
    } else {
        const owner = findStoryOwnerByPrId(baseDir, input.prId);
        if (owner) {
            const prs = Array.isArray(owner.status.prs) ? owner.status.prs : [];
            for (const pr of prs) {
                if ((pr as { id: number }).id === input.prId) {
                    (pr as { status: string }).status = 'changes-requested';
                }
            }
            owner.status.prs = prs;
            owner.status.currentPhase = 'addressing-feedback';
            owner.status.handoffDispatched = false;
            const events = (Array.isArray(owner.status.events) ? owner.status.events : []) as Array<{ timestamp: string; type: string; message: string }>;
            events.push({ timestamp: now, type: 'warning', message: `Changes requested on PR #${input.prId}. Addressing reviewer feedback.` });
            owner.status.events = events;
            if (Array.isArray(input.comments) && input.comments.length > 0) {
                const existing = Array.isArray(owner.status.requests) ? owner.status.requests as RequestEntry[] : [];
                const kept = existing.filter(
                    r => !(r.type === 'review' && r.prId === input.prId && r.status === 'open'),
                );
                const newRequests: RequestEntry[] = input.comments.map((c, i) => ({
                    id: c.id || `R-${input.prId}-${i + 1}`,
                    type: 'review' as const,
                    source: 'reviewer',
                    summary: c.summary,
                    ...(c.file ? { file: c.file } : {}),
                    ...(c.line ? { line: c.line } : {}),
                    ...(c.severity ? { severity: c.severity } : {}),
                    status: 'open' as const,
                    prId: input.prId,
                    createdAt: now,
                }));
                owner.status.requests = [...kept, ...newRequests];
            }
            writeFileSync(owner.statusFile, JSON.stringify(owner.status, null, 2));
        }
        return { ok: true, target: owner?.agentId || 'unknown', targetPhase: 'addressing-feedback' };
    }
}

export interface BuildCompleteInput {
    prId: number;
    result: 'passed' | 'failed';
    buildId?: number;
}

export interface BuildCompleteResult {
    ok: boolean;
    storyOwner: string;
    newPrStatus: string;
    /** Set when a DevOps wrap-up desk row is written (story-scoped id when story is known). */
    wrapUpRequestId?: string;
    /** True when build passed but some tasks are still incomplete; story stays active. */
    hasIncompleteTasks?: boolean;
    /** IDs of tasks that are not yet completed. */
    incompleteTaskIds?: string[];
}

/** Stable dashboard id for the post-CI wrap-up row (story-scoped when `storyNumber` is set). */
export function wrapUpDeskRequestId(storyNumber: string | null | undefined, prId: number): string {
    const slug = typeof storyNumber === 'string' ? storyNumber.trim().replace(/[^a-zA-Z0-9-]+/g, '') : '';
    if (slug) return `WRAPUP-${slug}-PR-${prId}`;
    return `WRAPUP-PR-${prId}`;
}

function isWrapUpDeskRequestForPr(requestId: string, prId: number): boolean {
    const s = String(requestId);
    return s.startsWith('WRAPUP-') && s.endsWith(`-PR-${prId}`);
}

function resolveWrapUpStoryForPr(devops: Record<string, unknown>, owner: StoryOwnerResult | null, prId: number): string | null {
    const ap = devops.assignedPR as { storyNumber?: unknown } | undefined;
    if (ap && typeof ap.storyNumber === 'string' && ap.storyNumber.trim()) return ap.storyNumber.trim();
    if (owner) {
        const sn = owner.status.storyNumber;
        if (typeof sn === 'string' && sn.trim()) return sn.trim();
        const prs = Array.isArray(owner.status.prs) ? owner.status.prs as Array<{ id?: number; storyNumber?: unknown }> : [];
        const row = prs.find((p) => Number(p.id) === prId);
        if (row && typeof row.storyNumber === 'string' && String(row.storyNumber).trim()) return String(row.storyNumber).trim();
    }
    return null;
}

function isTaskComplete(status?: string): boolean {
    const s = (status ?? '').toLowerCase();
    return s === 'completed' || s === 'complete' || s === 'done';
}

function taskKey(task: { id?: unknown; number?: unknown }): string {
    return String(task.id ?? task.number ?? '');
}

function resolveOpenReviewRequestsForPr(status: Record<string, unknown>, prId: number, now: string): void {
    if (!Array.isArray(status.requests)) return;
    status.requests = (status.requests as RequestEntry[]).map((request) => {
        if (request.type !== 'review' || request.prId !== prId || request.status === 'resolved') return request;
        return { ...request, status: 'resolved' as const, resolvedAt: now };
    });
}

export function applyBuildComplete(baseDir: string, input: BuildCompleteInput): BuildCompleteResult {
    const now = new Date().toISOString();
    const newPrStatus = input.result === 'passed' ? 'completed' : 'changes-requested';
    let wrapUpRequestId: string | undefined;

    const owner = findStoryOwnerByPrId(baseDir, input.prId);
    if (owner) {
        const prs = Array.isArray(owner.status.prs) ? owner.status.prs : [];
        let batchTaskIds: string[] = [];
        for (const pr of prs) {
            if ((pr as { id: number }).id === input.prId) {
                (pr as { status: string }).status = newPrStatus;
                const prBatch = (pr as { batchTaskIds?: unknown }).batchTaskIds;
                if (Array.isArray(prBatch)) batchTaskIds = prBatch.map((id) => String(id)).filter(Boolean);
            }
        }
        owner.status.prs = prs;
        const tasks = Array.isArray(owner.status.tasks) ? owner.status.tasks as Array<{ id?: string; number?: string; status?: string; completedAt?: string }> : [];
        if (input.result === 'passed') {
            if (batchTaskIds.length === 0 && Array.isArray(owner.status.activePrBatchTaskIds)) {
                batchTaskIds = (owner.status.activePrBatchTaskIds as unknown[]).map((id) => String(id)).filter(Boolean);
            }
            if (batchTaskIds.length === 0) {
                batchTaskIds = tasks.filter(t => String(t.status ?? '') === 'in_progress').map(taskKey).filter(Boolean);
            }
            const batchIdSet = new Set(batchTaskIds);
            for (const task of tasks) {
                if (!batchIdSet.has(taskKey(task))) continue;
                task.status = 'completed';
                task.completedAt = now;
            }
            owner.status.tasks = tasks;
            delete owner.status.activePrBatchTaskIds;
            const incompleteTasks = tasks.filter(t => !isTaskComplete(t.status));
            const events = (Array.isArray(owner.status.events) ? owner.status.events : []) as Array<{
                timestamp: string;
                type: string;
                message: string;
            }>;
            owner.status.events = events;
            if (batchTaskIds.length > 0) {
                events.push({ timestamp: now, type: 'success', message: `Build passed for PR #${input.prId}; completed selected batch: ${batchTaskIds.join(', ')}.` });
            }
            if (incompleteTasks.length > 0) {
                const configPath = resolve(baseDir, '.sdlc-framework.config.json');
                const agentInStepMode = isAgentStepMode(owner.agentId, configPath);
                owner.status.currentPhase = agentInStepMode ? 'analyzing' : 'reading-story';
                owner.status.handoffDispatched = false;
                const ids = incompleteTasks.map(t => t.number || t.id || 'unknown').join(', ');
                events.push({ timestamp: now, type: 'warning', message: `Build passed for PR #${input.prId} but ${incompleteTasks.length} task(s) remain: ${ids}. Picking up remaining work.` });
            } else {
                owner.status.currentPhase = 'complete';
                events.push({ timestamp: now, type: 'success', message: `Build passed for PR #${input.prId} - story complete` });
            }
        } else {
            const existing = Array.isArray(owner.status.requests) ? owner.status.requests as RequestEntry[] : [];
            existing.push({
                id: `B-${input.prId}-${input.buildId || 1}`,
                type: 'build',
                source: 'devops',
                summary: `Build${input.buildId ? ` #${input.buildId}` : ''} failed for PR #${input.prId}. Fix build errors and re-push.`,
                status: 'open',
                prId: input.prId,
                createdAt: now });
            owner.status.requests = existing;
        }
        writeFileSync(owner.statusFile, JSON.stringify(owner.status, null, 2));
    }

    const devopsFile = resolve(baseDir, '.devops-status.json');
    if (existsSync(devopsFile)) {
        try {
            const devops = parseJsonUtf8File(devopsFile) as Record<string, unknown>;
            const targetPhase = input.result === 'passed' ? 'build-passed' : 'build-failed';
            const phaseChanged = devops.currentPhase !== targetPhase;
            if (phaseChanged) {
                devops.currentPhase = targetPhase;
                if (!Array.isArray(devops.events)) devops.events = [];
                (devops.events as Array<{ timestamp: string; type: string; message: string }>).push({
                    timestamp: now,
                    type: input.result === 'passed' ? 'success' : 'error',
                    message: `Build ${input.buildId ? `#${input.buildId} ` : ''}${input.result} for PR #${input.prId}` });
            }
            const deskRaw = devops.assignedPR as { id?: unknown } | undefined;
            const deskPrId = deskRaw != null && Number.isFinite(Number(deskRaw.id)) ? Number(deskRaw.id) : null;
            /** Skip wrap-up if the desk is clearly assigned to a different PR (avoid WRAPUP for the wrong id). */
            const deskConflict = deskPrId !== null && deskPrId !== input.prId;
            const ownerTasks = owner ? (Array.isArray(owner.status.tasks) ? owner.status.tasks as Array<{ status?: string }> : []) : [];
            const ownerHasIncomplete = ownerTasks.some(t => !isTaskComplete(t.status));
            const shouldRecordWrapup = input.result === 'passed' && !deskConflict && !ownerHasIncomplete;
            if (shouldRecordWrapup) {
                const wrapStory = resolveWrapUpStoryForPr(devops, owner, input.prId);
                const wrapId = wrapUpDeskRequestId(wrapStory, input.prId);
                wrapUpRequestId = wrapId;
                const existingReq = Array.isArray(devops.requests) ? devops.requests as RequestEntry[] : [];
                const others = existingReq.filter((r) => !isWrapUpDeskRequestForPr(r.id, input.prId));
                const storyLead = wrapStory ? `Story ${wrapStory} ` : '';
                others.push({
                    id: wrapId,
                    type: 'build',
                    source: 'sdlc-framework',
                    summary: `${storyLead}CI passed for PR #${input.prId} — run story wrap-up (see .cursor/rules/story-wrapup.mdc): ADO auto-complete, Agility release, reset agent status files. Then idle DevOps in .devops-status.json.`,
                    status: 'open',
                    prId: input.prId,
                    createdAt: now,
                    ...(wrapStory ? { storyNumber: wrapStory } : {}) });
                devops.requests = others;
            }
            if (phaseChanged || shouldRecordWrapup) {
                writeFileSync(devopsFile, JSON.stringify(devops, null, 2));
            }
        } catch { /* leave as-is */ }
    }

    const reviewerFile = resolve(baseDir, '.reviewer-status.json');
    if (existsSync(reviewerFile)) {
        try {
            const rv = parseJsonUtf8File(reviewerFile) as Record<string, unknown>;
            const rvPrId = (rv.assignedPR as { id?: unknown } | null)?.id;
            if (rv.currentPhase === 'watching-build' && Number(rvPrId) === input.prId) {
                const rvEvents = (Array.isArray(rv.events) ? rv.events : []) as Array<{ timestamp: string; type: string; message: string }>;
                rvEvents.push({ timestamp: now, type: input.result === 'passed' ? 'success' : 'warning', message: `Build ${input.result} for PR #${input.prId}. Review desk cleared.` });
                writeFileSync(reviewerFile, JSON.stringify({ ...rv, currentPhase: 'idle', assignedPR: null, events: rvEvents }, null, 2));
            }
        } catch { /* non-critical */ }
    }

    const configPath = resolve(baseDir, '.sdlc-framework.config.json');
    if (isMockExternalMode(configPath) && input.result === 'passed') {
        setMockPullRequestStatus(baseDir, input.prId, 'completed');
    }

    const tasks = owner ? (Array.isArray(owner.status.tasks) ? owner.status.tasks as Array<{ id?: string; number?: string; status?: string }> : []) : [];
    const incompleteTaskIds = tasks.filter(t => !isTaskComplete(t.status)).map(t => t.number || t.id || 'unknown');
    const hasIncompleteTasks = incompleteTaskIds.length > 0 && input.result === 'passed';
    return { ok: true, storyOwner: owner?.agentId || 'unknown', newPrStatus, wrapUpRequestId, hasIncompleteTasks: hasIncompleteTasks || undefined, incompleteTaskIds: hasIncompleteTasks ? incompleteTaskIds : undefined };
}

function clearReviewerAfterApproval(baseDir: string, prId: number, now: string): void {
    const reviewerFile = resolve(baseDir, '.reviewer-status.json');
    try {
        const reviewerData = existsSync(reviewerFile)
            ? parseJsonUtf8File(reviewerFile)
            : {};
        const events = Array.isArray(reviewerData.events) ? reviewerData.events : [];
        events.push({ timestamp: now, type: 'success', message: `PR #${prId} approved and handed off to DevOps. Watching CI build.` });
        const updatedReviewer = {
            ...reviewerData,
            currentPhase: 'watching-build',
            events,
            handoffDispatched: true };
        writeFileSync(reviewerFile, JSON.stringify(updatedReviewer, null, 2));
    } catch { /* non-critical */ }
}

function proceedToDevops(baseDir: string, prId: number, input: { storyNumber?: string; branch?: string; projectKey?: string; prUrlBase?: string }, now: string): void {
    const devopsFile = resolve(baseDir, '.devops-status.json');
    const reviewerFile = resolve(baseDir, '.reviewer-status.json');
    let prTitle = `PR #${prId}`;
    let prUrl = `${input.prUrlBase || ''}/${prId}`;
    if (existsSync(reviewerFile)) {
        try {
            const bs = parseJsonUtf8File(reviewerFile);
            prTitle = bs.assignedPR?.title || prTitle;
            prUrl = bs.assignedPR?.url || prUrl;
            input.projectKey = input.projectKey || bs.assignedPR?.projectKey || bs.projectKey;
        } catch { /* use defaults */ }
    }
    const ownerForManualGate = findStoryOwnerByPrId(baseDir, prId);
    const configPath = resolve(baseDir, '.sdlc-framework.config.json');
    const manualStartRequired = !!(
        (ownerForManualGate && isAgentStepMode(ownerForManualGate.agentId, configPath))
        || isAgentStepMode('devops', configPath)
    );
    const dualBuildTask = { id: `PR-BUILD-${prId}`, number: `PR-BUILD-${prId}`, name: `Monitor build for PR #${prId}: ${prTitle}`, status: 'pending', hours: 1, category: 'DevOps' };
    const devopsStatus = {
        currentPhase: 'pending-build',
        manualStartRequired,
        projectKey: input.projectKey || null,
        assignedPR: { id: prId, title: prTitle, url: prUrl, storyNumber: input.storyNumber || null, branch: input.branch || null, projectKey: input.projectKey || null },
        tasks: [dualBuildTask],
        events: [{ timestamp: now, type: 'info', message: `PR #${prId} approved by both code and design reviewers, queued for CI` }] };
    writeFileSync(devopsFile, JSON.stringify(devopsStatus, null, 2));
}

// ── Design Review (parallel gate with code review) ──────────────────────

export interface DesignReviewCompleteInput {
    prId: number;
    verdict: 'approved' | 'changes-requested';
    storyNumber?: string;
    comments?: string;
    designComments?: ReviewComment[];
}

export interface DesignReviewCompleteResult {
    ok: boolean;
    bothApproved: boolean;
    target: string;
    targetPhase: string;
}

export function applyDesignReviewComplete(baseDir: string, input: DesignReviewCompleteInput): DesignReviewCompleteResult {
    const now = new Date().toISOString();
    const owner = findStoryOwnerByPrId(baseDir, input.prId);
    if (!owner) {
        return { ok: false, bothApproved: false, target: 'unknown', targetPhase: 'unknown' };
    }

    const prs = Array.isArray(owner.status.prs) ? owner.status.prs : [];
    const pr = prs.find((p: { id: number }) => p.id === input.prId) as Record<string, unknown> | undefined;
    if (!pr) {
        return { ok: false, bothApproved: false, target: owner.agentId, targetPhase: 'unknown' };
    }

    pr.designReview = { verdict: input.verdict, reviewedAt: now, comments: input.comments || null };

    // Update UX status
    const uxStatusFile = resolve(baseDir, '.ux-status.json');
    if (existsSync(uxStatusFile)) {
        try {
            const uxStatus = parseJsonUtf8File(uxStatusFile);
            if (!Array.isArray(uxStatus.events)) uxStatus.events = [];
            uxStatus.events.push({
                timestamp: now,
                type: input.verdict === 'approved' ? 'success' : 'warning',
                message: `Design review ${input.verdict} for PR #${input.prId}.${input.comments ? ` ${input.comments}` : ''}` });
            if (input.verdict === 'approved') {
                uxStatus.currentPhase = 'complete';
            }
            writeFileSync(uxStatusFile, JSON.stringify(uxStatus, null, 2));
        } catch { /* non-critical */ }
    }

    if (input.verdict === 'changes-requested') {
        owner.status.currentPhase = 'addressing-feedback';
        owner.status.handoffDispatched = false;
        const events = (Array.isArray(owner.status.events) ? owner.status.events : []) as Array<{ timestamp: string; type: string; message: string }>;
        events.push({ timestamp: now, type: 'warning', message: `Design changes requested on PR #${input.prId}. Addressing design feedback.` });
        owner.status.events = events;
        const existing = Array.isArray(owner.status.requests) ? owner.status.requests as RequestEntry[] : [];
        if (Array.isArray(input.designComments) && input.designComments.length > 0) {
            const newRequests: RequestEntry[] = input.designComments.map((c, i) => ({
                id: c.id || `D-${input.prId}-${i + 1}`,
                type: 'design' as const,
                source: 'ux',
                summary: c.summary,
                ...(c.file ? { file: c.file } : {}),
                ...(c.line ? { line: c.line } : {}),
                status: 'open' as const,
                prId: input.prId,
                createdAt: now }));
            owner.status.requests = [...existing, ...newRequests];
        } else if (input.comments) {
            existing.push({
                id: `D-${input.prId}-1`,
                type: 'design',
                source: 'ux',
                summary: input.comments,
                status: 'open',
                prId: input.prId,
                createdAt: now });
            owner.status.requests = existing;
        }
        writeFileSync(owner.statusFile, JSON.stringify(owner.status, null, 2));
        return { ok: true, bothApproved: false, target: owner.agentId, targetPhase: 'addressing-feedback' };
    }

    // Verdict is approved — check if code review is also done
    const codeReview = pr.codeReview as { verdict: string } | undefined;
    const codeApproved = codeReview?.verdict === 'approved' || (pr.status as string) === 'approved';

    if (codeApproved) {
        // Both approved — proceed to devops
        owner.status.prs = prs;
        writeFileSync(owner.statusFile, JSON.stringify(owner.status, null, 2));
        proceedToDevops(baseDir, input.prId, { storyNumber: input.storyNumber }, now);
        clearReviewerAfterApproval(baseDir, input.prId, now);
        return { ok: true, bothApproved: true, target: 'devops', targetPhase: 'pending-build' };
    }

    // Only design approved, waiting for code review
    owner.status.prs = prs;
    writeFileSync(owner.statusFile, JSON.stringify(owner.status, null, 2));
    return { ok: true, bothApproved: false, target: 'waiting-for-code-review', targetPhase: 'watching-reviews' };
}

export interface DesignReadyInput {
    storyNumber: string;
    storyName?: string;
    designSpec?: string;
    targetAgent?: string;
    execMode?: string;
    /** When `autonomous`, target begins at reading-story (no dashboard approval). */
    workflowMode?: 'notify' | 'autonomous';
}

export interface DesignReadyResult {
    ok: boolean;
    targetAgent: string;
    targetPhase: string;
}

export function applyDesignReady(baseDir: string, input: DesignReadyInput): DesignReadyResult {
    const target = input.targetAgent || 'frontend';
    const now = new Date().toISOString();
    const specFile = input.designSpec || '.ux-design-spec.md';

    const targetFile = resolve(baseDir, `.${target}-status.json`);
    let alreadyAssigned = false;
    if (existsSync(targetFile)) {
        try {
            const existing = parseJsonUtf8File(targetFile);
            if (existing.storyNumber === input.storyNumber && existing.collaborators?.includes('ux')) {
                alreadyAssigned = true;
            }
        } catch { /* overwrite */ }
    }
    if (!alreadyAssigned) {
        const autonomous = input.workflowMode === 'autonomous';
        const targetStatus = {
            storyNumber: input.storyNumber,
            storyName: input.storyName || null,
            currentPhase: autonomous ? ('reading-story' as const) : ('pending-approval' as const),
            currentTask: null,
            startedAt: autonomous ? now : null,
            executionMode: input.execMode || 'balanced',
            collaborators: ['ux'],
            designSpec: specFile,
            tokens: defaultTokenState(),
            tasks: [],
            prs: [],
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
            events: [{
                timestamp: now,
                type: autonomous ? ('success' as const) : ('info' as const),
                message: autonomous
                    ? `Shared story from ux agent. Autonomous mode — workflow starting. Design spec at ${specFile}`
                    : `Shared story from ux agent. Design spec at ${specFile}` }] };
        writeFileSync(targetFile, JSON.stringify(targetStatus, null, 2));
    }

    const uxStatusFile = resolve(baseDir, '.ux-status.json');
    if (existsSync(uxStatusFile)) {
        try {
            const uxStatus = parseJsonUtf8File(uxStatusFile);
            if (uxStatus.currentPhase !== 'collaborating') {
                uxStatus.currentPhase = 'collaborating';
                if (!uxStatus.collaborators) uxStatus.collaborators = [];
                if (!uxStatus.collaborators.includes(target)) uxStatus.collaborators.push(target);
                if (!Array.isArray(uxStatus.events)) uxStatus.events = [];
                uxStatus.events.push({ timestamp: now, type: 'success', message: `Handed off to ${target}. Design spec ready for implementation.` });
                writeFileSync(uxStatusFile, JSON.stringify(uxStatus, null, 2));
            }
        } catch { /* leave as-is */ }
    }

    const targetPhase = input.workflowMode === 'autonomous' ? 'reading-story' : 'pending-approval';
    return { ok: true, targetAgent: target, targetPhase };
}
