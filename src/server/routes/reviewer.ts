import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getExternalMode, isMockExternalMode } from '../external-mode';
import { mergeDeskUiIntoReviewerPrs, dismissPrFromReviewerDesk, undismissPrFromReviewerDesk, mergeThreadsForPr, clearReviewerDeskToIdle, reviewerPickupBlockedForCompleted, isAzureDevOpsPrTerminalStatus, parseReviewerAssignedPrId } from '../reviewer-pr-desk';
import { getSchedulerWorkflowMode } from '../schedulerMode';
import { getActiveProjectName, getProjectProfile } from '../project-config';
import { spawnAgent } from '../spawn-agent';
import { isGlobalStepMode } from '../stepMode';
import { sendTeamsNotification } from '../teams-notify';
import { skillSubdirForAgentId } from '../../shared/agentSkillDirs';
import { resolveAgentDisplayName } from '../agent-display-names';
import { readBody, json, cors } from '../router';
import {
    adoRestFetch,
    firstNonEmpty,
    getAgentModel,
    getSchedulerConfig,
    isAgentStepMode,
    normalizeReviewerPrCandidate,
    type AdoPullRequestSummary } from '../route-shared';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/reviewer/prs ────────────────────────────────────────────────────
    use('/api/reviewer/prs', async (req, res) => {
        cors(res, 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const projectKey = firstNonEmpty(url.searchParams.get('projectKey')) ?? getActiveProjectName(configFile);
            const profile = getProjectProfile(configFile, projectKey);
            if (!profile.repositoryId) { json(res, { error: 'Active project repositoryId is required to list Azure DevOps PRs' }, 400); return; }

            const team = firstNonEmpty(url.searchParams.get('team'));
            let branchPrefix = firstNonEmpty(url.searchParams.get('branchPrefix'), url.searchParams.get('teamPrefix'));
            if (!branchPrefix && team) branchPrefix = profile.teamPrefixes?.[team] || team;
            const titlePrefix = firstNonEmpty(url.searchParams.get('titlePrefix'));
            const creator = firstNonEmpty(url.searchParams.get('creator'), url.searchParams.get('createdBy'));
            const query = firstNonEmpty(url.searchParams.get('q'));
            const branchPrefixLc = branchPrefix?.toLowerCase();
            const titlePrefixLc = titlePrefix?.toLowerCase();
            const creatorLc = creator?.toLowerCase();
            const queryLc = query?.toLowerCase();

            // ADO GitPullRequest.status: merged PRs are `completed` (not a separate "merged" value). Only list `active` from searchCriteria, then drop any terminal rows defensively.
            const path = `/git/repositories/${encodeURIComponent(profile.repositoryId)}/pullrequests?searchCriteria.status=active&api-version=7.1`;
            const raw = await adoRestFetch(rootDir, profile, path);
            const prs = Array.isArray(raw?.value) ? raw.value as AdoPullRequestSummary[] : Array.isArray(raw) ? raw as AdoPullRequestSummary[] : [];
            const candidates = prs
                .map((pr) => normalizeReviewerPrCandidate(pr, profile, projectKey, getSchedulerConfig(rootDir), isMockExternalMode(configFile)))
                .filter((pr): pr is ReturnType<typeof normalizeReviewerPrCandidate> & { id: number } => pr.id != null)
                .filter((pr) => !isAzureDevOpsPrTerminalStatus(pr.status as string | undefined))
                .filter((pr) => !branchPrefixLc || pr.sourceBranch.toLowerCase().startsWith(branchPrefixLc))
                .filter((pr) => !titlePrefixLc || pr.title.toLowerCase().startsWith(titlePrefixLc))
                .filter((pr) => !creatorLc || `${pr.createdBy.displayName} ${pr.createdBy.uniqueName}`.toLowerCase().includes(creatorLc))
                .filter((pr) => !queryLc || `${pr.id} ${pr.title} ${pr.sourceBranch} ${pr.createdBy.displayName} ${pr.createdBy.uniqueName}`.toLowerCase().includes(queryLc))
                .sort((a, b) => String(b.creationDate || '').localeCompare(String(a.creationDate || '')));

            const reviewerStatusPath = resolve(rootDir, '.reviewer-status.json');
            const reviewerRaw = existsSync(reviewerStatusPath)
                ? parseJsonUtf8File(reviewerStatusPath) as Record<string, unknown>
                : null;

            // Fallback: if reviewer desk has an assignedPR that isn't in the ADO list, synthesize a row
            const assignedPrId = parseReviewerAssignedPrId(reviewerRaw);
            if (assignedPrId != null && !candidates.some(c => c.id === assignedPrId)) {
                const assigned = reviewerRaw?.assignedPR as Record<string, unknown> | undefined;
                const synthesized = normalizeReviewerPrCandidate({
                    pullRequestId: assignedPrId,
                    id: assignedPrId,
                    title: typeof assigned?.title === 'string' ? assigned.title : `PR #${assignedPrId}`,
                    status: 'active',
                    sourceRefName: typeof assigned?.branch === 'string' ? `refs/heads/${assigned.branch}` : 'refs/heads/unknown',
                    targetRefName: typeof assigned?.targetBranch === 'string' ? `refs/heads/${assigned.targetBranch}` : 'refs/heads/main',
                    createdBy: { id: 'unknown', displayName: 'Unknown', uniqueName: 'unknown' },
                    creationDate: typeof (reviewerRaw as any)?.requestedAt === 'string' ? (reviewerRaw as any).requestedAt : new Date().toISOString(),
                    url: typeof assigned?.url === 'string' ? assigned.url : undefined } as AdoPullRequestSummary, profile, projectKey, getSchedulerConfig(rootDir), isMockExternalMode(configFile));
                if (synthesized.id != null) {
                    candidates.unshift(synthesized as typeof candidates[number]);
                }
            }

            const prsWithDesk = mergeDeskUiIntoReviewerPrs(rootDir, candidates, reviewerRaw);

            json(res, {
                ok: true,
                projectKey,
                project: profile.azureProject,
                repositoryId: profile.repositoryId,
                mode: getExternalMode(configFile),
                filters: { branchPrefix: branchPrefix ?? null, titlePrefix: titlePrefix ?? null, creator: creator ?? null, query: query ?? null },
                count: prsWithDesk.length,
                prs: prsWithDesk });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    use('/api/reviewer/pr-comments', async (req, res) => {
        cors(res, 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const prId = Number(url.searchParams.get('prId') || '');
            if (!Number.isFinite(prId) || prId <= 0) { json(res, { error: 'prId query required' }, 400); return; }
            const threads = mergeThreadsForPr(rootDir, prId);
            json(res, { ok: true, prId, count: threads.length, threads });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    use('/api/reviewer/dismiss-pr', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { prId } = JSON.parse(body || '{}');
            const id = Number(prId);
            if (!Number.isFinite(id) || id <= 0) { json(res, { error: 'prId is required' }, 400); return; }
            dismissPrFromReviewerDesk(rootDir, id);
            json(res, { ok: true, prId: id });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    use('/api/reviewer/clear-desk', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const parsed = JSON.parse(body || '{}');
            const prIdRaw = parsed.prId ?? parsed.pullRequestId;
            const prId = prIdRaw === undefined || prIdRaw === null || prIdRaw === '' ? undefined : Number(prIdRaw);
            if (prId !== undefined && (!Number.isFinite(prId) || prId <= 0)) { json(res, { error: 'prId must be a positive number when provided' }, 400); return; }
            const result = clearReviewerDeskToIdle(rootDir, prId !== undefined ? { prId } : {});
            if (!result.ok) { json(res, { error: result.error || 'clear-desk failed' }, 409); return; }
            json(res, { ok: true, ...(prId !== undefined ? { prId } : {}) });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    use('/api/reviewer/auto-pick-config', async (req, res) => {
        cors(res, 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        try {
            const cfg = getSchedulerConfig(rootDir);
            const workflowMode = getSchedulerWorkflowMode(cfg);
            const reviewerAutoStart = cfg.scheduler?.agents?.reviewer?.autoStart === true;
            /** Opt-in only: grab first matching row from ADO list when desk opens. Not tied to autonomous mode (PRs should arrive via `/api/pr/created` or manual Pick Up). */
            const autoPickAdoList = cfg.scheduler?.agents?.reviewer?.autoPickAdoList === true
                || cfg.scheduler?.agents?.reviewer?.autoPickFirstFromAdoList === true;
            const globalStepOn = cfg.scheduler?.globalStepMode === true;
            const reviewerStepOn = cfg.scheduler?.agents?.reviewer?.stepMode === true;
            const blockedByStepMode = autoPickAdoList && (globalStepOn || reviewerStepOn);
            json(res, {
                autoPickPullRequests: autoPickAdoList && !blockedByStepMode,
                workflowMode,
                reviewerAutoStart,
                autoPickAdoList,
                blockedByStepMode,
                globalStepMode: globalStepOn,
                reviewerStepMode: reviewerStepOn });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/reviewer/pick-pr ────────────────────────────────────────────────
    use('/api/reviewer/pick-pr', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const parsed = JSON.parse(body || '{}');
            const prId = Number(parsed.prId ?? parsed.pullRequestId ?? parsed.id);
            if (!Number.isFinite(prId) || prId <= 0) { json(res, { error: 'prId is required' }, 400); return; }

            const projectKey = firstNonEmpty(parsed.projectKey) ?? getActiveProjectName(configFile);
            const profile = getProjectProfile(configFile, projectKey);
            if (!profile.repositoryId) { json(res, { error: 'Active project repositoryId is required to pick up a PR' }, 400); return; }

            const rawPr = await adoRestFetch(rootDir, profile, `/git/repositories/${encodeURIComponent(profile.repositoryId)}/pullrequests/${prId}?api-version=7.1`) as AdoPullRequestSummary;
            const pr = normalizeReviewerPrCandidate(rawPr, profile, projectKey, getSchedulerConfig(rootDir), isMockExternalMode(configFile));
            const completedBlock = reviewerPickupBlockedForCompleted(rootDir, prId, typeof rawPr.status === 'string' ? rawPr.status : pr.status);
            if (completedBlock) { json(res, { error: completedBlock }, 409); return; }
            const now = new Date().toISOString();

            const reviewerAssignments: Array<{ reviewerId: string; ok: boolean; error?: string }> = [];
            for (const reviewerId of (Array.isArray(profile.reviewerIds) ? profile.reviewerIds.filter(Boolean) : [])) {
                try {
                    await adoRestFetch(rootDir, profile, `/git/repositories/${encodeURIComponent(profile.repositoryId)}/pullrequests/${prId}/reviewers/${encodeURIComponent(reviewerId)}?api-version=7.1`, 'PUT', {});
                    reviewerAssignments.push({ reviewerId, ok: true });
                } catch (e) {
                    reviewerAssignments.push({ reviewerId, ok: false, error: e instanceof Error ? e.message : String(e) });
                }
            }

            const reviewTask = { id: `PR-REVIEW-${prId}`, number: `PR-REVIEW-${prId}`, name: `Review PR #${prId}: ${pr.title}`, status: 'pending', hours: 1, category: 'Review' };
            const reviewerStatusFile = resolve(rootDir, '.reviewer-status.json');
            const previousStatus = existsSync(reviewerStatusFile) ? parseJsonUtf8File(reviewerStatusFile) : {};
            const priorEvents = Array.isArray(previousStatus.events) ? previousStatus.events : [];
            const assignedPR = { id: prId, title: pr.title, url: pr.url, storyNumber: pr.storyNumber, branch: pr.sourceBranch, targetBranch: pr.targetBranch, projectKey, createdBy: pr.createdBy };
            writeFileSync(reviewerStatusFile, JSON.stringify({
                ...previousStatus,
                projectKey,
                assignedPR,
                currentPhase: 'pending-review',
                requestedAt: now,
                handoffDispatched: false,
                tasks: [reviewTask],
                events: [...priorEvents, { timestamp: now, type: 'info', message: `PR #${prId} picked up for review${pr.sourceBranch ? ` from ${pr.sourceBranch}` : ''}.` }] }, null, 2));
            undismissPrFromReviewerDesk(rootDir, prId);

            await sendTeamsNotification(rootDir, `${resolveAgentDisplayName('reviewer', rootDir)} picked up PR #${prId}`, `**${resolveAgentDisplayName('reviewer', rootDir)}** picked up [PR #${prId}](${pr.url}) for review.\n\n${pr.title}`, 'f59e0b');

            const globalStepModeOn = isGlobalStepMode(resolve(rootDir, '.sdlc-framework.config.json'));
            const reviewerStepModeOn = isAgentStepMode('reviewer', rootDir);
            let agentSpawned = false;
            if (!globalStepModeOn && !reviewerStepModeOn) {
                try {
                    agentSpawned = spawnAgent('reviewer', `Review PR #${prId}. Read skills/${skillSubdirForAgentId('reviewer')}/SKILL.md and .reviewer-status.json, then perform a code review.`, rootDir, getAgentModel('reviewer', rootDir)).spawned;
                } catch (e) { console.error('[reviewer/pick-pr] reviewer spawn failed:', e); }
            }

            json(res, { ok: true, pr: assignedPR, reviewerAssignments, agentSpawned, reviewerStepMode: reviewerStepModeOn, globalStepMode: globalStepModeOn });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
