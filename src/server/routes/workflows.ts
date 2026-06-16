import { resolve } from 'path';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { getActiveProject } from '../project-config';
import { deskRailFlags, recordRunOutcome } from '../railFlags';
import { spawnAgent } from '../spawn-agent';
import { completePhase, startPhaseRun, superviseWorkflow } from '../orchestrator';
import { freeStoryAgents, storyNumberFromDesk } from '../reset-agents';
import { parseJsonUtf8File } from '../json-file';
import {
    dbGetPhaseEvents,
    dbGetWorkflowItemByStory,
    dbGetWorkflowItem,
    dbListActiveWorkflowItems,
    dbRecordPhaseEvent,
    dbGetWorkflowArtifacts,
} from '../db';
import { readBody, json } from '../router';
import {
    SDLC_AGENT_IDS,
    SDLC_PHASE_IDS,
    asSdlcAgentId,
    asSdlcPhaseId,
} from '../status-normalize';
import { getAgentModel } from '../route-shared';
import { getSchedulerWorkflowMode } from '../schedulerMode';
import { autoCommitWorktree, autoCreatePr } from '../agent-runner/commit-pr';
import type { UseFn } from './types';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/workflows ───────────────────────────────────────────────────────
    use('/api/workflows', async (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        if (req.method === 'POST' && url.pathname.endsWith('/run-phase')) {
            const body = await readBody(req);
            try {
                const { workflowItemId, storyNumber, agentId: bodyAgentId, spawn } = JSON.parse(body || '{}');
                let resolvedWorkflowItemId = Number(workflowItemId || 0);
                if (!resolvedWorkflowItemId && typeof storyNumber === 'string' && storyNumber.trim()) {
                    const lookupAgent = typeof bodyAgentId === 'string' ? bodyAgentId.trim() : undefined;
                    resolvedWorkflowItemId = dbGetWorkflowItemByStory(storyNumber.trim(), lookupAgent)?.id ?? 0;
                }
                if (!resolvedWorkflowItemId) {
                    json(res, { error: 'workflowItemId or storyNumber is required' }, 400);
                    return;
                }
                const serverBaseUrl = `http://${req.headers.host || 'localhost:3001'}`;
                const activeProf = getActiveProject(configFile);
                const hasTarget = !!activeProf?.workspacePath && activeProf.workspacePath !== rootDir;
                const agentIdForPlan = dbGetWorkflowItem(resolvedWorkflowItemId)?.active_agent_id ?? '';
                const plan = startPhaseRun({
                    workflowItemId: resolvedWorkflowItemId,
                    serverBaseUrl,
                    statusFile: hasTarget
                        ? resolve(rootDir, `.${agentIdForPlan}-status.json`)
                        : undefined,
                    skillFile: resolve(rootDir, `skills/${agentIdForPlan}/SKILL.md`),
                    targetCodebase: activeProf?.workspacePath ?? null,
                });
                if (!plan.ok || !plan.value) {
                    json(res, { error: plan.error }, 409);
                    return;
                }
                let agentSpawned = false;
                if (spawn !== false) {
                    try {
                        agentSpawned = spawnAgent(
                            plan.value.item.active_agent_id,
                            plan.value.prompt,
                            rootDir,
                            getAgentModel(plan.value.item.active_agent_id, rootDir),
                        ).spawned;
                    } catch (e) {
                        console.error('[run-phase] spawn failed:', e);
                    }
                }
                json(res, { ok: true, workflow: plan.value.item, prompt: plan.value.prompt, agentSpawned });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 400); }
            return;
        }
        if (req.method === 'POST' && url.pathname.endsWith('/supervise')) {
            const body = await readBody(req);
            try {
                const { workflowItemId, storyNumber, agentId: bodyAgentId, record } = JSON.parse(body || '{}');
                let resolvedWorkflowItemId = Number(workflowItemId || 0);
                if (!resolvedWorkflowItemId && typeof storyNumber === 'string' && storyNumber.trim()) {
                    const lookupAgent = typeof bodyAgentId === 'string' ? bodyAgentId.trim() : undefined;
                    resolvedWorkflowItemId = dbGetWorkflowItemByStory(storyNumber.trim(), lookupAgent)?.id ?? 0;
                }
                if (!resolvedWorkflowItemId) {
                    json(res, { error: 'workflowItemId or storyNumber is required' }, 400);
                    return;
                }
                const decision = superviseWorkflow(resolvedWorkflowItemId);
                if (!decision.ok || !decision.value) {
                    json(res, { error: decision.error }, 404);
                    return;
                }
                if (record !== false) {
                    dbRecordPhaseEvent({
                        workflowItemId: decision.value.workflow.id,
                        agentId: 'orchestrator',
                        phase: decision.value.workflow.active_phase,
                        eventType: 'supervisor-check',
                        outputs: { auditEvent: { actions: decision.value.actions.map(a => a.type) } },
                        message: `Supervisor recommended ${decision.value.actions.map(a => a.type).join(', ')}`,
                    });
                }
                json(res, { ok: true, ...decision.value });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 400); }
            return;
        }
        if (req.method === 'POST' && url.pathname.endsWith('/complete-phase')) {
            const body = await readBody(req);
            try {
                const parsed = JSON.parse(body) as Record<string, unknown>;
                const { workflowItemId, agentId, phase, outputs, nextPhase, message } = parsed;
                const idNum = Number(workflowItemId);
                const fieldErrors: Record<string, string> = {};
                if (workflowItemId === undefined || workflowItemId === null || !Number.isFinite(idNum) || idNum <= 0) {
                    fieldErrors.workflowItemId = 'required positive numeric workflowItemId';
                }
                if (typeof agentId !== 'string' || !agentId.trim()) {
                    fieldErrors.agentId = 'required string (e.g. frontend, backend)';
                } else if (!asSdlcAgentId(agentId.trim())) {
                    fieldErrors.agentId = `unknown agentId "${agentId.trim()}"; allowed: ${[...SDLC_AGENT_IDS].filter((x) => x !== 'orchestrator').sort().join(', ')}`;
                }
                if (typeof phase !== 'string' || !phase.trim()) {
                    fieldErrors.phase = 'required string (SDL workflow phase id, not ad-hoc labels)';
                } else if (!asSdlcPhaseId(phase.trim())) {
                    fieldErrors.phase = `unknown phase "${phase.trim()}"; must be an orchestrator phase id (e.g. reading-story, analyzing)`;
                }
                if (typeof nextPhase !== 'string' || !nextPhase.trim()) {
                    fieldErrors.nextPhase = 'required string (next orchestrator phase id)';
                } else if (!asSdlcPhaseId(nextPhase.trim())) {
                    fieldErrors.nextPhase = `unknown nextPhase "${nextPhase.trim()}"`;
                }
                if (Object.keys(fieldErrors).length) {
                    json(res, {
                        error: 'Invalid complete-phase request',
                        fieldErrors,
                        hint: 'Agent card phases in the UI (e.g. planning, creating-tasks) may differ from orchestrator phases in SQLite. Use active_phase from GET /api/workflows?id=<id> or the payload in the phase runner prompt.',
                    }, 400);
                    return;
                }
                const sdlcAgentId = asSdlcAgentId((agentId as string).trim())!;
                const sdlcPhase = asSdlcPhaseId((phase as string).trim())!;
                const sdlcNextPhase = asSdlcPhaseId((nextPhase as string).trim())!;
                // Strength-flagged rails for this agent's run (written to the desk at assignment).
                const railFlags = deskRailFlags(sdlcAgentId, rootDir);
                // Authoritative validation verdict: the framework's own run_validation records
                // lastValidationResult on the agent desk. Read it here so the forward-progress guard
                // can trust it over what the model copied (or forgot to copy) into its outputs.
                let validationPassed: boolean | undefined;
                if (sdlcPhase === 'validating') {
                    try {
                        const deskFile = resolve(rootDir, `.${sdlcAgentId}-status.json`);
                        if (existsSync(deskFile)) {
                            const desk = parseJsonUtf8File(deskFile) as Record<string, unknown>;
                            if (desk.lastValidationResult === 'passed') validationPassed = true;
                            else if (desk.lastValidationResult === 'failed') validationPassed = false;
                        }
                    } catch { /* best-effort; fall back to model-reported evidence */ }
                }
                // Rail: generating-code must produce real file changes. Codestral sometimes
                // reads/searches then completes the phase empty, which advances (or, after the
                // per-phase auto-resume cap, stalls) with no implementation. Reject when the
                // story worktree has no changes so the loop retries instead. The agent's
                // create_file/edit_file tools materialize the worktree on first write, so an
                // absent or clean worktree means nothing was written. Skipped for self-dev
                // (workspace === framework root) where there is no target worktree.
                if (sdlcPhase === 'generating-code' && railFlags.has('emptyCodeGenGate')) {
                    const storyNum = dbGetWorkflowItem(idNum)?.story_number?.trim();
                    const workspaceDir = getActiveProject(configFile)?.workspacePath;
                    if (storyNum && workspaceDir && workspaceDir !== rootDir) {
                        const wt = resolve(workspaceDir, '.claude', 'worktrees', `${sdlcAgentId}-${storyNum}`);
                        let hasChanges = false;
                        if (existsSync(wt)) {
                            try {
                                const out = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8', timeout: 10_000 });
                                hasChanges = out.split('\n').some(l => l.trim() && !l.includes('node_modules/'));
                            } catch { hasChanges = true; /* git check failed — fail open, don't block */ }
                        }
                        if (!hasChanges) {
                            json(res, {
                                error: `generating-code cannot complete for ${storyNum}: no file changes in the worktree. Use create_file/edit_file to write the implementation (and its test) before calling complete_phase — do not just read or search files.`,
                                missing: ['code-changes'],
                            }, 409);
                            return;
                        }
                    }
                }
                // Subprocess-path side-effects. The in-process loop driver runs commit + PR
                // creation in its complete_phase tool (phase-tools.ts) and POSTs here with the
                // results already in `outputs`. The claude-code subprocess POSTs the bare contract,
                // so without this it advanced committing/creating-pr with no commit and no PR
                // (observed: UNW-141 reached watching-reviews with prs:[]). Gated so the loop driver
                // (which leaves a clean tree / sets outputs.pr) never double-fires.
                {
                    const wfItem = dbGetWorkflowItem(idNum);
                    const storyNum = wfItem?.story_number?.trim() || '';
                    const workspaceDir = getActiveProject(configFile)?.workspacePath;
                    const onTarget = !!workspaceDir && workspaceDir !== rootDir && !!storyNum;
                    const out = (outputs && typeof outputs === 'object') ? outputs as Record<string, unknown> : {};
                    if (onTarget && sdlcPhase === 'committing') {
                        // Only the subprocess path leaves the worktree dirty here; the loop driver
                        // already committed in-process (clean tree) → skip to avoid a double commit.
                        const wt = resolve(workspaceDir!, '.claude', 'worktrees', `${sdlcAgentId}-${storyNum}`);
                        let dirty = false;
                        if (existsSync(wt)) {
                            try { dirty = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8', timeout: 10_000 }).split('\n').some(l => l.trim() && !l.includes('node_modules/')); } catch { /* fail closed: skip */ }
                        }
                        if (dirty) {
                            const changeTitle = `${storyNum}: ${wfItem?.story_name || 'changes'}`.slice(0, 120);
                            const ac = autoCommitWorktree(workspaceDir!, sdlcAgentId, storyNum, changeTitle);
                            if (!ac.ok) { json(res, { error: `Cannot complete committing for ${storyNum}: ${ac.note}. This phase needs real committed source changes — implement the story in generating-code first.`, missing: ['commit'] }, 409); return; }
                        }
                    }
                    if (onTarget && sdlcPhase === 'creating-pr' && !out.pr && !out.mockPr) {
                        const changeTitle = `${storyNum}: ${wfItem?.story_name || 'changes'}`.slice(0, 120);
                        const prBody = `Story ${storyNum}${wfItem?.story_name ? `: ${wfItem.story_name}` : ''}\n\nOpened automatically by the ${sdlcAgentId} agent.`;
                        const autoPr = autoCreatePr(workspaceDir!, sdlcAgentId, storyNum, changeTitle, prBody, configFile);
                        if (!autoPr.ok) { json(res, { error: `Cannot complete creating-pr for ${storyNum}: ${autoPr.note}.`, missing: ['pr'] }, 409); return; }
                        const prMeta = (autoPr.pr ?? autoPr.mockPr) as { number?: number; url?: string; title?: string; branch?: string } | undefined;
                        if (prMeta && typeof prMeta.number === 'number' && prMeta.number > 0) {
                            const serverUrl = `http://${req.headers.host || 'localhost:3001'}`;
                            const handoffBody = JSON.stringify({ agentId: sdlcAgentId, prId: prMeta.number, prTitle: prMeta.title || changeTitle, prUrl: prMeta.url, storyNumber: storyNum, branch: prMeta.branch });
                            for (let attempt = 1; attempt <= 3; attempt++) {
                                try { const r = await fetch(`${serverUrl}/api/pr/created`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: handoffBody, signal: AbortSignal.timeout(20_000) }); if (r.ok) break; } catch { /* retry */ }
                                if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
                            }
                        }
                    }
                }
                const result = completePhase({
                    workflowItemId: idNum,
                    agentId: sdlcAgentId,
                    phase: sdlcPhase,
                    outputs: outputs && typeof outputs === 'object' ? outputs as Record<string, unknown> : {},
                    nextPhase: sdlcNextPhase,
                    message: typeof message === 'string' ? message : null,
                    validationPassed,
                    forwardProgressCoerce: railFlags.has('forwardProgressCoerce'),
                });
                if (!result.ok) {
                    json(res, { error: result.error, missing: result.missing }, 409);
                    return;
                }
                // Autonomous mode: auto-spawn agent for the next phase
                if (result.value) {
                    const nextItem = result.value;
                    if (nextItem.active_phase === 'complete') {
                        // Story-scoped completion (orchestrator-owned): free ONLY this story's
                        // desks so a finished story can't leave stale PR state that contaminates
                        // the next run, and never wipes agents working other stories. Replaces
                        // the blunt global reset for the autonomous path.
                        try {
                            let sn = typeof nextItem.story_number === 'string' ? nextItem.story_number.trim() : '';
                            let prId: number | undefined;
                            // devops completes a PR-scoped build whose workflow item often has no
                            // story_number — derive it (and the PR id) from the completing agent's
                            // desk so the story owner + reviewer actually get freed and the
                            // orchestrator can pick up the next story (otherwise the owner stays
                            // "busy" at watching-reviews and back-to-back stalls).
                            if (!sn && agentId) {
                                try {
                                    const desk = parseJsonUtf8File(resolve(rootDir, `.${agentId}-status.json`)) as { storyNumber?: string; assignedPR?: { storyNumber?: string; branch?: string; id?: number } | null };
                                    sn = storyNumberFromDesk(desk);
                                    const pid = desk.assignedPR?.id;
                                    if (typeof pid === 'number') prId = pid;
                                } catch { /* no desk to derive from */ }
                            }
                            if (sn) {
                                // Phase 3: record a clean completion for each impl agent that owned
                                // this story (attributed to its worker model), BEFORE the desks are
                                // freed, so a successful model earns a better learned strength.
                                try {
                                    for (const impl of ['frontend', 'backend', 'qa', 'ux']) {
                                        const wf = dbGetWorkflowItemByStory(sn, impl);
                                        if (!wf) continue;
                                        let wm: unknown;
                                        try { wm = (parseJsonUtf8File(resolve(rootDir, `.${impl}-status.json`)) as { workerModel?: unknown }).workerModel; } catch { /* no desk */ }
                                        const events = dbGetPhaseEvents(wf.id);
                                        const since = events.map(e => e.event_type).lastIndexOf('assigned') + 1;
                                        const devLoopStarts = events.slice(since).filter(e => e.event_type === 'phase-started' && ['analyzing', 'generating-code', 'validating'].includes(e.phase)).length;
                                        recordRunOutcome(rootDir, typeof wm === 'string' ? wm : undefined, { stalled: false, devLoopStarts });
                                    }
                                } catch { /* non-fatal — learning is best-effort */ }
                                freeStoryAgents(rootDir, sn, prId);
                            }
                        } catch (e) { console.warn('[complete] freeStoryAgents failed:', e); }
                    } else if (nextItem.active_phase && nextItem.active_phase !== 'idle') {
                        try {
                            const mode = getSchedulerWorkflowMode(configFile);
                            if (mode === 'autonomous' && nextItem.active_agent_id) {
                                const activeProf = getActiveProject(configFile);
                                const serverBaseUrl = `http://${req.headers.host || 'localhost:3001'}`;
                                const hasTarget = !!activeProf?.workspacePath && activeProf.workspacePath !== rootDir;
                                const agentId = nextItem.active_agent_id;
                                const phasePlan = startPhaseRun({
                                    workflowItemId: nextItem.id,
                                    serverBaseUrl,
                                    statusFile: hasTarget
                                        ? resolve(rootDir, `.${agentId}-status.json`)
                                        : undefined,
                                    skillFile: resolve(rootDir, `skills/${agentId}/SKILL.md`),
                                    targetCodebase: activeProf?.workspacePath ?? null,
                                });
                                if (phasePlan.ok && phasePlan.value) {
                                    spawnAgent(
                                        phasePlan.value.item.active_agent_id,
                                        phasePlan.value.prompt,
                                        rootDir,
                                        getAgentModel(phasePlan.value.item.active_agent_id, rootDir),
                                    );
                                }
                            }
                        } catch { /* non-critical — next phase will be picked up on next assignment */ }
                    }
                }
                json(res, { ok: true, workflow: result.value });
            } catch (e: unknown) {
                json(res, { error: e instanceof Error ? e.message : String(e), fieldErrors: { _parse: 'body must be a JSON object' } }, 400);
            }
            return;
        }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        try {
            const workflowId = Number(url.searchParams.get('id') || 0);
            if (workflowId > 0) {
                json(res, {
                    workflow: dbGetWorkflowItem(workflowId),
                    events: dbGetPhaseEvents(workflowId).map(e => ({ ...e, outputs: JSON.parse(e.outputs_json || '{}') })),
                    artifacts: dbGetWorkflowArtifacts(workflowId).map(a => ({ ...a, payload: JSON.parse(a.payload_json || '{}') })),
                });
                return;
            }
            json(res, { workflows: dbListActiveWorkflowItems() });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
