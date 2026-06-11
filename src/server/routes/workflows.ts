import { resolve } from 'path';
import { existsSync } from 'fs';
import { getActiveProject } from '../project-config';
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
                const result = completePhase({
                    workflowItemId: idNum,
                    agentId: sdlcAgentId,
                    phase: sdlcPhase,
                    outputs: outputs && typeof outputs === 'object' ? outputs as Record<string, unknown> : {},
                    nextPhase: sdlcNextPhase,
                    message: typeof message === 'string' ? message : null,
                    validationPassed,
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
                            if (sn) freeStoryAgents(rootDir, sn, prId);
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
