import { writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { findStoryOwnerByPrId, applyReviewComplete, applyBuildComplete, applyDesignReady, applyDesignReviewComplete, loadReviewerCommentsAsReviewComments, wrapUpDeskRequestId } from '../handoff';
import type { ReviewComment } from '../handoff';
import { tryClaimBuildCompleteNotification } from '../build-complete-dedup';
import { voteOnPr } from '../ado-bridge';
import { getProjectProfile } from '../project-config';
import { cleanupStoryWorktrees, resolveWorktreeRepoRoots } from '../worktree-cleanup';
import { spawnAgent } from '../spawn-agent';
import { isGlobalStepMode } from '../stepMode';
import { notify } from '../providers';
import { skillSubdirForAgentId } from '../../shared/agentSkillDirs';
import { resolveAgentDisplayName } from '../agent-display-names';
import { dbUpsertWorkflowArtifact } from '../db';
import { saveReviewPending, completeReviewTrainingData } from '../reviewTrainingData';
import { readBody, json, cors } from '../router';
import { getExternalMode, isMockExternalMode } from '../external-mode';
import { setMockPullRequestStatus } from '../mock-external';
import { getExecMode } from '../modes';
import { getSchedulerWorkflowMode } from '../schedulerMode';
import {
    getSchedulerConfig,
    getAgentModel,
    isAgentStepMode,
    recordWorkflowMilestone,
    storyNumberFromOwnerStatus } from '../route-shared';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';
import { bumpReworkRound, resetReworkRound, reworkAction, markReworkStuck, markEscalated } from '../rework-cap';
import { saveReviewPending, completeReviewTrainingData } from '../reviewTrainingData';

/**
 * Fallback feedback source for a changes-requested handoff. The loop-driver reviewer
 * posts its comments to the PR host via `gh pr comment` but does NOT write them to
 * `.reviewer-comments.json` — so the dev would otherwise be sent to addressing-feedback
 * with an empty request list and nothing to act on (bug #9). Pull the reviewer's actual
 * PR comments from the host so the feedback reaches the dev. GitHub only; no-ops otherwise.
 */
function fetchPrReviewCommentsFromHost(configFile: string, prId: number, projectKey?: string | null): ReviewComment[] | undefined {
    const ws = getProjectProfile(configFile, projectKey ?? undefined).workspacePath;
    if (!ws || !existsSync(ws)) return undefined;
    let repo: string | undefined;
    try {
        const remote = execFileSync('git', ['-C', ws, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5_000 }).trim();
        repo = remote.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1];
    } catch { return undefined; }
    if (!repo) return undefined;
    try {
        const out = execFileSync('gh', ['pr', 'view', String(prId), '-R', repo, '--json', 'comments'], { encoding: 'utf8', timeout: 15_000 });
        const data = JSON.parse(out) as { comments?: Array<{ body?: string }> };
        const comments: ReviewComment[] = [];
        (data.comments ?? []).forEach((c, i) => {
            const body = (c.body ?? '').trim();
            if (body) comments.push({ id: `R-${prId}-host-${i + 1}`, summary: body.slice(0, 2000) });
        });
        return comments.length ? comments : undefined;
    } catch { return undefined; }
}

/**
 * Last-resort feedback source: the reviewer's own status events. The deepseek loop-driver
 * reviewer routinely neither posts a `gh pr comment` (its write tools are disabled, and it
 * doesn't shell out to `gh`) nor writes `.reviewer-comments.json` — it records the finding
 * ONLY as a `.reviewer-status.json` event. Without this, a changes-requested handoff reaches
 * the dev with an empty request list; the dev reworks BLIND and reproduces the same defect,
 * looping forever (observed: deepseek correctly flagged a route placed inside the wrong block,
 * but the finding never reached the 8B backend). Harvest the reviewer's recent finding text so
 * the dev at least gets the reviewer's actual words to act on.
 */
