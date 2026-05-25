/**
 * ADO Bridge — server-side orchestrator that handles Azure DevOps operations
 * the CLI agents can't perform (no MCP access in headless mode).
 *
 * Status phase checks are debounced so burst writes to JSON do not re-trigger handlers.
 * Watches agent status files and:
 *   1. When an agent enters "creating-pr" → creates PR, adds reviewer, calls /api/pr/created
 *   2. When review-complete fires "approved" → votes Approved on the ADO PR
 *   3. When Devops enters "pending-build" → queues pipeline 646 on the PR branch if needed,
 *      then polls build status and calls /api/handoff/build-complete
 *   4. When build passes → sets auto-complete on the PR
 *
 * This runs inside the Vite dev server so it has full access to the Node.js
 * process.  ADO REST calls use the PAT from .env (AZURE_DEVOPS_PAT).
 */

import { existsSync, writeFileSync, watchFile, unwatchFile } from 'fs';
import { resolve } from 'path';
import { getActiveProject, getProjectProfile, resolveProjectBranch, resolveTargetRef, type ProjectProfile } from './project-config';
import { isMockExternalMode } from './external-mode';
import { onStatusChange } from './status-events';
import { mockAdoFetch } from './mock-external';
import { adoLog } from './logger';
import { loadReviewerCommentsAsReviewComments } from './handoff';
import { parseJsonUtf8File } from './json-file';

export interface AdoBridgeConfig {
    workspaceDir: string;
    organization: string;
    azureProject: string;
    repositoryId: string;
    prUrlBase: string;
    reviewerIds: string[];
    /** Global PAT with Code + Build scopes (fallback when no per-agent PAT is set) */
    pat: string;
    /** Per-agent PAT overrides from .sdlc-framework.config.json scheduler.agents.<id>.adoPat */
    agentPats?: Record<string, string>;
}

interface AgentStatus {
    currentPhase?: string;
    projectKey?: string;
    storyNumber?: string;
    storyName?: string;
    teamId?: string;
    assignedPR?: { id: number; branch?: string; storyNumber?: string; projectKey?: string | null };
    prs?: Array<{ id: number; status: string }>;
    buildId?: number;
    pipelineId?: number;
    events?: Array<{ timestamp: string; type: string; message: string }>;
    handoffDispatched?: boolean;
    [key: string]: unknown;
}

/**
 * Decide whether a status snapshot represents a real phase change for logging and handlers.
 * Ignores missing or non-string currentPhase so transient parses cannot oscillate lastPhase memory.
 */
export function phaseWatcherTransition(
    agentId: string,
    status: AgentStatus | null,
    lastPhaseByAgent: Map<string, string>,
): { prevLabel: string; phase: string } | null {
    if (!status) return null;
    const cp = status.currentPhase;
    if (typeof cp !== 'string') return null;
    const prevStored = lastPhaseByAgent.get(agentId);
    if (cp === prevStored) return null;
    return { prevLabel: prevStored ?? '(none)', phase: cp };
}

const POLL_INTERVAL_MS = 2_000;
const BUILD_POLL_INTERVAL_MS = 15_000;
const MOCK_BUILD_POLL_INTERVAL_MS = 2_000;
/** Coalesce burst fs.watchFile callbacks after JSON writes that do not affect phase */
const PHASE_DEBOUNCE_MS = 100;
/** Fallback pipeline id when no project profile is loaded */
const FALLBACK_PIPELINE_ID = 646;

let activeBuildPollers = new Map<number, NodeJS.Timeout>();
/** Debounced phase checks keyed by agent id */
const phaseDebounceTimers = new Map<string, NodeJS.Timeout>();

function apiBaseUrl(): string {
    const port = process.env.SDLC_API_PORT || 3001;
    return `http://localhost:${port}`;
}

function isMock(): boolean {
    if (!bridgeConfig) return false;
    return isMockExternalMode(resolve(bridgeConfig.workspaceDir, '.sdlc-framework.config.json'));
}
/** Prevents duplicate queue requests for the same PR while a run is being created */
const devopsQueueInFlight = new Set<number>();
let statusWatchers: string[] = [];
let unsubStatusBus: (() => void) | null = null;
let bridgeConfig: AdoBridgeConfig | null = null;

