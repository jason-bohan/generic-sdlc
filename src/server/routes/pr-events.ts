import { writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { getProjectProfile } from '../project-config';
import { spawnAgent } from '../spawn-agent';
import { isGlobalStepMode } from '../stepMode';
import { notify } from '../providers';
import { resolveAgentDisplayName } from '../agent-display-names';
import { dbUpsertWorkflowArtifact } from '../db';
import { readBody, json } from '../router';
import { isAzureDevOpsUrl } from '../test-safety';
import { getExternalMode, isMockExternalMode } from '../external-mode';
import { upsertMockPullRequest } from '../mock-external';
import { buildReviewerPrompt } from '../reviewer-prompt';
import {
    getSchedulerConfig,
    getAgentModel,
    isAgentStepMode,
    recordWorkflowMilestone,
    storyNumberFromOwnerStatus } from '../route-shared';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';

/**
 * Pre-compute the authoritative PR diff for the reviewer and write it to
 * `.reviewer-diff.patch`. Uses a committed-ref diff (`<target>...<branch>`), which is
 * immune to uncommitted changes in the project working tree — so the reviewer judges
 * exactly what the PR changes and never wanders into stray local edits (e.g. an
 * unrelated half-finished file left in the checkout). Returns the relative path the
 * reviewer can read, or null if it can't be produced (reviewer then falls back to gh).
 */
function writeReviewerDiff(rootDir: string, configFile: string, projectKey: string | null | undefined, branch: string | null): string | null {
    if (!branch) return null;
    const profile = getProjectProfile(configFile, projectKey ?? undefined);
    const ws = profile.workspacePath;
    if (!ws || !existsSync(ws)) return null;
    const target = profile.targetBranch || 'main';
    const range = `${target}...${branch}`;
    try {
        const stat = execFileSync('git', ['-C', ws, 'diff', '--stat', '-M', range], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000 });
        const diff = execFileSync('git', ['-C', ws, 'diff', '-M', range], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
        const capped = diff.length > 200_000 ? `${diff.slice(0, 200_000)}\n... [diff truncated at 200KB — review the files above; fetch more with \`git -C <ws> show <branch>:<path>\`]\n` : diff;
        const body = `# Authoritative PR diff — committed changes for this PR only (${range}).\n`
            + `# This is the COMPLETE change set. Review ONLY what appears below.\n`
            + `# Do NOT inspect the project working tree: uncommitted files there are NOT part of this PR.\n\n`
            + `## Files changed\n${stat}\n## Diff\n${capped}`;
        writeFileSync(resolve(rootDir, '.reviewer-diff.patch'), body);
        return '.reviewer-diff.patch';
    } catch {
        return null;
    }
}

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/pr/created ──────────────────────────────────────────────────────
    use('/api/pr/created', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId, prId, prTitle, prUrl, storyNumber, branch, projectKey } = JSON.parse(body);
            if (!agentId || !prId) { json(res, { error: 'agentId and prId are required' }, 400); return; }
            if (isMockExternalMode(configFile) && isAzureDevOpsUrl(prUrl)) {
                json(res, {
                    error: 'Mock mode refuses to register a live Azure DevOps PR. Do not push branches or create Azure PRs while externalMode is mock.',
                    mode: 'mock',
                    prUrl }, 409);
                return;
            }
            const config = getSchedulerConfig(rootDir);
            const now = new Date().toISOString();
            let statusProjectKey = typeof projectKey === 'string' && projectKey.trim() ? projectKey.trim() : null;
            const agentStatusFile = resolve(rootDir, `.${agentId}-status.json`);
            const agentStatus = existsSync(agentStatusFile) ? parseJsonUtf8File(agentStatusFile) : null;
            statusProjectKey = statusProjectKey || agentStatus?.projectKey || null;
            const prProjectProfile = getProjectProfile(configFile, statusProjectKey || undefined);
            const prUrlBase = prProjectProfile.prUrlBase || config.project?.prUrlBase || '';
            const prUrlFull = prUrl || (isMockExternalMode(configFile) ? `http://localhost:3001/mock-prs/${prId}` : (prUrlBase ? `${prUrlBase}/${prId}` : `PR #${prId}`));
            // Branch HEAD commit — the idempotency key for creating-pr. A spurious re-entry
            // (no new code) sees the same SHA; a real rework pushes a new commit (new SHA).
            // Worktrees share refs with the repo root, so `rev-parse <branch>` resolves the tip.
            let headSha: string | null = null;
            const branchStr = typeof branch === 'string' ? branch.trim() : '';
            const repoRoot = prProjectProfile.workspacePath;
            if (branchStr && repoRoot && existsSync(repoRoot) && !isMockExternalMode(configFile)) {
                try {
                    headSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', branchStr], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
                } catch { headSha = null; }
            }
            let priorHeadSha: string | null = null;
            if (existsSync(agentStatusFile)) {
                const persistedBatchIds = Array.isArray(agentStatus?.activePrBatchTaskIds)
                    ? agentStatus.activePrBatchTaskIds.map((id: unknown) => String(id)).filter(Boolean)
                    : [];
                const inProgressBatchIds = Array.isArray(agentStatus?.tasks)
                    ? agentStatus.tasks
                        .filter((t: { id?: unknown; number?: unknown; status?: unknown }) => String(t.status ?? '') === 'in_progress')
                        .map((t: { id?: unknown; number?: unknown }) => String(t.id ?? t.number ?? ''))
                        .filter(Boolean)
                    : [];
                const batchTaskIds = persistedBatchIds.length > 0 ? persistedBatchIds : inProgressBatchIds;
                if (batchTaskIds.length > 0 && Array.isArray(agentStatus?.tasks)) {
                    const batchSet = new Set(batchTaskIds);
                    agentStatus.tasks = agentStatus.tasks.map((task: { id?: unknown; number?: unknown; status?: unknown }) => {
                        const taskId = String(task.id ?? task.number ?? '');
                        if (!batchSet.has(taskId) || String(task.status ?? '') === 'failed') return task;
                        return { ...task, status: 'completed' };
                    });
                }
                const prEntry = { id: prId, title: prTitle || `PR #${prId}`, status: 'active', comments: 0, approvals: 0, url: prUrlFull, projectKey: statusProjectKey, batchTaskIds, headSha };
                if (!agentStatus.prs) agentStatus.prs = [];
                const existingIdx = agentStatus.prs.findIndex((p: any) => p.id === prId);
                priorHeadSha = existingIdx >= 0 ? (agentStatus.prs[existingIdx]?.headSha ?? null) : null;
                if (existingIdx >= 0) agentStatus.prs[existingIdx] = prEntry; else agentStatus.prs.push(prEntry);
                agentStatus.activePrBatchTaskIds = batchTaskIds;
                writeFileSync(agentStatusFile, JSON.stringify(agentStatus, null, 2));
            }
            // In mock mode, ensure a matching row exists in mock ADO state so /api/reviewer/prs finds it
            if (isMockExternalMode(configFile)) {
                upsertMockPullRequest(rootDir, Number(prId), {
                    title: prTitle || `PR #${prId}`,
                    sourceRefName: branch ? `refs/heads/${branch}` : undefined,
                    status: 'active' });
            }
            // Idempotent creating-pr: an already-registered PR on the same branch HEAD is a
            // spurious re-entry (no new code). Skip reviewer re-assignment and milestone churn;
            // the PR is unchanged and already parked at watching-reviews. A real rework pushes
            // a new commit (different SHA) and falls through to a fresh review below.
            if (priorHeadSha != null && headSha != null && priorHeadSha === headSha) {
                json(res, { ok: true, duplicate: true, reason: 'pr-already-registered-same-commit', reviewerPhase: 'duplicate', prId });
                return;
            }
            const creatorStepMode = isAgentStepMode(agentId, rootDir);
            const configPathResolved = resolve(rootDir, '.sdlc-framework.config.json');
            const globalStepModeOn = isGlobalStepMode(configPathResolved);
            let reviewerDeskAssigned = false;
            let alreadyReviewerDeskDup = false;
            let agentSpawned = false;
            let teamsNotified = false;
            const reviewerStatusFile = resolve(rootDir, '.reviewer-status.json');
            try {
                if (existsSync(reviewerStatusFile)) {
                    const prev = parseJsonUtf8File(reviewerStatusFile);
                    if (prev.assignedPR?.id === prId && headSha == null) {
                        // No branch SHA available (e.g. mock mode) — the same-commit short-circuit
                        // above can't run, so fall back to phase-based dedup: only re-review when
                        // the reviewer had requested changes / is awaiting fixes.
                        if (prev.currentPhase !== 'changes-requested' && prev.currentPhase !== 'waiting-for-fixes') {
                            alreadyReviewerDeskDup = true;
                        }
                    }
                    // With a SHA available, reaching here means a new commit (real rework) →
                    // re-assign for re-review; same-commit re-entries already returned early.
                }
            } catch { /* ok */ }
            if (!alreadyReviewerDeskDup) {
                const reviewTask = { id: `PR-REVIEW-${prId}`, number: `PR-REVIEW-${prId}`, name: `Review PR #${prId}: ${prTitle || 'Code review'}`, status: 'pending', hours: 1, category: 'Review' };
                // Pre-compute the clean committed diff so the reviewer judges from it, not the
                // (possibly dirty) project working tree — see writeReviewerDiff / bug #8.
                const diffPath = writeReviewerDiff(rootDir, configFile, statusProjectKey, branch);
                writeFileSync(reviewerStatusFile, JSON.stringify({
                    projectKey: statusProjectKey,
                    assignedPR: { id: prId, title: prTitle || `PR #${prId}`, url: prUrlFull, storyNumber: storyNumber || null, branch: branch || null, projectKey: statusProjectKey, ...(diffPath ? { diffPath } : {}) },
                    currentPhase: 'pending-review',
                    requestedAt: now,
                    handoffDispatched: false,
                    tasks: [reviewTask],
                    events: [{ timestamp: now, type: 'info', message: `PR #${prId} assigned for review by ${agentId}${storyNumber ? ` (story ${storyNumber})` : ''}` }] }, null, 2));
                reviewerDeskAssigned = true;
                await notify(rootDir, { title: `🔀 PR Created: #${prId}`, body: `**${resolveAgentDisplayName(agentId, rootDir)}** created PR [#${prId}](${prUrlFull})${storyNumber ? ` for story **${storyNumber}**` : ''}. Awaiting **${resolveAgentDisplayName('reviewer', rootDir)}** review.\n\n${prTitle || ''}`, color: 'D97706' });
                teamsNotified = true;
                // Only auto-spawn reviewer when step mode is off for both the creator workflow and reviewer desk.
                if (!globalStepModeOn && !creatorStepMode && !isAgentStepMode('reviewer', rootDir)) {
                    try { agentSpawned = spawnAgent('reviewer', buildReviewerPrompt(rootDir, prId), rootDir, getAgentModel('reviewer', rootDir)).spawned; } catch (e) { console.error('[handoff] reviewer spawn failed:', e); }
                }
            }
            // Notify UX agent for design review if story has collaborators: ['ux']
            let uxNotified = false;
            if (agentStatus?.collaborators?.includes('ux')) {
                const uxStatusFile = resolve(rootDir, '.ux-status.json');
                try {
                    const uxStatus = existsSync(uxStatusFile) ? parseJsonUtf8File(uxStatusFile) : {};
                    uxStatus.currentPhase = 'reviewing-design';
                    uxStatus.assignedPR = { id: prId, title: prTitle || `PR #${prId}`, url: prUrlFull, storyNumber: storyNumber || null, branch: branch || null };
                    if (!Array.isArray(uxStatus.events)) uxStatus.events = [];
                    uxStatus.events.push({ timestamp: now, type: 'info', message: `PR #${prId} created by ${agentId} — entering design review.` });
                    writeFileSync(uxStatusFile, JSON.stringify(uxStatus, null, 2));
                    uxNotified = true;
                    // Initialize designReview field on the PR so the parallel gate is active
                    if (existsSync(agentStatusFile)) {
                        const refreshedStatus = parseJsonUtf8File(agentStatusFile);
                        const prEntry = (refreshedStatus.prs || []).find((p: any) => p.id === prId);
                        if (prEntry && !prEntry.designReview) {
                            prEntry.designReview = { verdict: 'pending', reviewedAt: null };
                            writeFileSync(agentStatusFile, JSON.stringify(refreshedStatus, null, 2));
                        }
                    }
                } catch (e) { console.error('[pr/created] UX notification failed:', e); }
            }

            const workflowStoryNumber = typeof storyNumber === 'string' && storyNumber.trim()
                ? storyNumber.trim()
                : storyNumberFromOwnerStatus(agentStatus);
            try {
                const workflow = recordWorkflowMilestone({
                    storyNumber: workflowStoryNumber,
                    agentId,
                    phase: 'creating-pr',
                    eventType: 'pr-created',
                    outputs: {
                        [isMockExternalMode(configFile) ? 'mockPr' : 'pr']: {
                            id: prId,
                            title: prTitle || `PR #${prId}`,
                            url: prUrlFull,
                            branch: branch || null,
                            projectKey: statusProjectKey },
                        handoff: {
                            reviewerPhase: alreadyReviewerDeskDup ? 'duplicate' : 'pending-review',
                            reviewerAutoSpawned: agentSpawned,
                            reviewerAutoSpawnSkippedReason: reviewerDeskAssigned && (globalStepModeOn || creatorStepMode || isAgentStepMode('reviewer', rootDir))
                                ? globalStepModeOn ? 'global-step-mode' : creatorStepMode ? 'creator-step-mode' : 'reviewer-step-mode'
                                : undefined,
                            uxNotified },
                        auditEvent: { route: '/api/pr/created', externalMode: getExternalMode(configFile) } },
                    message: `PR #${prId} registered for story ${workflowStoryNumber || 'unknown'}`,
                    transition: {
                        agentId,
                        nextPhase: 'watching-reviews',
                        outputs: { auditEvent: { route: '/api/pr/created' } },
                        message: `Story is watching reviews for PR #${prId}` } });
                if (workflow) {
                    dbUpsertWorkflowArtifact({
                        workflowItemId: workflow.id,
                        artifactType: isMockExternalMode(configFile) ? 'mock-pr' : 'pr',
                        artifactKey: String(prId),
                        payload: { id: prId, title: prTitle || `PR #${prId}`, url: prUrlFull, branch: branch || null, projectKey: statusProjectKey } });
                }
            } catch (workflowErr) {
                console.warn('[pr/created] workflow audit failed:', workflowErr);
            }

            json(res, {
                ok: true,
                reviewerPhase: alreadyReviewerDeskDup ? 'duplicate' : 'pending-review',
                reviewerAutoSpawnSkippedDueToGlobalStep: reviewerDeskAssigned && globalStepModeOn,
                reviewerAutoSpawnSkippedReason: reviewerDeskAssigned && (globalStepModeOn || creatorStepMode || isAgentStepMode('reviewer', rootDir))
                    ? globalStepModeOn ? 'global-step-mode' : creatorStepMode ? 'creator-step-mode' : 'reviewer-step-mode'
                    : undefined,
                teamsNotified,
                agentSpawned,
                stepMode: creatorStepMode,
                globalStepMode: globalStepModeOn,
                uxNotified });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
