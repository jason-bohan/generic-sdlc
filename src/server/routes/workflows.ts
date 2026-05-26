import { resolve } from 'path';
import { getActiveProject } from '../project-config';
import { spawnAgent } from '../spawn-agent';
import { completePhase, startPhaseRun, superviseWorkflow } from '../orchestrator';
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
                    skillFile: null,
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
                const result = completePhase({
                    workflowItemId: idNum,
                    agentId: sdlcAgentId,
                    phase: sdlcPhase,
                    outputs: outputs && typeof outputs === 'object' ? outputs as Record<string, unknown> : {},
                    nextPhase: sdlcNextPhase,
                    message: typeof message === 'string' ? message : null,
                });
                if (!result.ok) {
                    json(res, { error: result.error, missing: result.missing }, 409);
                    return;
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
