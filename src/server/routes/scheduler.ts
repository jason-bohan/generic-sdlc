import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getExecMode } from '../modes';
import { getSchedulerWorkflowMode, resolveAgentAssignmentPhase } from '../schedulerMode';
import { isMockExternalMode } from '../external-mode';
import { defaultTokenState } from '../tokens';
import { getActiveProject, getActiveProjectName, getProjectProfile } from '../project-config';
import { spawnAgent } from '../spawn-agent';
import { isGlobalStepMode } from '../stepMode';
import { startWorkflow, startPhaseRun, resolveStoryAgent } from '../orchestrator';
import { notify, resolveProjectTracker } from '../providers';
import { skillSubdirForAgentId } from '../../shared/agentSkillDirs';
import { resolveAgentDisplayName } from '../agent-display-names';
import { dbGetWorkflowItemByStory } from '../db';
import { strengthForModel, computeRailFlags } from '../railFlags';
import { readBody, json } from '../router';
import { buildContextPreamble } from '../contextLoader';
import { taskIdentityKey, dedupeTasksPreserveOrder, type RawTask, asSdlcAgentId } from '../status-normalize';
import { getExternalMode } from '../external-mode';
import {
    getSchedulerConfig,
    getAgentModel,
    recordWorkflowMilestone,
    tryRecordWorkflowArtifact,
    v1Fetch,
    v1Post } from '../route-shared';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';
import { isLocalStoryNumber, createLocalTask, loadLocalTasksForStory, updateLocalStoryStatus } from '../local-planning';
import { cleanupStoryWorktrees, resolveWorktreeRepoRoots } from '../worktree-cleanup';

const AGENT_TASK_CATEGORY: Record<string, string> = {
    frontend: 'TaskCategory:111',
    backend: 'TaskCategory:112',
    qa: 'TaskCategory:113',
    devops: 'TaskCategory:118781',
    ux: 'TaskCategory:239198' };
const AGENT_CATEGORY_NAME: Record<string, string> = {
    frontend: 'Frontend',
    backend: 'Api',
    qa: 'QA',
    devops: 'DevOps',
    ux: 'UX' };

async function loadPlanningTasksForStory(rootDir: string, configFile: string, storyNumber: string): Promise<RawTask[]> {
    if (isLocalStoryNumber(storyNumber)) return loadLocalTasksForStory(rootDir, storyNumber);
    try {
        const tracker = await resolveProjectTracker(rootDir, configFile);
        return await tracker.getTasksForStory(storyNumber);
    } catch {
        return [];
    }
}