/** Resolve the PAT for a specific agent, falling back to the global PAT (testable). */
export function resolveAdoPatForAgent(config: AdoBridgeConfig, agentId?: string): string {
    if (agentId && config.agentPats?.[agentId]) {
        return config.agentPats[agentId];
    }
    return config.pat;
}

function resolvePatForAgent(agentId?: string): string {
    if (!bridgeConfig) throw new Error('ADO Bridge not configured');
    return resolveAdoPatForAgent(bridgeConfig, agentId);
}

function getActiveProjectProfile(): ProjectProfile {
    if (!bridgeConfig) {
        return { organization: '', azureProject: '', repositoryId: '', targetBranch: 'main', pipelineId: FALLBACK_PIPELINE_ID, reviewerIds: [], branchPattern: 'feat/{storyNumber}-{slug}', teamPrefixes: {} };
    }
    const configPath = resolve(bridgeConfig.workspaceDir, '.sdlc-framework.config.json');
    return getActiveProject(configPath);
}

function getStatusProjectProfile(status?: AgentStatus): ProjectProfile {
    if (!bridgeConfig) {
        return { organization: '', azureProject: '', repositoryId: '', targetBranch: 'main', pipelineId: FALLBACK_PIPELINE_ID, reviewerIds: [], branchPattern: 'feat/{storyNumber}-{slug}', teamPrefixes: {} };
    }
    const configPath = resolve(bridgeConfig.workspaceDir, '.sdlc-framework.config.json');
    const projectKey =
        typeof status?.projectKey === 'string' && status.projectKey.trim()
            ? status.projectKey.trim()
            : undefined;
    return getProjectProfile(configPath, projectKey);
}

function activeRepositoryId(profile = getActiveProjectProfile()): string {
    return profile.repositoryId || bridgeConfig?.repositoryId || '';
}

function activePrUrlBase(profile = getActiveProjectProfile()): string {
    return profile.prUrlBase || bridgeConfig?.prUrlBase || '';
}

