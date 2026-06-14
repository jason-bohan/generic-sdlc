import { writeFileSync, existsSync } from 'fs';
import { parseJsonUtf8File } from '../json-file';
import { resolve } from 'path';
import { matchTrigger } from '../../messages/triggers';
import { dbGetMessages, dbUpdateMessageStatus, dbGetSession } from '../db';
import { getActiveSessionId, isRunnerActive, registryEvents, stopRunner } from '../agent-runner';
import { getSchedulerWorkflowMode } from '../schedulerMode';
import { findStoryOwnerByPrId, wrapUpDeskRequestId } from '../handoff';
import { phaseAllowsContinueTaskScope } from '../../shared/agentPhases';
import { skillSubdirForAgentId } from '../../shared/agentSkillDirs';
import { spawnAgent, getActiveAgents } from '../spawn-agent';
import { isAgentStepModePhase, isGlobalStepMode } from '../stepMode';
import { readBody, json, cors } from '../router';
import {
    getAgentModel,
    isAgentStepMode,
    resolveDevopsStatusPrId,
    storyNumberFromOwnerStatus } from '../route-shared';
import { buildContextPreamble } from '../contextLoader';
import { startPhaseRun } from '../orchestrator';
import { dbGetWorkflowItemByStory, dbGetPhaseEvents } from '../db';
import { devLoopAction, markDevLoopStuck, isReworkStuck, escalatedRespawnModel } from '../rework-cap';
import { asStrength, decayStrength, computeRailFlags } from '../railFlags';
import { notify } from '../providers';
import { getActiveProject } from '../project-config';
import { resolve as pathResolve } from 'path';
import type { UseFn } from './types';

