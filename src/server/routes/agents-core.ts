import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { resetAllAgentsToIdle } from '../reset-agents';
import { isGlobalStepMode } from '../stepMode';
import { spawnAgent } from '../spawn-agent';
import { AGENT_RESET_CONFIRM_PHRASE } from '../../shared/agentResetConfirm';
import { skillSubdirForAgentId } from '../../shared/agentSkillDirs';
import { readBody, json, cors } from '../router';
import { getSchedulerConfig, getAgentModel, isAgentStepMode } from '../route-shared';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/agents/reset-to-idle ──────────────────────────────────────────────
    use('/api/agents/reset-to-idle', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const parsed = JSON.parse(body);
            const confirm = typeof parsed.confirm === 'string' ? parsed.confirm.trim() : '';
            if (confirm !== AGENT_RESET_CONFIRM_PHRASE) {
                json(res, {
                    error: 'Invalid confirmation',
                    hint: `POST JSON body must include confirm set exactly to "${AGENT_RESET_CONFIRM_PHRASE}".`,
                }, 400);
                return;
            }
            const result = resetAllAgentsToIdle(rootDir);
            json(res, { ok: true, ...result });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agent/dismiss-item ─────────────────────────────────────────────
    use('/api/agent/dismiss-item', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const parsed = body.trim() ? JSON.parse(body.trim()) : null;
            if (!parsed || typeof parsed !== 'object') { json(res, { error: 'Invalid JSON body' }, 400); return; }
            const { agentId, itemId, itemType } = parsed as { agentId?: string; itemId?: string; itemType?: string };
            if (!agentId || !itemId) { json(res, { error: 'agentId and itemId required' }, 400); return; }
            const statusFile = resolve(rootDir, `.${agentId}-status.json`);
            if (!existsSync(statusFile)) { json(res, { error: 'status file not found' }, 404); return; }
            const raw = readFileSync(statusFile, 'utf-8').replace(/^\uFEFF/, '');
            const s = JSON.parse(raw);
            if (itemType === 'request') {
                s.requests = Array.isArray(s.requests) ? s.requests.filter((r: { id: string }) => r.id !== itemId) : [];
            } else {
                s.tasks = Array.isArray(s.tasks) ? s.tasks.filter((t: { id: string }) => t.id !== itemId) : [];
            }
            writeFileSync(statusFile, JSON.stringify(s, null, 2));
            json(res, { ok: true, agentId, dismissed: itemId });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agent/task-reconciliation ─────────────────────────────────────
    use('/api/agent/task-reconciliation', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const parsed = body.trim() ? JSON.parse(body.trim()) : null;
            if (!parsed || typeof parsed !== 'object') { json(res, { error: 'Invalid JSON body' }, 400); return; }
            const { agentId, action } = parsed as { agentId?: string; action?: string };
            if (!agentId || (action !== 'reuse' && action !== 'recreate')) {
                json(res, { error: 'agentId and action=reuse|recreate required' }, 400);
                return;
            }
            const statusFile = resolve(rootDir, `.${agentId}-status.json`);
            if (!existsSync(statusFile)) { json(res, { error: 'status file not found' }, 404); return; }
            const status = parseJsonUtf8File(statusFile) as Record<string, unknown>;
            const reconciliation = status.taskReconciliation as { status?: string; storyNumber?: string } | undefined;
            if (!reconciliation || reconciliation.status !== 'pending') {
                json(res, { error: 'No pending task reconciliation for this agent' }, 409);
                return;
            }
            const now = new Date().toISOString();
            if (!Array.isArray(status.events)) status.events = [];
            if (action === 'reuse') {
                status.taskReconciliation = { ...reconciliation, status: 'reuse-confirmed', resolvedAt: now };
                status.currentPhase = 'analyzing';
                status.handoffDispatched = false;
                (status.events as Array<{ timestamp: string; type: string; message: string }>).push({
                    timestamp: now,
                    type: 'success',
                    message: `Existing tasks for story ${reconciliation.storyNumber || status.storyNumber || ''} approved for reuse.`,
                });
            } else {
                const currentTasks = Array.isArray(status.tasks) ? status.tasks as Array<Record<string, unknown>> : [];
                const archived = currentTasks.map((task) => ({
                    ...task,
                    archivedAt: now,
                    archivedReason: 'Recreated task plan during step-mode reconciliation',
                }));
                status.archivedTasks = [...(Array.isArray(status.archivedTasks) ? status.archivedTasks as unknown[] : []), ...archived];
                status.tasks = [];
                delete status.taskReconciliation;
                status.currentPhase = 'analyzing';
                status.handoffDispatched = false;
                (status.events as Array<{ timestamp: string; type: string; message: string }>).push({
                    timestamp: now,
                    type: 'warning',
                    message: `Archived ${archived.length} local task(s). Recreate the Phase 1 task list before starting work.`,
                });
            }
            writeFileSync(statusFile, JSON.stringify(status, null, 2));
            json(res, { ok: true, agentId, action, archivedCount: action === 'recreate' ? (Array.isArray(status.archivedTasks) ? status.archivedTasks.length : 0) : undefined });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agent/step-mode/global (must register before /api/agent/step-mode) ─
    use('/api/agent/step-mode/global', async (req, res) => {
        cors(res, 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'GET') {
            const cfg = getSchedulerConfig(rootDir);
            json(res, { globalStepMode: cfg.scheduler?.globalStepMode ?? false });
            return;
        }
        if (req.method === 'POST') {
            const body = await readBody(req);
            try {
                const parsed = body ? JSON.parse(body) : {};
                const cfg = getSchedulerConfig(rootDir);
                if (!cfg.scheduler) cfg.scheduler = { mode: 'notify', agents: {} };
                const next = parsed.globalStepMode !== undefined ? !!parsed.globalStepMode : !(cfg.scheduler.globalStepMode ?? false);
                cfg.scheduler.globalStepMode = next;
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                console.log(`[step-mode] global: ${!next} -> ${next}`);
                json(res, { globalStepMode: next });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
            return;
        }
        res.statusCode = 405; res.end('Method not allowed');
    });

    // ── /api/agent/step-mode ─────────────────────────────────────────────────
    use('/api/agent/step-mode', async (req, res) => {
        cors(res, 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        const agentId = (req.url || '').replace(/^\/api\/agent\/step-mode\/?/, '').replace(/\?.*$/, '');
        if (req.method === 'GET') {
            const cfg = getSchedulerConfig(rootDir);
            const globalStepMode = cfg.scheduler?.globalStepMode ?? false;
            json(res, { agentId, stepMode: cfg.scheduler?.agents?.[agentId]?.stepMode ?? false, globalStepMode });
            return;
        }
        if (req.method === 'POST') {
            const body = await readBody(req);
            try {
                const parsed = body ? JSON.parse(body) : {};
                const id = parsed.agentId || agentId;
                if (!id) { json(res, { error: 'agentId required' }, 400); return; }
                const cfg = getSchedulerConfig(rootDir);
                if (!cfg.scheduler) cfg.scheduler = { mode: 'notify', agents: {} };
                if (!cfg.scheduler.agents) cfg.scheduler.agents = {};
                if (cfg.scheduler.globalStepMode === true) {
                    json(res, {
                        error: 'Per-agent step mode cannot be changed while global step mode is on. Turn off global step mode first.',
                    }, 409);
                    return;
                }
                if (!cfg.scheduler.agents[id]) cfg.scheduler.agents[id] = { enabled: true, autoStart: false };
                const current = cfg.scheduler.agents[id].stepMode ?? false;
                const next = parsed.stepMode !== undefined ? !!parsed.stepMode
                    : parsed.enabled !== undefined ? !!parsed.enabled
                    : !current;
                cfg.scheduler.agents[id].stepMode = next;
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                console.log(`[step-mode] ${id}: ${current} -> ${next}`);
                json(res, { agentId: id, stepMode: next });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
            return;
        }
        res.statusCode = 405; res.end('Method not allowed');
    });

    // Retry / hook: spawn reviewer CLI when desk is pending-review but pr/created spawn failed or hook runs later.
    use('/api/reviewer/spawn-from-desk', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        try {
            const reviewerFile = resolve(rootDir, '.reviewer-status.json');
            if (!existsSync(reviewerFile)) { json(res, { error: 'No reviewer desk', spawned: false }, 404); return; }
            const st = parseJsonUtf8File(reviewerFile) as { currentPhase?: string; assignedPR?: { id?: number } };
            if (st.currentPhase !== 'pending-review' || !st.assignedPR?.id) {
                json(res, { error: 'Reviewer must be in pending-review with assignedPR', spawned: false }, 409);
                return;
            }
            const globalStepModeOn = isGlobalStepMode(configFile);
            const reviewerStepModeOn = isAgentStepMode('reviewer', rootDir);
            if (globalStepModeOn || reviewerStepModeOn) {
                json(res, {
                    spawned: false,
                    reason: globalStepModeOn ? 'global-step-mode' : 'reviewer-step-mode',
                    globalStepMode: globalStepModeOn,
                    reviewerStepMode: reviewerStepModeOn,
                });
                return;
            }
            const prId = Number(st.assignedPR.id);
            const prompt = `Review PR #${prId}. Read skills/${skillSubdirForAgentId('reviewer')}/SKILL.md and .reviewer-status.json, then perform a code review.`;
            const result = spawnAgent('reviewer', prompt, rootDir, getAgentModel('reviewer', rootDir));
            json(res, { ok: true, prId, ...result });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agent/model ─────────────────────────────────────────────────────
    // GET  ?agentId=developer   → { agentId, model }
    // PUT  { agentId, model }   → { ok, agentId, model }
    use('/api/agent/model', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'GET') {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const agentId = url.searchParams.get('agentId') || '';
            if (!agentId) { json(res, { error: 'agentId required' }, 400); return; }
            const cfg = getSchedulerConfig(rootDir);
            json(res, { agentId, model: cfg.scheduler?.agents?.[agentId]?.model ?? null });
            return;
        }
        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const { agentId, model } = JSON.parse(body) as { agentId?: string; model?: string };
                if (!agentId) { json(res, { error: 'agentId required' }, 400); return; }
                const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) as Record<string, any> : {};
                if (!cfg.scheduler) cfg.scheduler = {};
                if (!cfg.scheduler.agents) cfg.scheduler.agents = {};
                if (!cfg.scheduler.agents[agentId]) cfg.scheduler.agents[agentId] = {};
                if (model) cfg.scheduler.agents[agentId].model = model;
                else delete cfg.scheduler.agents[agentId].model;
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                json(res, { ok: true, agentId, model: model || null });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
            return;
        }
        res.statusCode = 405; res.end('Method not allowed');
    });
}