function adoFetch(path: string, method = 'GET', body?: unknown, agentId?: string, profile = getActiveProjectProfile()): Promise<any> {
    if (!bridgeConfig) throw new Error('ADO Bridge not configured');
    if (isMockExternalMode(resolve(bridgeConfig.workspaceDir, '.sdlc-framework.config.json'))) {
        return Promise.resolve(mockAdoFetch(bridgeConfig.workspaceDir, path, method, body));
    }
    const organization = profile.organization || bridgeConfig.organization;
    const azureProject = profile.azureProject || bridgeConfig.azureProject;
    const pat = resolvePatForAgent(agentId);
    const url = `https://dev.azure.com/${organization}/${azureProject}/_apis${path}`;
    const headers: Record<string, string> = {
        'Authorization': `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
        'Content-Type': 'application/json' };
    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(async r => {
        if (!r.ok) {
            const text = await r.text().catch(() => '');
            throw new Error(`ADO ${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`);
        }
        return r.json().catch(() => ({}));
    });
}

function readStatus(agentId: string): AgentStatus | null {
    if (!bridgeConfig) return null;
    const file = resolve(bridgeConfig.workspaceDir, `.${agentId}-status.json`);
    if (!existsSync(file)) return null;
    try {
        return parseJsonUtf8File(file);
    } catch { return null; }
}

function appendEvent(agentId: string, type: string, message: string) {
    if (!bridgeConfig) return;
    const file = resolve(bridgeConfig.workspaceDir, `.${agentId}-status.json`);
    if (!existsSync(file)) return;
    try {
        const status = parseJsonUtf8File(file);
        if (!Array.isArray(status.events)) status.events = [];
        status.events.push({ timestamp: new Date().toISOString(), type, message });
        writeFileSync(file, JSON.stringify(status, null, 2));
    } catch { /* non-critical */ }
}

function patchAgentStatusJson(agentId: string, patch: (obj: Record<string, unknown>) => void) {
    if (!bridgeConfig) return;
    const file = resolve(bridgeConfig.workspaceDir, `.${agentId}-status.json`);
    if (!existsSync(file)) return;
    try {
        const status = parseJsonUtf8File(file) as Record<string, unknown>;
        patch(status);
        writeFileSync(file, JSON.stringify(status, null, 2));
    } catch { /* non-critical */ }
}

function log(msg: string) { adoLog.info(msg); }

// ── 1. PR creation when agent enters creating-pr ──────────────────────

async function handleCreatingPr(agentId: string, status: AgentStatus) {
    if (!bridgeConfig) return;

    const profile = getStatusProjectProfile(status);
    const repositoryId = activeRepositoryId(profile);
    if (!String(repositoryId || '').trim()) {
        const msg =
            'ADO Bridge: skip PR create — active project repositoryId is empty in .sdlc-framework.config.json (ADO would return 404).';
        log(msg);
        appendEvent(agentId, 'error', msg);
        return;
    }

    const branch = detectBranch(agentId, status);
    if (!branch) {
        log(`${agentId} in creating-pr but no branch detected — skipping`);
        return;
    }

    const existingPr = status.prs?.find(p => p.status === 'active');
    if (existingPr) {
        log(`${agentId} already has active PR #${existingPr.id} — skipping PR creation`);
        return;
    }

    log(`${agentId} entered creating-pr — creating PR for branch ${branch}`);

    try {
        const prTitle = `feat(${status.storyNumber || 'dev'}): ${status.storyName || branch}`;
        const pr = await adoFetch(
            `/git/repositories/${repositoryId}/pullrequests?api-version=7.1`,
            'POST',
            {
                sourceRefName: `refs/heads/${branch}`,
                targetRefName: resolveTargetRef(profile),
                title: prTitle },
            agentId,
            profile,
        );
        const prId = pr.pullRequestId;
        log(`PR #${prId} created`);

        // Add reviewer
        for (const reviewerId of profile.reviewerIds) {
            await adoFetch(
                `/git/repositories/${repositoryId}/pullrequests/${prId}/reviewers/${reviewerId}?api-version=7.1`,
                'PUT',
                { vote: 0 },
                agentId,
                profile,
            );
        }
        log(`Reviewer(s) added to PR #${prId}`);

        // Call the handoff endpoint (internal — hit localhost)
        const handoffBody = JSON.stringify({
            agentId,
            prId,
            prTitle,
            prUrl: `${activePrUrlBase(profile)}/${prId}`,
            storyNumber: status.storyNumber || '',
            branch,
            projectKey: typeof status.projectKey === 'string' ? status.projectKey : null });
        const handoffResp = await fetch(`${apiBaseUrl()}/api/pr/created`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: handoffBody });
        const handoffResult = await handoffResp.json().catch(() => ({}));
        log(`Handoff called for PR #${prId}: ${JSON.stringify(handoffResult)}`);

    } catch (err: any) {
        log(`PR creation failed for ${agentId}: ${err.message}`);
        appendEvent(agentId, 'error', `ADO Bridge: PR creation failed — ${err.message}`);
    }
}

function detectBranch(agentId: string, status: AgentStatus): string | null {
    // Check events for branch name (explicit mentions take priority)
    for (const ev of (status.events || []).reverse()) {
        const branchMatch = ev.message?.match(/branch\s+([\w/.-]+)/i);
        if (branchMatch) return branchMatch[1];
        const fromBranch = ev.message?.match(/from branch\s+([\w/.-]+)/i);
        if (fromBranch) return fromBranch[1];
        // Match both feat/ and team-prefix/ style branches
        const featMatch = ev.message?.match(/((?:feat|feature|fix)\/[\w/.-]+)/);
        if (featMatch) return featMatch[1];
        // YourProject-style: team/storyNumber_slug
        const teamBranch = ev.message?.match(/((?:chipmunks|ninjas|ducks|integrators|istari|planeteers|avengers|arm|devops)\/[\w/._-]+)/i);
        if (teamBranch) return teamBranch[1];
    }
    // Fallback: build branch name from active project profile pattern
    if (status.storyNumber) {
        const profile = getStatusProjectProfile(status);
        const env =
            typeof status.environment === 'string' && status.environment.trim()
                ? status.environment.trim()
                : undefined;
        const teamId =
            typeof status.teamId === 'string' && status.teamId.trim()
                ? status.teamId.trim()
                : undefined;
        return resolveProjectBranch(profile, status.storyNumber, status.storyName || '', teamId, env);
    }
    return null;
}

// ── 2. PR vote when review-complete fires ─────────────────────────────