// In-memory auto-resume counter for agents without a matching workflow item
// (e.g. devops where storyNumber is a PR number, not a real story key).
const memoryResumeCounts = new Map<string, number>();

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/agent/continue ──────────────────────────────────────────────────
    use('/api/agent/continue', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            let parsed: unknown;
            try {
                const trimmed = body.trim();
                parsed = trimmed === '' ? {} : JSON.parse(trimmed);
            } catch {
                json(res, { error: 'Invalid JSON body' }, 400);
                return;
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                json(res, { error: 'Expected a JSON object body' }, 400);
                return;
            }
            const { agentId, selectedTaskIds, selectedRequestIds, phaseHint } = parsed as {
                agentId?: unknown;
                selectedTaskIds?: unknown;
                selectedRequestIds?: unknown;
                phaseHint?: unknown;
            };
            if (typeof agentId !== 'string' || !agentId.trim()) {
                json(res, { error: 'agentId required' }, 400);
                return;
            }
            const agentIdStr = agentId.trim();
            // Guard against double-spawn: the status-bus and process-exit auto-continue
            // paths can both fire for the same transition. If a process is already
            // running for this agent, skip rather than start a second one.
            if (agentIdStr in getActiveAgents() || isRunnerActive(agentIdStr)) {
                json(res, { ok: true, skipped: 'already-running' }, 200);
                return;
            }
            const statusFile = resolve(rootDir, `.${agentIdStr}-status.json`);
            let phase = 'idle', storyNum = '';
            let statusSnapshot: Record<string, unknown> | null = null;
            let requests: Array<{ id: string; summary: string; file?: string; line?: number }> = [];
            if (existsSync(statusFile)) {
                try {
                    const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                    statusSnapshot = s;
                    phase = String(s.currentPhase || 'idle').trim() || 'idle';
                    storyNum = String(s.storyNumber ?? '').trim();
                    if (Array.isArray(s.requests)) requests = s.requests as Array<{ id: string; summary: string; file?: string; line?: number }>;
                    if (s.handoffDispatched) {
                        s.handoffDispatched = false;
                    }
                    if (agentIdStr === 'devops' && s.currentPhase === 'pending-build' && s.manualStartRequired === true) {
                        s.manualStartRequired = false;
                        if (!Array.isArray(s.events)) s.events = [];
                        (s.events as Array<{ timestamp: string; type: string; message: string }>).push({
                            timestamp: new Date().toISOString(),
                            type: 'phase',
                            message: 'Manual DevOps pickup approved. CI build may start.',
                        });
                    }
                    if (s.handoffDispatched === false || s.manualStartRequired === false) {
                        writeFileSync(statusFile, JSON.stringify(s, null, 2));
                    }
                } catch (e) {
                    json(
                        res,
                        {
                            error: `Invalid or unreadable status file .${agentIdStr}-status.json: ${e instanceof Error ? e.message : String(e)}` },
                        500,
                    );
                    return;
                }
            }
            const requestedTaskIds = Array.isArray(selectedTaskIds) ? selectedTaskIds : [];
            const appliedTaskIds = phaseAllowsContinueTaskScope(phase) ? requestedTaskIds : [];
            if (appliedTaskIds.length > 0 && existsSync(statusFile)) {
                try {
                    const selected = new Set(appliedTaskIds.map((id) => String(id)));
                    const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                    if (Array.isArray(s.tasks)) {
                        s.tasks = s.tasks.map((task: Record<string, unknown>) => {
                            const taskId = String(task.id ?? task.number ?? '');
                            const status = String(task.status ?? 'pending');
                            if (!selected.has(taskId) || status === 'completed' || status === 'failed') return task;
                            return { ...task, status: 'in_progress' };
                        });
                        s.activePrBatchTaskIds = appliedTaskIds.map((id) => String(id));
                        if (!Array.isArray(s.events)) s.events = [];
                        (s.events as Array<{ timestamp: string; type: string; message: string }>).push({
                            timestamp: new Date().toISOString(),
                            type: 'phase',
                            message: `Selected ${appliedTaskIds.length} task(s) for development: ${appliedTaskIds.join(', ')}`,
                        });
                        writeFileSync(statusFile, JSON.stringify(s, null, 2));
                    }
                } catch { /* non-fatal: continue can still spawn with prompt scope */ }
            }
            let taskScope = '';
            if (appliedTaskIds.length > 0) {
                taskScope = ` Work on these tasks only: ${appliedTaskIds.join(', ')}. Skip all others.`;
            }
            let requestScope = '';
            if (Array.isArray(selectedRequestIds) && selectedRequestIds.length > 0) {
                const selected = requests.filter(r => selectedRequestIds.includes(r.id));
                const descriptions = selected.map(r => {
                    let desc = `${r.id}: ${r.summary}`;
                    if (r.file) desc += ` (${r.file}${r.line ? `:${r.line}` : ''})`;
                    return desc;
                });
                const selectedIds = new Set(selected.map(r => r.id));
                for (const id of selectedRequestIds) {
                    if (typeof id !== 'string' || selectedIds.has(id)) continue;
                    if (/^WRAPUP(?:-[A-Za-z0-9-]+)?-PR-\d+$/.test(id)) {
                        descriptions.push(`${id}: story wrap-up after CI (complete per .cursor/rules/story-wrapup.mdc).`);
                    }
                }
                if (descriptions.length > 0) {
                    requestScope = ` Address these change requests: ${descriptions.join('; ')}.`;
                }
            }
            let phaseHintClause = '';
            if (typeof phaseHint === 'string' && phaseHint.trim()) {
                const hint = phaseHint.trim();
                if (hint === 'creating-pr') {
                    phaseHintClause = ' Proceed to create a PR with the completed work.';
                } else {
                    phaseHintClause = ` User direction: proceed with phase hint '${hint}'.`;
                }
            }
            const scopeSuffix = `${taskScope}${requestScope}`;
            let prompt: string;
            let spawnOpts: { bypassHandoffDispatched?: boolean } | undefined;
            if (agentIdStr === 'devops' && phase === 'build-passed' && statusSnapshot) {
                const prId = resolveDevopsStatusPrId(statusSnapshot);
                if (prId != null) {
                    const desk = statusSnapshot.assignedPR as { storyNumber?: string | null } | undefined;
                    let devopsStorySnap: string | undefined;
                    if (typeof desk?.storyNumber === 'string' && desk.storyNumber.trim()) devopsStorySnap = desk.storyNumber.trim();
                    const statusStory = typeof statusSnapshot.storyNumber === 'string' && String(statusSnapshot.storyNumber).trim()
                        ? String(statusSnapshot.storyNumber).trim()
                        : undefined;
                    const ownerSn = storyNumberFromOwnerStatus(findStoryOwnerByPrId(rootDir, prId)?.status);
                    const fileReqs = Array.isArray(statusSnapshot.requests)
                        ? statusSnapshot.requests as Array<{ id?: unknown }>
                        : [];
                    const wrapRow = fileReqs.find(
                        (r) => typeof r.id === 'string'
                            && String(r.id).startsWith('WRAPUP-')
                            && String(r.id).endsWith(`-PR-${prId}`),
                    );
                    const wrapDismissId = (wrapRow && typeof wrapRow.id === 'string' && wrapRow.id)
                        ? wrapRow.id
                        : wrapUpDeskRequestId(ownerSn || devopsStorySnap || statusStory, prId);
                    prompt =
                        buildContextPreamble(rootDir) +
                        `Build passed for PR #${prId}. Read .cursor/rules/story-wrapup.mdc and skills/${skillSubdirForAgentId('devops')}/SKILL.md: ` +
                        'run wrap-up (ADO, Agility, reset agents), dismiss open request ' +
                        `${wrapDismissId} on the DevOps desk Tasks list when finished, then set .devops-status.json to idle with assignedPR null.` +
                        scopeSuffix;
                    spawnOpts = { bypassHandoffDispatched: true };
                } else {
                    prompt = buildContinuePrompt(agentIdStr, phase, storyNum, rootDir, configFile, scopeSuffix, phaseHintClause);
                }
            } else {
                prompt = buildContinuePrompt(agentIdStr, phase, storyNum, rootDir, configFile, scopeSuffix, phaseHintClause);
            }
            let spawned = false;
            try {
                const spawnResult = spawnAgent(agentIdStr, prompt, rootDir, getAgentModel(agentIdStr, rootDir), spawnOpts);
                spawned = spawnResult.spawned;
            } catch (e) { console.error('[continue] spawn failed:', e); }
            // This route clears handoffDispatched first so spawnAgent can run; _doSpawn sets it true only when
            // a child starts. For step-mode /api/agent/continue, always latch after a successful POST so hooks and
            // integration tests stay consistent when spawn is skipped (dedup, test-runner suppression, or missing CLI).
            if (existsSync(statusFile)) {
                try {
                    const s2 = parseJsonUtf8File(statusFile);
                    s2.handoffDispatched = true;
                    writeFileSync(statusFile, JSON.stringify(s2, null, 2));
                } catch { /* non-fatal */ }
            }
            json(res, { ok: true, agentId: agentIdStr, phase, spawned, selectedTaskIds: appliedTaskIds, selectedRequestIds: Array.isArray(selectedRequestIds) ? selectedRequestIds : [], phaseHint: typeof phaseHint === 'string' ? phaseHint : undefined });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agent/stop ──────────────────────────────────────────────────────
    use('/api/agent/stop', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId } = JSON.parse(body);
            if (!agentId || typeof agentId !== 'string') { json(res, { error: 'agentId required' }, 400); return; }
            const stopped = stopRunner(agentId.trim());
            json(res, { ok: stopped, agentId: agentId.trim(), stopped });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agent/pause ────────────────────────────────────────────────────
    // Stop the agent's runner and mark it as paused so auto-resume skips it.
    // The user must manually Continue to resume.
    use('/api/agent/pause', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId } = JSON.parse(body);
            if (!agentId || typeof agentId !== 'string') { json(res, { error: 'agentId required' }, 400); return; }
            const id = agentId.trim();
            stopRunner(id);
            const statusFile = resolve(rootDir, `.${id}-status.json`);
            try {
                const status = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                status.paused = true;
                status.handoffDispatched = false;
                writeFileSync(statusFile, JSON.stringify(status, null, 2));
            } catch { /* no status file to update */ }
            json(res, { ok: true, agentId: id, paused: true });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/hook/agent-stop ─────────────────────────────────────────────────
    // IDE-agnostic watcher trigger. Any IDE (or CI/CD) can POST here instead of
    // running the .cursor/hooks/*.ps1 scripts directly. Returns the same
    // { followup_message } shape that Cursor hooks consume, so callers can
    // inject it into the active agent session.
    use('/api/hook/agent-stop', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId } = JSON.parse(body);
            if (!agentId || typeof agentId !== 'string') { json(res, { error: 'agentId required' }, 400); return; }

            const statusFile = resolve(rootDir, `.${agentId}-status.json`);
            const messagesFile = resolve(rootDir, `.${agentId}-messages.json`);

            if (!existsSync(statusFile)) { json(res, {}); return; }

            const status = parseJsonUtf8File(statusFile);

            // Phase kickoff: agent has a story assigned but hasn't started yet
            if (status.currentPhase === 'reading-story') {
                const storyNum = status.storyNumber || '';
                const storyName = status.storyName || '';
                json(res, {
                    followup_message: buildContextPreamble(rootDir) +
                        `${agentId} agent has story ${storyNum}${storyName ? ` (${storyName})` : ''} in reading-story phase. ` +
                        `Read skills/${skillSubdirForAgentId(agentId)}/SKILL.md and execute the workflow starting at Phase 1. ` +
                        `Update .${agentId}-status.json after each phase.` });
                return;
            }

            // Terminal states
            if (status.currentPhase === 'complete') {
                const storyNum = status.storyNumber || '';
                json(res, {
                    followup_message: `${agentId} story ${storyNum} is complete. Workflow finished — no further action needed.` });
                return;
            }
            if (status.currentPhase === 'error') {
                const storyNum = status.storyNumber || '';
                json(res, {
                    followup_message: `${agentId} is in an error state${storyNum ? ` for story ${storyNum}` : ''}. ` +
                        `Check .${agentId}-status.json events for details, then fix the issue and resume or reassign the story.` });
                return;
            }

            // Step-mode pause — agent has reached a configured checkpoint
            if (isAgentStepMode(agentId, rootDir) && isAgentStepModePhase(agentId, status.currentPhase, configFile)) {
                const storyNum = status.storyNumber || '';
                const globalOn = isGlobalStepMode(configFile);
                const globalHint = globalOn
                    ? ' Global step mode is ON (dashboard header toggle or scheduler.globalStepMode); it applies to all agents even if this agent\'s own Step switch is off.'
                    : '';
                json(res, {
                    followup_message: `Step-mode pause: ${agentId} is paused at '${status.currentPhase}'` +
                        (storyNum ? ` for story ${storyNum}` : '') +
                        `. Review .${agentId}-status.json to verify the phase output, then continue from the dashboard (or POST /api/agent/continue).` +
                        globalHint });
                return;
            }

            // Pending /btw messages — read from SQLite (unified storage), then check JSON file as fallback
            if (status.currentPhase !== 'idle') {
                const dbMsgs = dbGetMessages(agentId);
                const pendingDb = dbMsgs.filter(m => m.from_who === 'user' && m.status === 'pending');

                // Also check the legacy JSON file for messages written directly (e.g. btw CLI in offline mode)
                const legacyPending: Array<{ id?: string; message?: string; text?: string }> = [];
                if (existsSync(messagesFile)) {
                    try {
                        const raw = parseJsonUtf8File(messagesFile) as Array<{ id?: string; from?: string; status?: string; message?: string; text?: string }>;
                        legacyPending.push(...raw.filter(m => m.from === 'user' && m.status !== 'acted' && m.status !== 'read'));
                    } catch { /* ignore */ }
                }

                const allPending = [
                    ...pendingDb.map(m => ({ id: m.id, message: m.message })),
                    ...legacyPending.map(m => ({ id: m.id, message: m.message ?? m.text ?? '' })),
                ];

                for (const msg of allPending) {
                    const text = msg.message ?? '';
                    const match = matchTrigger(text);
                    if (match) {
                        if (msg.id) dbUpdateMessageStatus(msg.id, 'acted');
                        json(res, {
                            followup_message: `INTERRUPT: /btw message matched trigger '${match.trigger}'. ${match.description}. ` +
                                `Read skills/${skillSubdirForAgentId(agentId)}/SKILL.md and transition to phase '${match.targetPhase}'. ` +
                                `Update .${agentId}-status.json.` });
                        return;
                    }
                }

                if (allPending.length > 0) {
                    json(res, {
                        followup_message: `${agentId} agent has ${allPending.length} pending /btw message(s). ` +
                            `Read skills/${skillSubdirForAgentId(agentId)}/SKILL.md and address the messages. ` +
                            `Messages: ${allPending.map(m => `"${(m.message ?? '').slice(0, 80)}"`).join('; ')}` });
                    return;
                }
            }

            if (agentId === 'devops' && status.currentPhase === 'build-passed') {
                const ap = status.assignedPR as { id?: number; title?: string; storyNumber?: string | null } | null | undefined;
                const pid = ap?.id;
                const ptitle = typeof ap?.title === 'string' ? ap.title : '';
                const sn = typeof ap?.storyNumber === 'string' && ap.storyNumber.trim() ? ap.storyNumber.trim() : '';
                const snTxt = sn ? ` Story ${sn}.` : '';
                const prNum = typeof pid === 'number' ? pid : Number(pid);
                const wrapDeskId = Number.isFinite(prNum) && prNum > 0 ? wrapUpDeskRequestId(sn || undefined, prNum) : null;
                const deskHint = wrapDeskId
                    ? `The dashboard lists open request ${wrapDeskId} under Tasks on the DevOps desk.`
                    : 'Open the DevOps desk Tasks list for the wrap-up item.';
                json(res, {
                    followup_message:
                        `DevOps: CI passed for PR #${pid} (${ptitle}).${snTxt} Run wrap-up per .cursor/rules/story-wrapup.mdc, ` +
                        `then idle this agent in .devops-status.json. ${deskHint}` });
                return;
            }

            json(res, {});
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agent/session ───────────────────────────────────────────────────
    // Returns current session info for an agent using the loop driver.
    // Dashboard can poll this alongside /api/status to surface session identity
    // and whether conversation context is being reused across phases.
    use('/api/agent/session', async (req, res) => {
        cors(res, 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const agentId = url.searchParams.get('agentId');
            if (!agentId) { json(res, { error: 'agentId required' }, 400); return; }

            const sessionId = getActiveSessionId(agentId);
            if (!sessionId) {
                json(res, { agentId, sessionId: null, active: false });
                return;
            }

            let sessionInfo = null;
            try {
                const row = dbGetSession(sessionId);
                if (row) {
                    const messageCount = (() => {
                        try { return (JSON.parse(row.messages_json) as unknown[]).length; } catch { return 0; }
                    })();
                    sessionInfo = {
                        id: row.id,
                        agentId: row.agent_id,
                        storyNumber: row.story_number,
                        phase: row.phase,
                        model: row.model,
                        status: row.status,
                        startedAt: row.started_at,
                        updatedAt: row.updated_at,
                        messageCount };
                }
            } catch { /* non-critical */ }

            json(res, { agentId, sessionId, active: isRunnerActive(agentId), session: sessionInfo });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── Autonomous mode: auto-resume when loop agent stops mid-phase ─────────
    registryEvents.on('agent-stopped', ({ agentId, phase, frameworkDir: stoppedDir }: { agentId: string; phase: string; frameworkDir: string }) => {
        if (stoppedDir !== rootDir) return;
        try {
            const cfg = parseJsonUtf8File(configFile) as Record<string, unknown>;
            if (getSchedulerWorkflowMode(cfg) !== 'autonomous') return;
        } catch { return; }
        setTimeout(() => {
            if (isRunnerActive(agentId)) return;
            const statusFile = resolve(rootDir, `.${agentId}-status.json`);
            let storyNum = '';
            try {
                const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                storyNum = String(s.storyNumber ?? '').trim();
                // Clear handoffDispatched so spawnAgent guard doesn't block the resume
                if (s.handoffDispatched) {
                    s.handoffDispatched = false;
                    writeFileSync(statusFile, JSON.stringify(s, null, 2));
                }
            } catch { /* proceed with empty storyNum */ }

            // Don't auto-resume in waiting phases — agent should pause for external input.
            const WAITING_PHASES = new Set(['watching-reviews']);
            if (WAITING_PHASES.has(phase)) {
                return;
            }

            // Step 3 coordination — auto-resume honors the shared desk flags the cap decisions
            // write, so this path can't bypass them (the bug: 15 spawns / 0 cloud / 9 rounds
            // because the review-complete cap was on a different spawn path than this one):
            //  • reworkStuck → the loop was paused for a human; do NOT re-spawn from here either.
            //  • escalatedModel → a prior cap escalated this desk to the cloud brain; keep using
            //    cloud on every re-spawn (not just the handler's one-shot, which this path used
            //    to immediately supersede with a local re-spawn).
            if (isReworkStuck(rootDir, agentId)) {
                console.warn(`[auto-resume] ${agentId} is reworkStuck (paused for human) — not re-spawning`);
                return;
            }
            const stickyModel = escalatedRespawnModel(rootDir, agentId);

            // Validating-loop escalation (dev side): the local 14B can grind
            // generating-code↔validating forever — the per-phase cap below never trips because
            // the bounce alternates phases. Count the story's dev-loop phase entries; past a
            // threshold escalate the dev to the cloud brain for one attempt, then pause for a
            // human. The reviewer-rework loop is capped separately (review-complete handler).
            const DEV_LOOP_PHASES = new Set(['analyzing', 'generating-code', 'validating']);
            const IMPLEMENTATION_AGENTS = new Set(['frontend', 'backend', 'qa', 'ux']);
            let devLoopModel: string | undefined;
            if (IMPLEMENTATION_AGENTS.has(agentId) && DEV_LOOP_PHASES.has(phase) && storyNum) {
                try {
                    const workflow = dbGetWorkflowItemByStory(storyNum, agentId);
                    if (workflow) {
                        // Count dev-loop starts for the CURRENT assignment only. Workflow items
                        // are reused when a story is re-assigned, so an old run's thrash stays in
                        // phase_events; counting all-time would pre-emptively pause a fresh run
                        // (e.g. LOCAL-B-0063 re-assigned with 9 banked starts paused before its
                        // first validation). Reset the count at the latest assignment event.
                        const phaseEvents = dbGetPhaseEvents(workflow.id);
                        const lastAssignIdx = phaseEvents.map(e => e.event_type).lastIndexOf('assigned');
                        const devLoopStarts = phaseEvents.slice(lastAssignIdx + 1)
                            .filter(e => e.event_type === 'phase-started' && DEV_LOOP_PHASES.has(e.phase)).length;
                        // Phase 2: decay effective strength as the run struggles → tighten rails
                        // mid-run. A strong agent that starts bouncing gets demoted (mid at 3,
                        // weak at 6), switching code-quality rails on. Monotonic within a run, so
                        // rails only tighten. Rewrite the desk's railFlags when the set changes.
                        try {
                            const sd = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                            const base = asStrength(sd.agentStrength) ?? 'weak';
                            const eff = decayStrength(base, devLoopStarts);
                            const newFlags = computeRailFlags(eff);
                            const curLen = Array.isArray(sd.railFlags) ? (sd.railFlags as unknown[]).length : -1;
                            if (newFlags.length !== curLen) {
                                sd.railFlags = newFlags;
                                sd.effectiveStrength = eff;
                                if (!Array.isArray(sd.events)) sd.events = [];
                                (sd.events as Array<{ timestamp: string; type: string; message: string }>).push({
                                    timestamp: new Date().toISOString(), type: 'info',
                                    message: `Agent strength ${base}→${eff} after ${devLoopStarts} dev-loop attempt(s); rails: [${newFlags.join(', ')}]`,
                                });
                                writeFileSync(statusFile, JSON.stringify(sd, null, 2));
                            }
                        } catch { /* non-fatal — decay is best-effort */ }
                        const action = devLoopAction(devLoopStarts);
                        if (action === 'pause-human') {
                            markDevLoopStuck(rootDir, agentId, storyNum, devLoopStarts);
                            void notify(rootDir, { title: `🚧 ${storyNum} stuck in validation`, body: `**${agentId}** can't pass validation after ${devLoopStarts} dev-loop attempts (incl. a cloud-brain attempt). Paused for human review.`, color: 'b91c1c' });
                            console.warn(`[validating-loop] ${agentId} on ${storyNum}: ${devLoopStarts} dev-loop starts — pausing for human`);
                            return;
                        }
                        if (action === 'escalate-cloud') {
                            devLoopModel = 'cloud';
                            console.warn(`[validating-loop] ${agentId} on ${storyNum}: ${devLoopStarts} dev-loop starts — escalating to cloud brain`);
                        }
                    }
                } catch { /* proceed with local */ }
            }

            // Prevent infinite loops: stop auto-resuming after 3 attempts in the same phase.
            // (Bypassed when escalating to cloud — that's the deliberate "one stronger attempt".)
            const MAX_AUTO_RESUMES = 3;
            let resumeCount = 0;
            if (storyNum) {
                try {
                    const workflow = dbGetWorkflowItemByStory(storyNum, agentId);
                    if (workflow) {
                        // Count phase-starts for the CURRENT assignment only. Workflow items are
                        // reused on re-assignment, so an old run's phase-starts stay in phase_events;
                        // counting all-time would trip the cap on entry and refuse to spawn the
                        // worker at all (e.g. LOCAL-B-0063 had 5 banked generating-code starts from
                        // a prior run, so the new run never launched). Mirrors the dev-loop fix.
                        const events = dbGetPhaseEvents(workflow.id);
                        const since = events.map(e => e.event_type).lastIndexOf('assigned') + 1;
                        resumeCount = events.slice(since)
                            .filter(e => e.phase === phase && e.event_type === 'phase-started').length;
                    }
                } catch { /* proceed */ }
            }
            // Fallback: in-memory counter for agents without a matching workflow item.
            if (resumeCount === 0) {
                const key = `${agentId}::${phase}`;
                resumeCount = (memoryResumeCounts.get(key) ?? 0) + 1;
                memoryResumeCounts.set(key, resumeCount);
                // GC stale entries after 10 minutes
                setTimeout(() => memoryResumeCounts.delete(key), 600_000);
            }
            // Cloud if EITHER the dev-loop cap escalated this run, or a prior cap stuck the
            // 'cloud' flag on the desk (sticky across re-spawns).
            const respawnModel = devLoopModel ?? stickyModel;
            if (!respawnModel && resumeCount >= MAX_AUTO_RESUMES) {
                console.warn(`[auto-resume] ${agentId} hit max auto-resumes (${MAX_AUTO_RESUMES}) in '${phase}' — stopping`);
                return;
            }

            const prompt = buildContinuePrompt(agentId, phase, storyNum, rootDir, configFile, '', '');
            try {
                spawnAgent(agentId, prompt, rootDir, respawnModel ?? getAgentModel(agentId, rootDir));
                console.log(`[auto-resume] ${agentId} re-spawned after stopping in '${phase}'${respawnModel ? ' (cloud brain)' : ''}`);
            } catch (e) { console.error(`[auto-resume] failed to resume ${agentId}:`, e); }
        }, 2_000);
    });
}

function buildContinuePrompt(
    agentId: string,
    phase: string,
    storyNum: string,
    rootDir: string,
    configFile: string,
    scopeSuffix: string,
    phaseHintClause: string,
): string {
    // Try the structured phase contract prompt first (has phase-specific instructions)
    try {
        if (storyNum) {
            const workflow = dbGetWorkflowItemByStory(storyNum, agentId);
            if (workflow) {
                const activeProfile = getActiveProject(configFile);
                const hasTargetCodebase = !!activeProfile?.workspacePath && activeProfile.workspacePath !== rootDir;
                const plan = startPhaseRun({
                    workflowItemId: workflow.id,
                    serverBaseUrl: 'http://localhost:3001',
                    statusFile: hasTargetCodebase
                        ? pathResolve(rootDir, `.${agentId}-status.json`)
                        : `.${agentId}-status.json`,
                    skillFile: null,
                    targetCodebase: activeProfile?.workspacePath ?? null,
                });
                if (plan.ok && plan.value) return plan.value.prompt;
            }
        }
    } catch { /* fall through to generic */ }

    return (
        buildContextPreamble(rootDir) +
        `Continue as ${agentId}. Read .${agentId}-status.json (currently in phase '${phase}'${storyNum ? `, story ${storyNum}` : ''}) ` +
        `and skills/${skillSubdirForAgentId(agentId)}/SKILL.md. Execute the next phase.${scopeSuffix}${phaseHintClause}`
    );
}