export function harvestReviewerFindingFromStatus(rootDir: string, prId: number): ReviewComment[] | undefined {
    try {
        const s = parseJsonUtf8File(resolve(rootDir, '.reviewer-status.json')) as { assignedPR?: { id?: unknown }; events?: Array<{ type?: string; message?: unknown }> };
        const deskId = Number(s.assignedPR?.id);
        if (Number.isFinite(deskId) && deskId !== prId) return undefined; // status is about a different PR
        const msgs = (s.events ?? [])
            .filter(e => (e.type === 'phase' || e.type === 'info') && typeof e.message === 'string')
            .map(e => String((e as { message: string }).message).trim())
            .filter(Boolean)
            // Drop content-free boilerplate; keep the substantive findings.
            .filter(m => !/^(pr #\d+ assigned|assigned for review|reset to idle|starting review)/i.test(m));
        const uniq = [...new Set(msgs)].slice(-4);
        if (!uniq.length) return undefined;
        return [{ id: `R-${prId}-status-1`, summary: uniq.join('; ').slice(0, 2000) }];
    } catch { return undefined; }
}

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/handoff/review-complete ─────────────────────────────────────────
    use('/api/handoff/review-complete', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { prId, verdict, storyNumber, branch, commentCount, projectKey, comments } = JSON.parse(body);
            if (!prId || !verdict) { json(res, { error: 'prId and verdict are required' }, 400); return; }
            const config = getSchedulerConfig(rootDir);
            let statusProjectKey = typeof projectKey === 'string' && projectKey.trim() ? projectKey.trim() : undefined;
            try {
                const reviewerFile = resolve(rootDir, '.reviewer-status.json');
                if (!statusProjectKey && existsSync(reviewerFile)) {
                    const bs = parseJsonUtf8File(reviewerFile);
                    statusProjectKey = bs.assignedPR?.projectKey || bs.projectKey || undefined;
                }
            } catch { /* ok */ }
            const prUrlBase = (getProjectProfile(configFile, statusProjectKey)).prUrlBase || config.project?.prUrlBase || '';
            const prIdNum = Number(prId);
            let effectiveComments = Array.isArray(comments) ? comments : undefined;
            if (verdict === 'changes-requested' && (!effectiveComments || effectiveComments.length === 0)) {
                const fromFile = loadReviewerCommentsAsReviewComments(rootDir, prIdNum);
                if (fromFile?.length) effectiveComments = fromFile;
                else {
                    // Local file stale/missing — pull the reviewer's comments from the PR host so
                    // the dev gets actionable feedback instead of an empty request list (bug #9).
                    const fromHost = fetchPrReviewCommentsFromHost(configFile, prIdNum, statusProjectKey);
                    if (fromHost?.length) effectiveComments = fromHost;
                    else {
                        // Nothing on the host either — fall back to the reviewer's own status
                        // events so the dev doesn't rework BLIND and loop forever.
                        const fromStatus = harvestReviewerFindingFromStatus(rootDir, prIdNum);
                        if (fromStatus?.length) effectiveComments = fromStatus;
                    }
                }
            }
            // Capture review training data before dispatching the next agent
            if (verdict === 'changes-requested' && typeof branch === 'string' && branch) {
                saveReviewPending(rootDir, configFile, prIdNum, branch, effectiveComments ?? []);
            }
            if (verdict === 'approved' && typeof branch === 'string' && branch) {
                completeReviewTrainingData(rootDir, configFile, prIdNum, branch);
            }

            const resolvedCommentCount = effectiveComments?.length
                ? effectiveComments.length
                : (typeof commentCount === 'number' && commentCount >= 0 ? commentCount : 0);
            const result = applyReviewComplete(rootDir, { prId: prIdNum, verdict, storyNumber, branch, prUrlBase, projectKey: statusProjectKey, comments: effectiveComments });
            const prLink = prUrlBase ? `[PR #${prId}](${prUrlBase}/${prId})` : `PR #${prId}`;
            const targetAgent = result.target && !['unknown', 'waiting-for-design-review', 'waiting-for-code-review'].includes(result.target)
                ? result.target
                : null;
            const targetInStepMode = targetAgent ? isAgentStepMode(targetAgent, rootDir) : false;
            const storyOwnerForStep = result.target === 'devops' ? findStoryOwnerByPrId(rootDir, prIdNum) : null;
            const storyOwnerInStepMode = !!(storyOwnerForStep && isAgentStepMode(storyOwnerForStep.agentId, rootDir));
            let agentSpawned = false;
            if (verdict === 'approved') {
                resetReworkRound(rootDir, prIdNum); // approved → clear the rework counter for this PR
                // Learning flywheel: if this PR was rejected earlier and is now approved,
                // finalize the (rejected → fix) training example captured at changes-requested
                // time — the high-value contrastive pair for fine-tuning the local model.
                try { completeReviewTrainingData(rootDir, configFile, prIdNum, typeof branch === 'string' ? branch : undefined); } catch (e) { console.warn('[handoff] completeReviewTrainingData failed:', e); }
                if (!isMockExternalMode(configFile)) {
                    voteOnPr(prId, 'Approved', undefined, statusProjectKey).catch(e => console.error('[handoff] ADO vote failed:', e));
                }
                if (result.target === 'devops' && !result.alreadyDispatched && !storyOwnerInStepMode && !isAgentStepMode('devops', rootDir)) {
                    await notify(rootDir, { title: `PR #${prId} Approved`, body: `**${resolveAgentDisplayName('reviewer', rootDir)}** approved ${prLink}${storyNumber ? ` (story ${storyNumber})` : ''}. Handing off to **${resolveAgentDisplayName('devops', rootDir)}** for CI build.`, color: '22c55e' });
                    await notify(rootDir, { title: `${resolveAgentDisplayName('devops', rootDir)}: build gate — PR #${prId}`, body: `**${resolveAgentDisplayName('devops', rootDir)}** — \`.devops-status.json\` is **pending-build**. Run Pipeline Workflow Mode B.`, color: '06b6d4' });
                    try { agentSpawned = spawnAgent('devops', `Build gate for PR #${prId}. Read skills/${skillSubdirForAgentId('devops')}/SKILL.md Mode B and .devops-status.json.`, rootDir, getAgentModel('devops', rootDir)).spawned; } catch (e) { console.error('[handoff] devops spawn failed:', e); }
                }
            } else if (!targetInStepMode) {
                await notify(rootDir, { title: `Changes Requested: PR #${prId}`, body: `**${resolveAgentDisplayName('reviewer', rootDir)}** requested changes on ${prLink}${storyNumber ? ` (story ${storyNumber})` : ''}.${resolvedCommentCount ? ` ${resolvedCommentCount} comment(s).` : ''}`, color: 'ef4444' });
                // Learning flywheel: snapshot the rejected diff + reviewer feedback + base-file
                // context now. On later approval, completeReviewTrainingData computes the fix
                // diff and writes the training example.
                if (typeof branch === 'string' && branch) {
                    try { saveReviewPending(rootDir, configFile, prIdNum, branch, effectiveComments ?? []); } catch (e) { console.warn('[handoff] saveReviewPending failed:', e); }
                }
                if (targetAgent) {
                    // Surface the reviewer's feedback INLINE in the re-spawn prompt for ANY dev-role
                    // agent (backend/frontend/qa/etc.) — relying on the agent to find+parse status
                    // `requests[]` itself fails on smaller models, which then ask for "the feedback"
                    // that's already on their desk (bug #9). Also rail it to edit, not plan.
                    const fbLines = (effectiveComments ?? []).map((c, i) => {
                        const loc = c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : '';
                        return `${i + 1}. ${c.severity ? `[${String(c.severity).toUpperCase()}] ` : ''}${String(c.summary ?? '').trim()}${loc}`;
                    }).filter((l) => l.trim());
                    const feedbackBlock = fbLines.length
                        ? `\n\nThe reviewer requested these changes — address EACH by editing the code (call edit_file; do NOT just write a plan), then re-validate and complete the phase:\n${fbLines.join('\n')}`
                        : '';
                    const reworkPrompt = `Changes requested on PR #${prId}. Read your skill and status file (the open items are in \`requests\`), then fix the code to address the feedback below.${feedbackBlock}`;

                    // Rework cap: the local 14B can loop forever against the reviewer. After
                    // REWORK_CAP rounds, escalate this dev to the cloud brain for one attempt;
                    // if that round is also rejected, pause for a human instead of spinning.
                    const round = bumpReworkRound(rootDir, prIdNum);
                    const action = reworkAction(round);
                    if (action === 'pause-human') {
                        // markReworkStuck sets desk.reworkStuck — auto-resume now honors it too (Step 3),
                        // so the pause halts EVERY spawn path, not just this handler.
                        markReworkStuck(rootDir, prIdNum, targetAgent, round);
                        await notify(rootDir, { title: `🚧 PR #${prId} stuck in rework`, body: `**${resolveAgentDisplayName(targetAgent, rootDir)}** has been rejected ${round - 1} times (incl. a cloud-brain attempt) on ${prLink}. Paused for human review — the loop is not auto-retrying.`, color: 'b91c1c' });
                    } else if (action === 'escalate-cloud') {
                        // markEscalated persists escalatedModel:'cloud' on the desk so EVERY re-spawn
                        // (here AND auto-resume) uses the cloud brain — not just this one-shot, which
                        // auto-resume's local re-spawn used to immediately supersede (Step 3).
                        markEscalated(rootDir, targetAgent, `rework round ${round} on PR #${prId}`);
                        const escalatedPrompt = `${reworkPrompt}\n\n[NOTE: previous attempts were rejected by the reviewer. You are running on a stronger model this round — read the feedback carefully and fix it correctly.]`;
                        try { agentSpawned = spawnAgent(targetAgent, escalatedPrompt, rootDir, 'cloud').spawned; } catch (e) { console.error('[handoff] escalated spawn failed:', e); }
                    } else {
                        try { agentSpawned = spawnAgent(targetAgent, reworkPrompt, rootDir, getAgentModel(targetAgent, rootDir)).spawned; } catch (e) { console.error('[handoff] spawn failed:', e); }
                    }
                }
            }
            try {
                const owner = findStoryOwnerByPrId(rootDir, prId);
                const workflowStoryNumber = (typeof storyNumber === 'string' && storyNumber.trim())
                    ? storyNumber.trim()
                    : storyNumberFromOwnerStatus(owner?.status);
                const nextAgent = verdict === 'approved' ? 'devops' : result.target;
                const nextPhase = verdict === 'approved' ? 'pending-build' : result.targetPhase;
                // Idempotency (bug #6): once devops owns this PR and is mid-build, a re-fired
                // approval must NOT re-transition the workflow item — doing so drags an
                // advanced devops (e.g. build-passed) back to pending-build and it 409s in a loop.
                const skipTransition = verdict === 'approved' && result.alreadyDispatched;
                const workflow = recordWorkflowMilestone({
                    storyNumber: workflowStoryNumber,
                    agentId: 'reviewer',
                    phase: verdict === 'approved' ? 'approved' : 'changes-requested',
                    eventType: 'review-complete',
                    outputs: {
                        reviewVerdict: verdict,
                        reviewThreads: { commentCount: resolvedCommentCount },
                        handoff: { target: result.target, targetPhase: result.targetPhase },
                        auditEvent: { route: '/api/handoff/review-complete', externalMode: getExternalMode(configFile) } },
                    message: `Review ${verdict} for PR #${prId}`,
                    transition: (nextAgent && nextAgent !== 'unknown' && !skipTransition) ? {
                        agentId: nextAgent,
                        nextPhase,
                        outputs: { auditEvent: { route: '/api/handoff/review-complete' } },
                        message: `Review routed PR #${prId} to ${nextAgent}/${nextPhase}` } : undefined });
                if (workflow) {
                    dbUpsertWorkflowArtifact({
                        workflowItemId: workflow.id,
                        artifactType: 'review',
                        artifactKey: String(prId),
                        payload: { prId, verdict, commentCount: resolvedCommentCount, target: result.target, targetPhase: result.targetPhase } });
                }
            } catch (workflowErr) {
                console.warn('[handoff] review workflow audit failed:', workflowErr);
            }
            json(res, { ...result, agentSpawned });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/handoff/build-complete ──────────────────────────────────────────
    use('/api/handoff/build-complete', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const parsed = JSON.parse(body) as { prId?: unknown; result?: unknown; buildId?: unknown };
            const prId = Number(parsed.prId);
            const buildResult = parsed.result as 'passed' | 'failed' | string | undefined;
            const buildIdParsed = parsed.buildId === undefined || parsed.buildId === null || parsed.buildId === ''
                ? undefined
                : Number(parsed.buildId);
            const buildId = buildIdParsed !== undefined && Number.isFinite(buildIdParsed) ? buildIdParsed : undefined;
            if (!Number.isFinite(prId) || prId <= 0 || (buildResult !== 'passed' && buildResult !== 'failed')) {
                json(res, { error: 'prId and result are required' }, 400); return;
            }
            const devopsFile = resolve(rootDir, '.devops-status.json');
            let alreadyHandled = false;
            let statusProjectKey: string | undefined;
            let devopsStoryNumberSnapshot: string | undefined;
            if (existsSync(devopsFile)) {
                try {
                    const cs = parseJsonUtf8File(devopsFile);
                    statusProjectKey = cs.assignedPR?.projectKey || cs.projectKey || undefined;
                    const sn0 = cs.assignedPR?.storyNumber;
                    if (typeof sn0 === 'string' && sn0.trim()) devopsStoryNumberSnapshot = sn0.trim();
                    const deskIdRaw = cs.assignedPR?.id;
                    const deskId = typeof deskIdRaw === 'number' ? deskIdRaw : Number(deskIdRaw);
                    if (['build-passed', 'build-failed', 'idle', 'complete'].includes(cs.currentPhase) && Number.isFinite(deskId) && deskId === prId) alreadyHandled = true;
                } catch { /* ok */ }
            }
            if (alreadyHandled) {
                if (isMockExternalMode(configFile) && buildResult === 'passed') {
                    setMockPullRequestStatus(rootDir, prId, 'completed');
                }
                json(res, { ok: true, deduplicated: true });
                return;
            }
            const result = applyBuildComplete(rootDir, { prId, result: buildResult, buildId });
            const buildConfig = getSchedulerConfig(rootDir);
            const buildPrUrlBase = (getProjectProfile(configFile, statusProjectKey)).prUrlBase || buildConfig.project?.prUrlBase || '';
            const buildPrLink = buildPrUrlBase ? `[PR #${prId}](${buildPrUrlBase}/${prId})` : `PR #${prId}`;
            const color = buildResult === 'passed' ? '06b6d4' : 'ef4444';
            const title = buildResult === 'passed' ? `Build Passed: PR #${prId}` : `Build Failed: PR #${prId}`;
            const devopsName = resolveAgentDisplayName('devops', rootDir);
            const msg = buildResult === 'passed' ? `**${devopsName}** - Build${buildId ? ` #${buildId}` : ''} passed for ${buildPrLink}.` : `**${devopsName}** - Build${buildId ? ` #${buildId}` : ''} failed for ${buildPrLink}.`;
            if (tryClaimBuildCompleteNotification(rootDir, prId, buildId, buildResult)) await notify(rootDir, { title, body: msg, color });
            let agentSpawned = false;
            if (buildResult === 'passed' && !result.hasIncompleteTasks && !isMockExternalMode(configFile)) {
                const ownerForWorktrees = findStoryOwnerByPrId(rootDir, prId);
                let devopsAfter: { assignedPR?: { storyNumber?: string } } | null = null;
                if (existsSync(devopsFile)) {
                    try { devopsAfter = parseJsonUtf8File(devopsFile); } catch { devopsAfter = null; }
                }
                const snFromDevops = typeof devopsAfter?.assignedPR?.storyNumber === 'string' ? devopsAfter.assignedPR.storyNumber.trim() : undefined;
                const storyNumForWorktrees = storyNumberFromOwnerStatus(ownerForWorktrees?.status)
                    || devopsStoryNumberSnapshot
                    || snFromDevops;
                if (storyNumForWorktrees) {
                    for (const wtRoot of resolveWorktreeRepoRoots(rootDir, configFile)) {
                        try {
                            cleanupStoryWorktrees(wtRoot, storyNumForWorktrees);
                        } catch (wtErr) {
                            console.warn('[handoff] worktree cleanup failed:', wtErr);
                        }
                    }
                }
            }
            if (result.storyOwner && result.storyOwner !== 'unknown' && !isAgentStepMode(result.storyOwner, rootDir)) {
                let spawnPrompt: string;
                if (buildResult === 'passed' && result.hasIncompleteTasks) {
                    const taskList = result.incompleteTaskIds?.join(', ') || 'remaining';
                    spawnPrompt = `Build passed for PR #${prId}, but ${result.incompleteTaskIds?.length || 'some'} task(s) are still incomplete (${taskList}). Read your skill and status file, then pick up the remaining tasks, implement them, and create a new PR.`;
                } else if (buildResult === 'passed') {
                    spawnPrompt = `Build passed for PR #${prId}. Read your skill and status file, then wrap up the story.`;
                } else {
                    spawnPrompt = `Build failed for PR #${prId}. Read your skill and status file, then fix the build failures.`;
                }
                try { agentSpawned = spawnAgent(result.storyOwner, spawnPrompt, rootDir, getAgentModel(result.storyOwner, rootDir)).spawned || agentSpawned; } catch (e) { console.error('[handoff] spawn failed:', e); }
            }
            const storyOwnerInStepMode = !!(result.storyOwner && result.storyOwner !== 'unknown' && isAgentStepMode(result.storyOwner, rootDir));
            if (buildResult === 'passed' && !result.hasIncompleteTasks && !storyOwnerInStepMode && !isGlobalStepMode(configFile) && !isAgentStepMode('devops', rootDir)) {
                const ownerSn = storyNumberFromOwnerStatus(findStoryOwnerByPrId(rootDir, prId)?.status);
                const wrapDismissId = result.wrapUpRequestId || wrapUpDeskRequestId(ownerSn || devopsStoryNumberSnapshot, prId);
                const wrapPrompt = `Build passed for PR #${prId}. Read .cursor/rules/story-wrapup.mdc and skills/${skillSubdirForAgentId('devops')}/SKILL.md: run wrap-up (ADO, Agility, reset agents), dismiss open request ${wrapDismissId} on the DevOps desk Tasks list when finished, then set .devops-status.json to idle with assignedPR null.`;
                try {
                    agentSpawned = spawnAgent('devops', wrapPrompt, rootDir, getAgentModel('devops', rootDir), { bypassHandoffDispatched: true }).spawned || agentSpawned;
                } catch (e) { console.error('[handoff] devops wrap-up spawn failed:', e); }
            }
            try {
                const owner = findStoryOwnerByPrId(rootDir, prId);
                const devopsStatus = existsSync(devopsFile) ? parseJsonUtf8File(devopsFile) : null;
                const workflowStoryNumber = storyNumberFromOwnerStatus(owner?.status)
                    || (typeof devopsStatus?.assignedPR?.storyNumber === 'string' ? devopsStatus.assignedPR.storyNumber : undefined);
                const nextPhase = (buildResult === 'passed' && !result.hasIncompleteTasks) ? 'complete' : buildResult === 'passed' ? 'reading-story' : 'validating';
                const nextAgent = buildResult === 'passed' ? (result.storyOwner || 'devops') : (result.storyOwner || 'devops');
                const workflow = recordWorkflowMilestone({
                    storyNumber: workflowStoryNumber,
                    agentId: 'devops',
                    phase: buildResult === 'passed' ? 'build-passed' : 'build-failed',
                    eventType: 'build-complete',
                    outputs: {
                        build: { id: buildId || null, result: buildResult, prId },
                        testResults: { build: buildResult },
                        handoff: { target: nextAgent, targetPhase: nextPhase },
                        auditEvent: { route: '/api/handoff/build-complete', externalMode: getExternalMode(configFile) } },
                    message: `Build ${buildResult} for PR #${prId}`,
                    transition: nextAgent && nextAgent !== 'unknown' ? {
                        agentId: nextAgent,
                        nextPhase,
                        outputs: { auditEvent: { route: '/api/handoff/build-complete' } },
                        message: `Build ${buildResult} routed PR #${prId} to ${nextAgent}/${nextPhase}`,
                        status: (buildResult === 'passed' && !result.hasIncompleteTasks) ? 'complete' : 'active' } : undefined });
                if (workflow) {
                    dbUpsertWorkflowArtifact({
                        workflowItemId: workflow.id,
                        artifactType: 'build',
                        artifactKey: String(buildId || prId),
                        payload: { id: buildId || null, prId, result: buildResult, target: nextAgent, targetPhase: nextPhase } });
                }
            } catch (workflowErr) {
                console.warn('[handoff] build workflow audit failed:', workflowErr);
            }
            json(res, { ...result, agentSpawned });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/handoff/design-ready ────────────────────────────────────────────
    use('/api/handoff/design-ready', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { storyNumber, storyName, designSpec, targetAgent } = JSON.parse(body);
            if (!storyNumber) { json(res, { error: 'storyNumber is required' }, 400); return; }
            const schedCfg = getSchedulerConfig(rootDir);
            const result = applyDesignReady(rootDir, { storyNumber, storyName, designSpec, targetAgent, execMode: getExecMode(configFile), workflowMode: getSchedulerWorkflowMode(schedCfg) });
            await notify(rootDir, { title: `Design Spec Ready: ${storyNumber}`, body: `**${resolveAgentDisplayName('ux', rootDir)}** — Design spec for **${storyName || storyNumber}** is ready. **${resolveAgentDisplayName(result.targetAgent, rootDir)}** assigned for implementation.`, color: 'ec4899' });
            let designSpawned = false;
            if (!isAgentStepMode(result.targetAgent, rootDir)) {
                try { designSpawned = spawnAgent(result.targetAgent, `Design spec ready for story ${storyNumber}. Read your skill and .${result.targetAgent}-status.json to begin implementation.`, rootDir, getAgentModel(result.targetAgent, rootDir)).spawned; } catch (e) { console.error('[handoff] spawn failed:', e); }
            }
            json(res, { ...result, agentSpawned: designSpawned });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/handoff/design-review-complete ─────────────────────────────────
    use('/api/handoff/design-review-complete', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { prId, verdict, storyNumber, comments, designComments } = JSON.parse(body);
            if (!prId || !verdict) { json(res, { error: 'prId and verdict are required' }, 400); return; }
            const result = applyDesignReviewComplete(rootDir, { prId, verdict, storyNumber, comments, designComments: Array.isArray(designComments) ? designComments : undefined });
            let agentSpawned = false;
            if (result.bothApproved) {
                if (!isAgentStepMode('devops', rootDir)) {
                    await notify(rootDir, { title: `PR #${prId} Fully Approved`, body: `Both **${resolveAgentDisplayName('reviewer', rootDir)}** (code) and **${resolveAgentDisplayName('ux', rootDir)}** (design) approved PR #${prId}. Handing off to **${resolveAgentDisplayName('devops', rootDir)}** for CI build.`, color: '22c55e' });
                    try { agentSpawned = spawnAgent('devops', `Build gate for PR #${prId}. Read skills/${skillSubdirForAgentId('devops')}/SKILL.md Mode B and .devops-status.json.`, rootDir, getAgentModel('devops', rootDir)).spawned; } catch (e) { console.error('[handoff] devops spawn failed:', e); }
                }
            } else if (verdict === 'changes-requested') {
                const targetInStepMode = result.target && result.target !== 'unknown' && isAgentStepMode(result.target, rootDir);
                if (!targetInStepMode) {
                    await notify(rootDir, { title: `Design Changes Requested: PR #${prId}`, body: `**${resolveAgentDisplayName('ux', rootDir)}** requested design changes on PR #${prId}.${comments ? ` ${comments}` : ''}`, color: 'ec4899' });
                    if (result.target && result.target !== 'unknown') {
                        try { agentSpawned = spawnAgent(result.target, `Design changes requested on PR #${prId}. Read your skill and status file, then address the design feedback.`, rootDir, getAgentModel(result.target, rootDir)).spawned; } catch (e) { console.error('[handoff] spawn failed:', e); }
                    }
                }
            }
            json(res, { ...result, agentSpawned });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