export async function voteOnPr(prId: number, vote: 'Approved' | 'ApprovedWithSuggestions' | 'Rejected', agentId?: string, projectKey?: string) {
    if (!bridgeConfig) {
        log('Cannot vote - bridge not configured');
        return;
    }
    const profile = getStatusProjectProfile({ projectKey });
    const repositoryId = activeRepositoryId(profile);
    const voteMap = { Approved: 10, ApprovedWithSuggestions: 5, Rejected: -10 };
    const reviewerId = profile.reviewerIds[0];
    if (!reviewerId) return;
    try {
        await adoFetch(
            `/git/repositories/${repositoryId}/pullrequests/${prId}/reviewers/${reviewerId}?api-version=7.1`,
            'PUT',
            { vote: voteMap[vote] },
            agentId || 'reviewer',
            profile,
        );
        log(`Voted ${vote} on PR #${prId}`);
    } catch (err: any) {
        log(`Vote failed on PR #${prId}: ${err.message}`);
    }
}

// ── 3. Build poller ───────────────────────────────────────────────────

export function startBuildPoller(prId: number, buildId: number, profile = getActiveProjectProfile()) {
    if (!bridgeConfig) return;
    if (activeBuildPollers.has(prId)) {
        log(`Build poller for PR #${prId} already running`);
        return;
    }

    const pollMs = isMock() ? MOCK_BUILD_POLL_INTERVAL_MS : BUILD_POLL_INTERVAL_MS;
    log(`Starting build poller for build #${buildId} (PR #${prId}, interval=${pollMs}ms)`);

    const poller = setInterval(async () => {
        try {
            const build = await adoFetch(`/build/builds/${buildId}?api-version=7.1`, 'GET', undefined, undefined, profile);
            const buildStatus = build.status; // 'notStarted' | 'inProgress' | 'completed'
            const buildResult = build.result; // 'succeeded' | 'failed' | 'canceled' | 'partiallySucceeded'

            if (buildStatus !== 'completed') {
                log(`Build #${buildId}: ${buildStatus}`);
                return;
            }

            clearInterval(poller);
            activeBuildPollers.delete(prId);

            const result = buildResult === 'succeeded' ? 'passed' : 'failed';
            log(`Build #${buildId} completed: ${result}`);

            const resp = await fetch(`${apiBaseUrl()}/api/handoff/build-complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prId, result, buildId }) });
            const handoff = await resp.json().catch(() => ({}));
            log(`Build-complete handoff: ${JSON.stringify(handoff)}`);

            // Auto-complete the PR if build passed
            if (result === 'passed') {
                await setAutoComplete(prId, profile);
            }

        } catch (err: any) {
            log(`Build poll error for #${buildId}: ${err.message}`);
        }
    }, pollMs);

    activeBuildPollers.set(prId, poller);
}

/** Queue CI for PR branch and move devops agent to monitoring-build (Mode B Step 1). */
async function queueDevopsPendingBuild(status: AgentStatus) {
    if (!bridgeConfig) return;
    if (isMockExternalMode(resolve(bridgeConfig.workspaceDir, '.sdlc-framework.config.json'))) return;
    const prId = status.assignedPR?.id;
    const branch = status.assignedPR?.branch;
    if (!prId || !branch || status.buildId) return;
    if (devopsQueueInFlight.has(prId)) return;
    devopsQueueInFlight.add(prId);
    const profile = getStatusProjectProfile(status);
    const pipelineId = profile.pipelineId || FALLBACK_PIPELINE_ID;
    try {
        log(`Queueing pipeline ${pipelineId} on refs/heads/${branch} for PR #${prId}`);
        const run = await adoFetch(
            `/pipelines/${pipelineId}/runs?api-version=7.1`,
            'POST',
            {
                resources: {
                    pipelines: {},
                    repositories: {
                        self: { refName: `refs/heads/${branch}` } } } },
            undefined,
            profile,
        );
        const buildId = typeof run?.id === 'number' ? run.id : NaN;
        if (!Number.isFinite(buildId)) {
            throw new Error('Pipeline run response missing numeric id');
        }
        patchAgentStatusJson('devops', s => {
            s.currentPhase = 'monitoring-build';
            s.projectKey = status.projectKey || status.assignedPR?.projectKey || null;
            s.buildId = buildId;
            s.pipelineId = pipelineId;
            if (!Array.isArray(s.events)) s.events = [];
            (s.events as unknown[]).push({
                timestamp: new Date().toISOString(),
                type: 'info',
                message: `Build #${buildId} triggered for PR #${prId}` });
        });
        log(`Build #${buildId} queued for PR #${prId}`);
    } catch (err: any) {
        log(`Queue build failed for PR #${prId}: ${err.message}`);
        appendEvent('devops', 'error', `Queue build failed — ${err.message}`);
    } finally {
        devopsQueueInFlight.delete(prId);
    }
}

// ── 4. PR auto-complete ───────────────────────────────────────────────

async function setAutoComplete(prId: number, profile = getActiveProjectProfile()) {
    if (!bridgeConfig) return;
    const repositoryId = activeRepositoryId(profile);
    try {
        // Get current PR to find the creator ID
        const pr = await adoFetch(
            `/git/repositories/${repositoryId}/pullrequests/${prId}?api-version=7.1`,
            'GET',
            undefined,
            undefined,
            profile,
        );
        await adoFetch(
            `/git/repositories/${repositoryId}/pullrequests/${prId}?api-version=7.1`,
            'PATCH',
            {
                autoCompleteSetBy: { id: pr.createdBy?.id },
                completionOptions: {
                    mergeStrategy: 'squash',
                    deleteSourceBranch: true,
                    transitionWorkItems: false } },
            undefined,
            profile,
        );
        log(`Auto-complete set on PR #${prId}`);
    } catch (err: any) {
        log(`Failed to set auto-complete on PR #${prId}: ${err.message}`);
    }
}

export async function handleReviewerChangesRequested(status: AgentStatus) {
    if (!bridgeConfig) return;
    if (status.handoffDispatched) {
        log('reviewer changes-requested handoff already dispatched — skipping');
        return;
    }

    const prId = status.assignedPR?.id;
    if (!prId) {
        log('reviewer entered changes-requested but has no assigned PR id — skipping handoff');
        return;
    }

    const comments = loadReviewerCommentsAsReviewComments(bridgeConfig.workspaceDir, prId) ?? [];
    const body = {
        prId,
        verdict: 'changes-requested',
        storyNumber: status.assignedPR?.storyNumber ?? status.storyNumber ?? '',
        branch: status.assignedPR?.branch ?? '',
        projectKey: status.assignedPR?.projectKey ?? status.projectKey ?? null,
        commentCount: comments.length,
        ...(comments.length > 0 ? { comments } : {}) };

    const resp = await fetch(`${apiBaseUrl()}/api/handoff/review-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`review-complete handoff failed ${resp.status}: ${text.slice(0, 200)}`);
    }

    patchAgentStatusJson('reviewer', (s) => {
        s.handoffDispatched = true;
        const events = Array.isArray(s.events) ? s.events : [];
        events.push({
            timestamp: new Date().toISOString(),
            type: 'info',
            message: `Changes-requested handoff sent for PR #${prId}.` });
        s.events = events;
    });
    log(`reviewer changes-requested handoff sent for PR #${prId} (${comments.length} comments)`);
}