function mergeInheritedTasks(localTasks: RawTask[], inheritedTasks: RawTask[]): RawTask[] {
    const localByKey = new Map<string, RawTask>();
    for (const task of localTasks) {
        const key = taskIdentityKey(task);
        if (key) localByKey.set(key, task);
    }
    const localByName = new Map<string, RawTask>();
    for (const task of localTasks) {
        const name = String(task.name ?? '').trim().toLowerCase();
        if (name && !localByName.has(name)) localByName.set(name, task);
    }
    const merged: RawTask[] = [];
    const consumedLocalNames = new Set<string>();
    for (const inherited of inheritedTasks) {
        const key = taskIdentityKey(inherited);
        let local = key ? localByKey.get(key) : undefined;
        if (!local) {
            const name = String(inherited.name ?? '').trim().toLowerCase();
            if (name && localByName.has(name)) {
                local = localByName.get(name);
                consumedLocalNames.add(name);
            }
        }
        if (local) {
            merged.push({
                ...local,
                ...inherited,
                status: local.status === 'completed' || local.status === 'failed' ? local.status : inherited.status,
            });
            const localKey = taskIdentityKey(local);
            if (localKey) localByKey.delete(localKey);
        } else {
            merged.push(inherited);
        }
    }
    for (const task of localTasks) {
        const key = taskIdentityKey(task);
        const name = String(task.name ?? '').trim().toLowerCase();
        if (consumedLocalNames.has(name)) continue;
        if (!key || localByKey.has(key)) merged.push(task);
    }
    return dedupeTasksPreserveOrder(merged);
}

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/scheduler/create-task ───────────────────────────────────────────
    use('/api/scheduler/create-task', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId, storyNumber, name, estimate, category, priority } = JSON.parse(body);
            if (!agentId || !storyNumber || !name) { json(res, { error: 'agentId, storyNumber, and name required' }, 400); return; }

            // ── Local story fast path (no planning credentials needed) ──────────
            if (isLocalStoryNumber(storyNumber)) {
                const localCategoryName = typeof category === 'string' && !category.startsWith('TaskCategory:') ? category : AGENT_CATEGORY_NAME[agentId] ?? null;
                const localStatusFile = resolve(rootDir, `.${agentId}-status.json`);
                const localNormName = String(name).trim().toLowerCase();
                const localNormCat = String(localCategoryName ?? '').trim().toLowerCase();
                if (existsSync(localStatusFile)) {
                    const loaded = parseJsonUtf8File(localStatusFile) as Record<string, unknown>;
                    const existing = Array.isArray(loaded.tasks) ? loaded.tasks as RawTask[] : [];
                    if (loaded.storyNumber === storyNumber) {
                        const dupIdx = existing.findIndex((t: RawTask) => {
                            const tName = String(t.name ?? '').trim().toLowerCase();
                            const tCat = String(t.category ?? '').trim().toLowerCase();
                            if (tName !== localNormName) return false;
                            return tCat === localNormCat || !tCat;
                        });
                        if (dupIdx >= 0) {
                            const reconciliation = loaded.taskReconciliation as { status?: string } | undefined;
                            if (reconciliation?.status !== 'reuse-confirmed') {
                                const mode = getSchedulerWorkflowMode(getSchedulerConfig(rootDir));
                                if (mode === 'autonomous') {
                                    loaded.taskReconciliation = { ...(loaded.taskReconciliation as Record<string, unknown> || {}), status: 'reuse-confirmed', resolvedAt: new Date().toISOString() };
                                    writeFileSync(localStatusFile, JSON.stringify(loaded, null, 2));
                                } else {
                                    const matchingTasks = existing.map((t: RawTask) => ({ id: String(t.id ?? t.number ?? ''), name: String(t.name ?? ''), status: String(t.status ?? 'pending'), category: t.category, hours: t.hours, priority: (t as RawTask & { priority?: unknown }).priority })).filter(t => t.id || t.name);
                                    loaded.currentPhase = 'analyzing'; loaded.handoffDispatched = false;
                                    loaded.taskReconciliation = { status: 'pending', storyNumber, reason: `Task "${name}" already exists for story ${storyNumber}.`, detectedAt: new Date().toISOString(), matchingTaskIds: matchingTasks.map(t => t.id).filter(Boolean), matchingTasks };
                                    const evs = Array.isArray(loaded.events) ? loaded.events as Array<{ timestamp: string; type: string; message: string }> : [];
                                    evs.push({ timestamp: new Date().toISOString(), type: 'warning', message: `Existing tasks detected for story ${storyNumber}. Waiting for reuse or recreate decision.` });
                                    loaded.events = evs;
                                    writeFileSync(localStatusFile, JSON.stringify(loaded, null, 2));
                                    json(res, { ok: false, reconciliationRequired: true, existingTask: matchingTasks[dupIdx], matchingTasks }, 409);
                                    return;
                                }
                            }
                            const prev = existing[dupIdx];
                            const reusedNumber = String(prev.number ?? prev.id ?? '');
                            existing[dupIdx] = { ...prev, id: prev.id ?? reusedNumber, number: prev.number ?? reusedNumber, name, hours: estimate ?? prev.hours ?? 0, category: localCategoryName ?? prev.category, ...(priority !== undefined ? { priority } : {}) };
                            loaded.tasks = dedupeTasksPreserveOrder(existing);
                            writeFileSync(localStatusFile, JSON.stringify(loaded, null, 2));
                            json(res, { ok: true, number: reusedNumber, name, deduplicated: true });
                            return;
                        }
                    }
                }
                const localTask = createLocalTask(rootDir, { storyNumber, name, estimate: estimate ?? 0, category: localCategoryName ?? '', priority, owners: [], status: 'None' });
                if (existsSync(localStatusFile)) {
                    const sr = parseJsonUtf8File(localStatusFile) as Record<string, unknown>;
                    sr.tasks = sr.tasks || [];
                    if (sr.storyNumber && sr.storyNumber !== storyNumber) sr.tasks = [];
                    const entry: RawTask = { id: localTask.number, number: localTask.number, name, status: 'pending', agilityStatus: 'None', hours: estimate ?? 0, category: localCategoryName ?? undefined, source: 'local', inherited: false, ...(priority !== undefined ? { priority } : {}) };
                    (sr.tasks as RawTask[]).push(entry);
                    sr.tasks = dedupeTasksPreserveOrder(sr.tasks as RawTask[]);
                    writeFileSync(localStatusFile, JSON.stringify(sr, null, 2));
                }
                json(res, { ok: true, number: localTask.number, name });
                return;
            }
            // ─────────────────────────────────────────────────────────────────────

            // Mock mode or non-planning-adapter story (e.g. GitHub issues): write task directly to status file
            if (isMockExternalMode(configFile)) {
                const mockCategoryName = typeof category === 'string' && !category.startsWith('TaskCategory:') ? category : AGENT_CATEGORY_NAME[agentId] ?? null;
                const mockStatusFile = resolve(rootDir, `.${agentId}-status.json`);
                const mockNormName = String(name).trim().toLowerCase();
                const mockNormCat = String(mockCategoryName ?? '').trim().toLowerCase();
                if (existsSync(mockStatusFile)) {
                    const loaded = parseJsonUtf8File(mockStatusFile) as Record<string, unknown>;
                    const existing = Array.isArray(loaded.tasks) ? loaded.tasks as RawTask[] : [];
                    if (loaded.storyNumber === storyNumber) {
                        const dupIdx = existing.findIndex((t: RawTask) => {
                            const tName = String(t.name ?? '').trim().toLowerCase();
                            const tCat = String(t.category ?? '').trim().toLowerCase();
                            if (tName !== mockNormName) return false;
                            return tCat === mockNormCat || !tCat;
                        });
                        if (dupIdx >= 0) {
                            const reconciliation = loaded.taskReconciliation as { status?: string } | undefined;
                            if (reconciliation?.status !== 'reuse-confirmed') {
                                const mode = getSchedulerWorkflowMode(getSchedulerConfig(rootDir));
                                if (mode === 'autonomous') {
                                    loaded.taskReconciliation = { ...(loaded.taskReconciliation as Record<string, unknown> || {}), status: 'reuse-confirmed', resolvedAt: new Date().toISOString() };
                                    writeFileSync(mockStatusFile, JSON.stringify(loaded, null, 2));
                                } else {
                                    const matchingTasks = existing.map((t: RawTask) => ({ id: String(t.id ?? t.number ?? ''), name: String(t.name ?? ''), status: String(t.status ?? 'pending'), category: t.category, hours: t.hours, priority: (t as RawTask & { priority?: unknown }).priority })).filter(t => t.id || t.name);
                                    loaded.currentPhase = 'analyzing'; loaded.handoffDispatched = false;
                                    loaded.taskReconciliation = { status: 'pending', storyNumber, reason: `Task "${name}" already exists for story ${storyNumber}.`, detectedAt: new Date().toISOString(), matchingTaskIds: matchingTasks.map(t => t.id).filter(Boolean), matchingTasks };
                                    const evs = Array.isArray(loaded.events) ? loaded.events as Array<{ timestamp: string; type: string; message: string }> : [];
                                    evs.push({ timestamp: new Date().toISOString(), type: 'warning', message: `Existing tasks detected for story ${storyNumber}. Waiting for reuse or recreate decision.` });
                                    loaded.events = evs;
                                    writeFileSync(mockStatusFile, JSON.stringify(loaded, null, 2));
                                    json(res, { ok: false, reconciliationRequired: true, existingTask: matchingTasks[dupIdx], matchingTasks }, 409);
                                    return;
                                }
                            }
                            const prev = existing[dupIdx];
                            const reusedNumber = String(prev.number ?? prev.id ?? '');
                            existing[dupIdx] = { ...prev, id: prev.id ?? reusedNumber, number: prev.number ?? reusedNumber, name, hours: estimate ?? prev.hours ?? 0, category: mockCategoryName ?? prev.category, ...(priority !== undefined ? { priority } : {}) };
                            loaded.tasks = dedupeTasksPreserveOrder(existing);
                            writeFileSync(mockStatusFile, JSON.stringify(loaded, null, 2));
                            json(res, { ok: true, number: reusedNumber, name, deduplicated: true });
                            return;
                        }
                    }
                }
                const taskNumber = `MOCK-TK-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                if (existsSync(mockStatusFile)) {
                    const sr = parseJsonUtf8File(mockStatusFile) as Record<string, unknown>;
                    if (sr.storyNumber && sr.storyNumber !== storyNumber) sr.tasks = [];
                    sr.tasks = sr.tasks || [];
                    const entry: RawTask = { id: taskNumber, number: taskNumber, name, status: 'pending', agilityStatus: 'None', hours: estimate ?? 0, category: mockCategoryName ?? undefined, source: 'local', inherited: false, ...(priority !== undefined ? { priority } : {}) };
                    (sr.tasks as RawTask[]).push(entry);
                    sr.tasks = dedupeTasksPreserveOrder(sr.tasks as RawTask[]);
                    writeFileSync(mockStatusFile, JSON.stringify(sr, null, 2));
                }
                try {
                    tryRecordWorkflowArtifact({
                        storyNumber,
                        agentId,
                        artifactType: 'task',
                        artifactKey: String(taskNumber),
                        payload: {
                            id: taskNumber,
                            number: taskNumber,
                            name,
                            status: 'pending',
                            hours: estimate ?? 0,
                            agentId,
                            category: mockCategoryName ?? undefined,
                            sourceRoute: '/api/scheduler/create-task',
                        },
                    });
                } catch (workflowErr) {
                    console.warn('[scheduler/create-task] mock workflow artifact failed:', workflowErr);
                }
                json(res, { ok: true, number: taskNumber, name });
                return;
            }

            // No planning credentials, or GitHub provider — generate a local task ID so GitHub-issue-based stories can proceed
            if ((process.env.PM_PROVIDER ?? '').toLowerCase() === 'github' || (!process.env.V1_BASE_URL && !process.env.AGILITY_BASE_URL)) {
                const noCredCategoryName = typeof category === 'string' && !category.startsWith('TaskCategory:') ? category : AGENT_CATEGORY_NAME[agentId] ?? null;
                const noCredStatusFile = resolve(rootDir, `.${agentId}-status.json`);
                const taskNumber = `GH-TK-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                if (existsSync(noCredStatusFile)) {
                    const sr = parseJsonUtf8File(noCredStatusFile) as Record<string, unknown>;
                    if (sr.storyNumber && sr.storyNumber !== storyNumber) sr.tasks = [];
                    sr.tasks = sr.tasks || [];
                    const entry: RawTask = { id: taskNumber, number: taskNumber, name, status: 'pending', agilityStatus: 'None', hours: estimate ?? 0, category: noCredCategoryName ?? undefined, source: 'local', inherited: false, ...(priority !== undefined ? { priority } : {}) };
                    (sr.tasks as RawTask[]).push(entry);
                    sr.tasks = dedupeTasksPreserveOrder(sr.tasks as RawTask[]);
                    writeFileSync(noCredStatusFile, JSON.stringify(sr, null, 2));
                }
                json(res, { ok: true, number: taskNumber, name });
                return;
            }

            const parentData = await v1Fetch(rootDir, '/Story', { sel: 'Number', where: `Number='${storyNumber}'` });
            const parentAsset = (parentData.Assets || [])[0];
            if (!parentAsset) { json(res, { error: `Story ${storyNumber} not found` }, 404); return; }
            const categoryOid = typeof category === 'string' && category.startsWith('TaskCategory:') ? category : AGENT_TASK_CATEGORY[agentId];
            const categoryName = typeof category === 'string' && !category.startsWith('TaskCategory:') ? category : AGENT_CATEGORY_NAME[agentId] ?? null;
            const statusFile = resolve(rootDir, `.${agentId}-status.json`);
            const normalizedName = String(name).trim().toLowerCase();
            const normalizedCategory = String(categoryName ?? '').trim().toLowerCase();
            if (existsSync(statusFile)) {
                const loadedStatus = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                const existingTasks = Array.isArray(loadedStatus.tasks) ? loadedStatus.tasks as RawTask[] : [];
                if (loadedStatus.storyNumber === storyNumber) {
                    const existingTaskIndex = existingTasks.findIndex((t: RawTask) => {
                        const tName = String(t.name ?? '').trim().toLowerCase();
                        const tCat = String(t.category ?? '').trim().toLowerCase();
                        if (tName !== normalizedName) return false;
                        if (tCat === normalizedCategory) return true;
                        return !tCat;
                    });
                    if (existingTaskIndex >= 0) {
                        const reconciliation = loadedStatus.taskReconciliation as { status?: string } | undefined;
                        if (reconciliation?.status !== 'reuse-confirmed') {
                            // Autonomous mode: auto-reuse the existing task instead of blocking.
                            const mode = getSchedulerWorkflowMode(getSchedulerConfig(rootDir));
                            if (mode === 'autonomous') {
                                loadedStatus.taskReconciliation = {
                                    ...(loadedStatus.taskReconciliation as Record<string, unknown> || {}),
                                    status: 'reuse-confirmed',
                                    resolvedAt: new Date().toISOString(),
                                };
                                writeFileSync(statusFile, JSON.stringify(loadedStatus, null, 2));
                                // Fall through to reuse logic below.
                            } else {
                                const matchingTasks = existingTasks.map((t: RawTask) => ({
                                    id: String(t.id ?? t.number ?? ''),
                                    name: String(t.name ?? ''),
                                    status: String(t.status ?? 'pending'),
                                    category: t.category,
                                    hours: t.hours,
                                    priority: (t as RawTask & { priority?: unknown }).priority,
                                })).filter(t => t.id || t.name);
                                loadedStatus.currentPhase = 'analyzing';
                                loadedStatus.handoffDispatched = false;
                                loadedStatus.taskReconciliation = {
                                    status: 'pending',
                                    storyNumber,
                                    reason: `Task "${name}" already exists for story ${storyNumber}.`,
                                    detectedAt: new Date().toISOString(),
                                    matchingTaskIds: matchingTasks.map(t => t.id).filter(Boolean),
                                    matchingTasks,
                                };
                                const events = Array.isArray(loadedStatus.events)
                                    ? loadedStatus.events as Array<{ timestamp: string; type: string; message: string }>
                                    : [];
                                events.push({
                                    timestamp: new Date().toISOString(),
                                    type: 'warning',
                                    message: `Existing tasks detected for story ${storyNumber}. Waiting for reuse or recreate decision.`,
                                });
                                loadedStatus.events = events;
                                writeFileSync(statusFile, JSON.stringify(loadedStatus, null, 2));
                                json(res, {
                                    ok: false,
                                    reconciliationRequired: true,
                                    existingTask: matchingTasks[existingTaskIndex],
                                    matchingTasks,
                                }, 409);
                                return;
                            }
                        }
                        const prev = existingTasks[existingTaskIndex];
                        const taskNumber = String(prev.number ?? prev.id ?? '');
                        existingTasks[existingTaskIndex] = {
                            ...prev,
                            id: prev.id ?? taskNumber,
                            number: prev.number ?? taskNumber,
                            name,
                            hours: estimate ?? prev.hours ?? 0,
                            category: categoryName ?? prev.category,
                            ...(priority !== undefined ? { priority } : {}),
                        };
                        loadedStatus.tasks = dedupeTasksPreserveOrder(existingTasks);
                        writeFileSync(statusFile, JSON.stringify(loadedStatus, null, 2));
                        json(res, { ok: true, number: taskNumber, name, deduplicated: true });
                        return;
                    }
                }
            }
            const createBody = { Attributes: { Name: { value: name, act: 'set' }, Parent: { value: parentAsset.id, act: 'set' }, ...(estimate ? { DetailEstimate: { value: estimate, act: 'set' } } : {}), ...(categoryOid ? { Category: { value: categoryOid, act: 'set' } } : {}) } };
            const created = await (isMockExternalMode(configFile) ? v1Post(rootDir, '/Task', createBody) : (async () => {
                const baseUrl = process.env.V1_BASE_URL || process.env.AGILITY_BASE_URL;
                const token = process.env.V1_ACCESS_TOKEN || process.env.AGILITY_API_KEY;
                const resp = await fetch(`${baseUrl}/rest-1.v1/Data/Task`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(createBody) });
                if (!resp.ok) throw new Error(`VersionOne API ${resp.status}: ${resp.statusText}`);
                return resp.json();
            })()) as { id?: string; Attributes?: { Number?: { value?: string } } };
            let taskNumber = created.Attributes?.Number?.value;
            if (!taskNumber && created.id) {
                const parts = String(created.id).split(':');
                const instanceKey = parts.length >= 2 ? parts[1] : parts[parts.length - 1];
                if (instanceKey) { try { const refreshed = await v1Fetch(rootDir, `/Task/${instanceKey}`, { sel: 'Number' }); taskNumber = refreshed.Attributes?.Number?.value as string | undefined; } catch { /* fallback */ } }
            }
            if (!taskNumber) taskNumber = created.id ?? 'unknown';
            if (existsSync(statusFile)) {
                const statusRaw = parseJsonUtf8File(statusFile);
                statusRaw.tasks = statusRaw.tasks || [];
                if (statusRaw.storyNumber && statusRaw.storyNumber !== storyNumber) {
                    statusRaw.tasks = [];
                }
                const key = String(taskNumber);
                const nextEntry: RawTask = {
                    id: taskNumber, number: taskNumber, name, status: 'pending', hours: estimate ?? 0, category: categoryName ?? undefined,
                    ...(priority !== undefined ? { priority } : {}) };
                let idx = (statusRaw.tasks as RawTask[]).findIndex((t) => taskIdentityKey(t) === key);
                if (idx < 0) {
                    idx = (statusRaw.tasks as RawTask[]).findIndex((t: RawTask) => {
                        const tName = String(t.name ?? '').trim().toLowerCase();
                        const tCat = String(t.category ?? '').trim().toLowerCase();
                        if (tName !== normalizedName) return false;
                        if (tCat === normalizedCategory) return true;
                        return !tCat;
                    });
                }
                if (idx >= 0) {
                    const prev = (statusRaw.tasks as RawTask[])[idx];
                    (statusRaw.tasks as RawTask[])[idx] = {
                        ...prev,
                        ...nextEntry,
                        status: (prev.status && prev.status !== 'pending') ? prev.status : nextEntry.status };
                } else {
                    (statusRaw.tasks as RawTask[]).push(nextEntry);
                }
                statusRaw.tasks = dedupeTasksPreserveOrder(statusRaw.tasks as RawTask[]);
                writeFileSync(statusFile, JSON.stringify(statusRaw, null, 2));
            }
            try {
                tryRecordWorkflowArtifact({
                    storyNumber,
                    agentId,
                    artifactType: 'task',
                    artifactKey: String(taskNumber),
                    payload: {
                        id: taskNumber,
                        number: taskNumber,
                        name,
                        status: 'pending',
                        hours: estimate ?? 0,
                        agentId,
                        category: categoryName ?? undefined,
                        sourceRoute: '/api/scheduler/create-task' } });
            } catch (workflowErr) {
                console.warn('[scheduler/create-task] workflow artifact failed:', workflowErr);
            }
            json(res, { ok: true, number: taskNumber, name });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/scheduler/assign ────────────────────────────────────────────────
    use('/api/scheduler/assign', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId: requestedAgentId, storyNumber: rawStoryNumber, storyName: rawStoryName, storyDescription: rawStoryDesc, frontend, backend, qa, teamId, environment } = JSON.parse(body);
            const storyNumber = String(rawStoryNumber).trim();
            if (!requestedAgentId || !storyNumber) { json(res, { error: 'agentId and storyNumber required' }, 400); return; }
            // Clean up any stale worktree branches from previous runs for this story.
            for (const repoRoot of resolveWorktreeRepoRoots(rootDir, configFile)) {
                try { cleanupStoryWorktrees(repoRoot, storyNumber); } catch { /* non-fatal */ }
            }
            // Auto-populate story name/description from local planning state if not provided.
            let storyName = rawStoryName ? String(rawStoryName).trim() : null;
            let storyDescription = rawStoryDesc ? String(rawStoryDesc).trim() : null;
            let preferredAgent: string | null = null;
            if (isLocalStoryNumber(storyNumber)) {
                try {
                    const planningState = parseJsonUtf8File(resolve(rootDir, '.sdlc-framework', 'local-planning', 'state.json')) as { stories?: Array<{ number: string; name?: string; description?: string; preferredAgent?: string }> };
                    const match = planningState.stories?.find((s: { number: string }) => s.number === storyNumber);
                    if (match) {
                        if (!storyName) storyName = match.name?.replace(/<[^>]*>/g, '').trim() || null;
                        if (!storyDescription) storyDescription = match.description?.replace(/<[^>]*>/g, '').trim() || null;
                        if (!preferredAgent) preferredAgent = match.preferredAgent || null;
                    }
                } catch { /* non-fatal — proceed with null metadata */ }
            }
            // The orchestrator owns routing: honour a valid specialist if the caller
            // named one, otherwise classify the story (heuristic → LLM triage) so an
            // invalid/generic agentId (e.g. "developer") routes to the right specialist
            // instead of silently defaulting to frontend.
            const agentId = asSdlcAgentId(String(requestedAgentId).trim()) ?? await resolveStoryAgent(
                { number: storyNumber, name: storyName ?? null, description: storyDescription ?? null, frontend: frontend ?? null, backend: backend ?? null, qa: qa ?? null, preferredAgent },
                { configPath: configFile },
            );
            const config = getSchedulerConfig(rootDir);
            const agentConfig = config.scheduler?.agents?.[agentId];
            const { phase, startedAt } = resolveAgentAssignmentPhase(getSchedulerWorkflowMode(config), agentConfig?.autoStart ?? false);
            const immediate = phase === 'reading-story';
            const statusFile = resolve(rootDir, `.${agentId}-status.json`);
            // Strength-flagged rails: the worker's configured strength decides which rails
            // are live for this run (a strong agent runs unburdened; a weak one is fully
            // railed). Computed once here and stored on the desk so every rail reads it.
            const workerModel = getAgentModel(agentId, rootDir);
            const agentStrength = strengthForModel(workerModel, configFile);
            const railFlags = computeRailFlags(agentStrength);
            const status = {
                projectKey: getActiveProjectName(configFile), storyNumber, storyName: storyName || null, storyDescription: storyDescription ?? null,
                teamId: teamId || null, environment: environment || null, currentPhase: phase, currentTask: null, startedAt,
                executionMode: getExecMode(configFile), tokens: defaultTokenState(), tasks: [] as RawTask[], prs: [],
                agentStrength, railFlags,
                cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
                events: [
                    { timestamp: new Date().toISOString(), type: immediate ? 'success' : 'info', message: immediate ? `Story ${storyNumber} assigned. Starting workflow.` : `Story ${storyNumber} assigned. Awaiting approval to start.` },
                    { timestamp: new Date().toISOString(), type: 'info', message: `Rails configured: agent strength=${agentStrength} (${workerModel}) → [${railFlags.join(', ')}]` },
                ] };
            try {
                const inheritedTasks = await loadPlanningTasksForStory(rootDir, configFile, storyNumber);
                if (inheritedTasks.length > 0) {
                    status.tasks = inheritedTasks;
                    status.events.push({
                        timestamp: new Date().toISOString(),
                        type: 'info',
                        message: `Inherited ${inheritedTasks.length} existing planning task(s) for story ${storyNumber}.`,
                    });
                }
            } catch (taskErr) {
                status.events.push({
                    timestamp: new Date().toISOString(),
                    type: 'warning',
                    message: `Could not inherit existing planning tasks for story ${storyNumber}: ${taskErr instanceof Error ? taskErr.message : String(taskErr)}`,
                });
            }
            writeFileSync(statusFile, JSON.stringify(status, null, 2));
            if (isLocalStoryNumber(storyNumber)) {
                try { updateLocalStoryStatus(rootDir, storyNumber, 'In Development'); } catch { /* non-fatal */ }
            }
            let workflow: unknown = null;
            try {
                const result = startWorkflow({
                    externalMode: getExternalMode(configFile),
                    assignedAgentId: asSdlcAgentId(agentId),
                    story: {
                        number: storyNumber,
                        name: storyName || null,
                        description: storyDescription ?? null,
                        frontend: frontend ?? null,
                        backend: backend ?? null,
                        qa: qa ?? null,
                        projectKey: status.projectKey,
                        affectedRepo: getActiveProjectName(configFile) } }).value ?? null;
                workflow = result;
                if (result && typeof result === 'object' && 'item' in result) {
                    const item = (result as { item: { id: number } }).item;
                    (status as Record<string, unknown>).workflowItemId = item.id;
                    writeFileSync(statusFile, JSON.stringify(status, null, 2));
                }
            } catch (workflowErr) {
                console.warn('[scheduler] workflow state mirror failed:', workflowErr);
            }
            void notify(rootDir, { title: `📋 Story Assigned: ${storyNumber}`, body: `**${storyName || storyNumber}** assigned to **${resolveAgentDisplayName(agentId, rootDir)}**. ${immediate ? 'Workflow starting.' : 'Awaiting approval.'}`, color: immediate ? '6366f1' : 'f59e0b' });
            let agentSpawned = false;
            let spawnReason: string | undefined;
            if (immediate) {
                const activeProfile = getActiveProject(configFile);
                const hasTargetCodebase = !!activeProfile?.workspacePath && activeProfile.workspacePath !== rootDir;
                let prompt = buildContextPreamble(rootDir) + `You are ${agentId}. Read .${agentId}-status.json (story ${storyNumber}) and skills/${skillSubdirForAgentId(agentId)}/SKILL.md. Begin Phase 1: read the story, plan the work, and create/sign up for planning tasks.`;
                try {
                    const wf = storyNumber ? dbGetWorkflowItemByStory(storyNumber, agentId) : undefined;
                    if (wf) {
                        const phasePlan = startPhaseRun({
                            workflowItemId: wf.id,
                            serverBaseUrl: `http://${req.headers.host || 'localhost:3001'}`,
                            statusFile: hasTargetCodebase ? resolve(rootDir, `.${agentId}-status.json`) : `.${agentId}-status.json`,
                            skillFile: resolve(rootDir, `skills/${skillSubdirForAgentId(agentId)}/SKILL.md`),
                            targetCodebase: activeProfile?.workspacePath ?? null,
                        });
                        if (phasePlan.ok && phasePlan.value) prompt = phasePlan.value.prompt;
                    }
                } catch (e) { console.warn('[assign] contract phase prompt failed:', e); }
                try {
                    const spawnResult = spawnAgent(agentId, prompt, rootDir, getAgentModel(agentId, rootDir));
                    agentSpawned = spawnResult.spawned;
                    if (!agentSpawned) spawnReason = spawnResult.reason;
                } catch (e) { console.error('[assign] spawn failed:', e); }
            }
            json(res, { ok: true, phase: status.currentPhase, workflow, agentSpawned, spawnReason });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/scheduler/approve ───────────────────────────────────────────────
    use('/api/scheduler/approve', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId } = JSON.parse(body);
            const statusFile = resolve(rootDir, `.${agentId}-status.json`);
            if (!existsSync(statusFile)) { json(res, { error: 'No status file found' }, 404); return; }
            const status = parseJsonUtf8File(statusFile);
            if (status.currentPhase !== 'pending-approval') { json(res, { error: `Agent is in "${status.currentPhase}", not pending-approval` }, 409); return; }
            status.currentPhase = 'reading-story';
            status.startedAt = new Date().toISOString();
            try {
                const inheritedTasks = await loadPlanningTasksForStory(rootDir, configFile, String(status.storyNumber || ''));
                status.tasks = mergeInheritedTasks(Array.isArray(status.tasks) ? status.tasks as RawTask[] : [], inheritedTasks);
                if (inheritedTasks.length > 0) {
                    status.events.push({
                        timestamp: new Date().toISOString(),
                        type: 'info',
                        message: `Synced ${inheritedTasks.length} existing planning task(s) before starting.`,
                    });
                }
            } catch (taskErr) {
                status.tasks = Array.isArray(status.tasks) ? status.tasks : [];
                status.events.push({
                    timestamp: new Date().toISOString(),
                    type: 'warning',
                    message: `Could not sync existing planning tasks before starting: ${taskErr instanceof Error ? taskErr.message : String(taskErr)}`,
                });
            }
            status.events.push({ timestamp: new Date().toISOString(), type: 'success', message: 'Workflow approved. Starting.' });
            writeFileSync(statusFile, JSON.stringify(status, null, 2));
            const storyNum = status.storyNumber || '';
            const activeProfile = getActiveProject(configFile);
            const targetCodebase = activeProfile?.workspacePath && activeProfile.workspacePath !== rootDir ? ` The target codebase is at ${activeProfile.workspacePath}.` : '';
            let prompt = buildContextPreamble(rootDir) + `You are ${agentId}. Read .${agentId}-status.json (story ${storyNum}) and skills/${skillSubdirForAgentId(agentId)}/SKILL.md. Begin Phase 1: read the story, plan the work, and create/sign up for planning tasks.${targetCodebase}`;
            try {
                const workflow = storyNum ? dbGetWorkflowItemByStory(storyNum, agentId) : undefined;
                if (workflow) {
                    const hasTargetCodebase = !!activeProfile?.workspacePath && activeProfile.workspacePath !== rootDir;
                    const phasePlan = startPhaseRun({
                        workflowItemId: workflow.id,
                        serverBaseUrl: `http://${req.headers.host || 'localhost:3001'}`,
                        statusFile: hasTargetCodebase
                            ? resolve(rootDir, `.${agentId}-status.json`)
                            : `.${agentId}-status.json`,
                        skillFile: null,
                        targetCodebase: activeProfile?.workspacePath ?? null });
                    if (phasePlan.ok && phasePlan.value) prompt = phasePlan.value.prompt;
                }
            } catch (workflowErr) {
                console.warn('[approve] contract phase prompt failed:', workflowErr);
            }
            try {
                recordWorkflowMilestone({
                    storyNumber: storyNum,
                    agentId,
                    phase: 'pre-planning',
                    eventType: 'workflow-approved',
                    outputs: { auditEvent: { route: '/api/scheduler/approve' } },
                    message: `Workflow approved for story ${storyNum}` });
            } catch (workflowErr) { console.warn('[approve] workflow milestone failed:', workflowErr); }
            const agentModel = getAgentModel(agentId, rootDir);
            let agentSpawned = false;
            let spawnReason: string | undefined;
            try {
                const spawnResult = spawnAgent(agentId, prompt, rootDir, agentModel);
                agentSpawned = spawnResult.spawned;
                if (!agentSpawned) spawnReason = spawnResult.reason;
            } catch (e) { console.error('[approve] spawn failed:', e); }
            json(res, { ok: true, agentSpawned, spawnReason, prompt });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