// ── Status file watcher ───────────────────────────────────────────────

const lastPhases = new Map<string, string>();

function scheduleAgentPhaseCheck(agentId: string) {
    const pending = phaseDebounceTimers.get(agentId);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(() => {
        phaseDebounceTimers.delete(agentId);
        runAgentPhaseCheck(agentId);
    }, PHASE_DEBOUNCE_MS);
    phaseDebounceTimers.set(agentId, timer);
}

function runAgentPhaseCheck(agentId: string) {
    if (!bridgeConfig) return;
    const status = readStatus(agentId);
    if (!status) return;
    const delta = phaseWatcherTransition(agentId, status, lastPhases);
    if (!delta) return;

    log(`${agentId}: ${delta.prevLabel} → ${delta.phase}`);

    const phase = delta.phase;

    if (agentId === 'devops' && phase === 'pending-build' && status.manualStartRequired === true) {
        log('devops pending-build is waiting for manual step-mode pickup; bridge will not queue CI yet');
        return;
    }

    lastPhases.set(agentId, delta.phase);

    if (phase === 'creating-pr') {
        handleCreatingPr(agentId, status).catch(e => log(`handleCreatingPr error: ${e.message}`));
    }

    if (agentId === 'reviewer' && phase === 'changes-requested') {
        handleReviewerChangesRequested(status).catch(e => log(`handleReviewerChangesRequested error: ${e.message}`));
    }

    if (phase === 'pending-build' && status.assignedPR?.id) {
        const profile = getStatusProjectProfile(status);
        if (status.buildId) {
            startBuildPoller(status.assignedPR.id, status.buildId, profile);
        } else if (agentId === 'devops') {
            queueDevopsPendingBuild(status).catch(e => log(`queueDevopsPendingBuild error: ${e.message}`));
        }
    }

    if (phase === 'monitoring-build' && status.assignedPR?.id && status.buildId) {
        startBuildPoller(status.assignedPR.id, status.buildId, getStatusProjectProfile(status));
    }
}

function watchAgent(agentId: string) {
    if (!bridgeConfig) return;
    const file = resolve(bridgeConfig.workspaceDir, `.${agentId}-status.json`);
    statusWatchers.push(file);

    runAgentPhaseCheck(agentId);
    watchFile(file, { interval: POLL_INTERVAL_MS }, () => scheduleAgentPhaseCheck(agentId));
}

// ── Public API ────────────────────────────────────────────────────────

export function startAdoBridge(config: AdoBridgeConfig) {
    const configPath = resolve(config.workspaceDir, '.sdlc-framework.config.json');
    if (!config.pat && !isMockExternalMode(configPath)) {
        log('No PAT configured — bridge disabled. Set AZURE_DEVOPS_PAT in .env for full automation.');
        return;
    }
    bridgeConfig = config;
    log(`Starting ADO Bridge (mode=${isMockExternalMode(configPath) ? 'mock' : 'live'}, org=${config.organization}, repo=${config.repositoryId || '(missing)'})`);
    if (!String(config.repositoryId || '').trim()) {
        log('Warning: project.repositoryId is empty — PR creation and repo-scoped ADO calls will fail until configured.');
    }

    for (const agentId of ['frontend', 'reviewer', 'devops', 'ux']) {
        watchAgent(agentId);
    }

    unsubStatusBus = onStatusChange((ev) => {
        if (ev.agentId === 'frontend' || ev.agentId === 'reviewer' || ev.agentId === 'devops' || ev.agentId === 'ux') {
            scheduleAgentPhaseCheck(ev.agentId);
        }
    });
}

export function stopAdoBridge() {
    if (unsubStatusBus) {
        unsubStatusBus();
        unsubStatusBus = null;
    }
    for (const timer of phaseDebounceTimers.values()) {
        clearTimeout(timer);
    }
    phaseDebounceTimers.clear();
    for (const file of statusWatchers) {
        unwatchFile(file);
    }
    statusWatchers = [];
    for (const [, timer] of activeBuildPollers) {
        clearInterval(timer);
    }
    activeBuildPollers.clear();
    lastPhases.clear();
    bridgeConfig = null;
    log('Stopped');
}

// ── Provider API stubs (azure-devops adapter) ─────────────────────────────────

export interface AdoPRCreateOptions {
    title: string;
    description?: string;
    sourceBranch: string;
    targetBranch: string;
    workItemIds?: string[];
    draft?: boolean;
}

export interface AdoPRResult {
    prId: number;
    url?: string;
    title?: string;
    status?: 'open' | 'merged' | 'closed' | 'draft';
    buildStatus?: 'pending' | 'passing' | 'failing' | 'unknown';
}

export async function createAdoPR(_opts: AdoPRCreateOptions): Promise<AdoPRResult> {
    throw new Error('createAdoPR: not yet implemented for this ADO configuration');
}

export async function getAdoPR(_prId: string): Promise<AdoPRResult | null> {
    throw new Error('getAdoPR: not yet implemented for this ADO configuration');
}

export async function triggerAdoBuild(_branch: string, _repo?: string): Promise<{ buildId: string; url?: string }> {
    throw new Error('triggerAdoBuild: not yet implemented for this ADO configuration');
}

export async function getAdoBuildStatus(_buildId: string): Promise<'pending' | 'passing' | 'failing' | 'unknown'> {
    throw new Error('getAdoBuildStatus: not yet implemented for this ADO configuration');
}
