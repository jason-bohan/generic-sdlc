import { writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { getExecMode, isValidMode, runGooseLocal, createStoryBalanced, createStorySpeed, enrichStoryFields, storyCreationRouteForMode, type ExecMode, type StoryResult } from '../modes';
import { isOllamaAvailable } from '../ollamaManager';
import { readBody, json, cors } from '../router';
import { isMockExternalMode } from '../external-mode';
import {
    createV1ApiAdapter,
    getV1Config,
    mapV1TaskStatus,
    pickStoryAsset,
    storyOidToRestPath,
    v1Fetch,
    type V1Asset,
    V1_HEADERS } from '../route-shared';
import { taskIdentityKey, dedupeTasksPreserveOrder, type RawTask } from '../status-normalize';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';
import {
    createLocalStory,
    deleteLocalStory,
    findLocalStory,
    isLocalStoryNumber,
    loadLocalAgilityState,
    loadLocalTasksForStory,
    reorderLocalStories,
    syncAgentTasksToLocalDB,
    updateLocalStory,
    updateLocalStoryStatus,
    updateLocalTaskStatus,
} from '../local-agility';

const STATUS_FILE_RE = /^\.([a-z][\w-]*)-status\.json$/;

function resetAgentsForStory(rootDir: string, storyNumber: string): string[] {
    const isoNow = new Date().toISOString();
    const idleEvent = [{ timestamp: isoNow, type: 'info', message: `Story ${storyNumber} closed. Reset to idle.` }];
    const tokens = { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } };
    const idleTemplate = {
        storyNumber: null, storyName: null, storyDescription: null,
        currentPhase: 'idle', currentTask: null, startedAt: null,
        tokens, tasks: [] as unknown[], prs: [] as unknown[],
        requests: [] as unknown[], events: idleEvent, handoffDispatched: false,
        cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] as unknown[] },
    };
    const reset: string[] = [];
    for (const entry of readdirSync(rootDir)) {
        const m = STATUS_FILE_RE.exec(entry);
        if (!m) continue;
        const agentId = m[1];
        const filePath = resolve(rootDir, entry);
        try {
            const raw = parseJsonUtf8File(filePath) as Record<string, unknown>;
            if (raw.storyNumber !== storyNumber) continue;
            writeFileSync(filePath, JSON.stringify(idleTemplate, null, 2));
            reset.push(agentId);
            const msgFile = resolve(rootDir, `.${agentId}-messages.json`);
            if (existsSync(msgFile)) writeFileSync(msgFile, '[]', 'utf-8');
        } catch { /* skip unreadable files */ }
    }
    return reset;
}

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    const v1ApiAdapter = createV1ApiAdapter(rootDir, configFile);

    // ── /api/agility/teams ───────────────────────────────────────────────────
    use('/api/agility/teams', async (req, res) => {
        try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            if (url.searchParams.get('source') === 'local') {
                json(res, { teams: loadLocalAgilityState(rootDir).teams, source: 'local' });
                return;
            }
            if ((process.env.PM_PROVIDER ?? '').toLowerCase() === 'github') {
                const { resolveProjectTracker } = await import('../providers/index.js');
                const tracker = await resolveProjectTracker(rootDir, configFile);
                const teams = await tracker.getTeams();
                json(res, { teams, source: 'github' });
                return;
            }
            const data = await v1Fetch(rootDir, '/Team', { sel: 'Name', where: "AssetState='64'", sort: 'Name' });
            json(res, { teams: (data.Assets || []).map((a: V1Asset) => ({ id: a.id, name: a.Attributes?.Name?.value ?? a.id })) });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 502); }
    });

    // ── /api/agility/class-of-service ────────────────────────────────────────
    use('/api/agility/class-of-service', async (req, res) => {
        try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            if (url.searchParams.get('source') === 'local') {
                json(res, { values: loadLocalAgilityState(rootDir).classOfService, source: 'local' });
                return;
            }
            const data = await v1Fetch(rootDir, '/ClassOfService', { sel: 'Name', sort: 'Name' });
            json(res, { values: (data.Assets || []).map((a: V1Asset) => ({ id: a.id, name: a.Attributes?.Name?.value ?? a.id })) });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 502); }
    });

    // ── /api/agility/members ─────────────────────────────────────────────────
    use('/api/agility/members', async (req, res) => {
        try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            if (url.searchParams.get('source') === 'local') {
                json(res, { members: loadLocalAgilityState(rootDir).members, source: 'local' });
                return;
            }
            const data = await v1Fetch(rootDir, '/Member', { sel: 'Name,Nickname,Email', where: "AssetState='64'", sort: 'Name', page: '200,0' });
            json(res, { members: (data.Assets || []).map((a: V1Asset) => ({ id: a.id, name: a.Attributes?.Name?.value ?? a.id, nickname: a.Attributes?.Nickname?.value ?? '', email: a.Attributes?.Email?.value ?? '' })) });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 502); }
    });

    // ── /api/agility/stories ─────────────────────────────────────────────────
    use('/api/agility/stories', async (req, res) => {
        try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const team = url.searchParams.get('team') || '';
            const status = url.searchParams.get('status') || '';
            const text = url.searchParams.get('text') || '';
            const maxResults = url.searchParams.get('maxResults') || '20';
            if (url.searchParams.get('source') === 'local') {
                const limit = Math.max(1, Number(maxResults) || 20);
                let stories = loadLocalAgilityState(rootDir).stories.filter((s) => !s.deleted);
                stories.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
                if (team) stories = stories.filter((story) => story.team === team || story.teamId === team);
                if (status) stories = stories.filter((story) => story.status === status);
                if (text) {
                    const needle = text.toLowerCase();
                    stories = stories.filter((story) => story.name.toLowerCase().includes(needle) || story.number.toLowerCase().includes(needle));
                }
                const items = stories.slice(0, limit).map((story) => ({
                    id: story.id,
                    number: story.number,
                    name: story.name,
                    status: story.status,
                    teamId: story.teamId,
                    team: story.team,
                    estimate: story.estimate,
                    priority: story.priority,
                    sortOrder: story.sortOrder,
                    source: 'local',
                }));
                json(res, { stories: items, total: stories.length, source: 'local' });
                return;
            }
            // GitHub Issues provider — activated via PM_PROVIDER=github
            if ((process.env.PM_PROVIDER ?? '').toLowerCase() === 'github') {
                const { resolveProjectTracker } = await import('../providers/index.js');
                const tracker = await resolveProjectTracker(rootDir, configFile);
                const summaries = await tracker.getStories({ team, status, text, maxResults: Number(maxResults) || 20 });
                const items = summaries.map(s => ({
                    id: s.id, number: s.number, name: s.title,
                    status: s.status, teamId: s.teamId ?? '', team: s.team ?? '',
                    estimate: s.estimate ?? null, priority: s.priority ?? '', source: s.source,
                }));
                json(res, { stories: items, total: items.length, source: 'github' });
                return;
            }

            const where: string[] = [];
            if (team) where.push(`Team.Name='${team}'`);
            if (status) where.push(`Status.Name='${status}'`);
            if (text) where.push(`Name~'${text}'`);
            where.push(`IsClosed='false'`, `Status.Name!='Released'`, `Status.Name!='In Master'`, `Status.Name!='Pending Release'`);
            const data = await v1Fetch(rootDir, '/Story', { sel: 'Number,Name,Status.Name,Team,Team.Name,Estimate,Priority.Name', where: where.join(';'), sort: '-ChangeDate', page: `${maxResults},0` });
            const items = (data.Assets || []).map((a: V1Asset) => ({
                id: a.id, number: a.Attributes?.Number?.value, name: a.Attributes?.Name?.value,
                status: a.Attributes?.['Status.Name']?.value ?? 'None', teamId: a.Attributes?.Team?.value,
                team: a.Attributes?.['Team.Name']?.value ?? '', estimate: a.Attributes?.Estimate?.value, priority: a.Attributes?.['Priority.Name']?.value ?? '' }));
            json(res, { stories: items, total: data.Total ?? items.length });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 502); }
    });

    // ── /api/agility/story ───────────────────────────────────────────────────
    use('/api/agility/story', async (req, res) => {
        const storySel = 'Number,Name,Description,Status.Name,Team,Team.Name,Estimate,Priority.Name,Custom_AcceptanceCriteria,Custom_Frontend,Custom_Backend,Custom_QA,Scope.Name,ClassOfService.Name';
        try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const number = url.searchParams.get('number');
            const oidParam = url.searchParams.get('oid');
            if (req.method === 'PUT' || req.method === 'PATCH') {
                const body = JSON.parse(await readBody(req));
                const storyNumber = String(body.number || number || '');
                if (!storyNumber) { json(res, { error: 'number is required' }, 400); return; }
                if (!isLocalStoryNumber(storyNumber)) { json(res, { error: 'Live Agility story edits are not implemented yet' }, 501); return; }
                const story = updateLocalStory(rootDir, storyNumber, {
                    name: body.name != null ? String(body.name) : undefined,
                    description: body.description != null ? String(body.description) : undefined,
                    status: body.status != null ? String(body.status) : undefined,
                    team: body.team != null ? String(body.team) : undefined,
                    teamId: body.teamId != null ? String(body.teamId) : undefined,
                    estimate: body.estimate !== undefined && body.estimate !== '' ? Number(body.estimate) : body.estimate === '' ? null : undefined,
                    priority: body.priority != null ? String(body.priority) : undefined,
                    scope: body.scope != null ? String(body.scope) : undefined,
                    classOfService: body.classOfService != null ? String(body.classOfService) : undefined,
                    acceptanceCriteria: body.acceptanceCriteria != null ? String(body.acceptanceCriteria) : undefined,
                    frontend: body.frontend != null ? String(body.frontend) : undefined,
                    backend: body.backend != null ? String(body.backend) : undefined,
                    qa: body.qa != null ? String(body.qa) : undefined,
                    owner: body.owner != null ? String(body.owner) : undefined,
                });
                json(res, { ok: true, story, source: 'local' });
                return;
            }
            if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
            if (!number && !oidParam) { json(res, { error: 'number or oid query param required' }, 400); return; }
            if ((process.env.PM_PROVIDER ?? '').toLowerCase() === 'github') {
                const { resolveProjectTracker } = await import('../providers/index.js');
                const tracker = await resolveProjectTracker(rootDir, configFile);
                const item = await tracker.getWorkItem(number || oidParam || '');
                if (!item) { json(res, { error: `GitHub issue ${number} not found` }, 404); return; }
                json(res, {
                    id: item.id,
                    number: item.number,
                    name: item.title,
                    description: item.description,
                    status: item.status,
                    priority: item.priority ?? 'Medium',
                    type: item.type,
                    url: item.url,
                    acceptanceCriteria: '',
                    source: 'github',
                });
                return;
            }
            if (number && isLocalStoryNumber(number)) {
                const story = findLocalStory(rootDir, number);
                if (!story) { json(res, { error: `Local story ${number} not found` }, 404); return; }
                json(res, {
                    ...story,
                    project: story.scope,
                    url: `local-agility://${story.number}`,
                    source: 'local',
                });
                return;
            }
            let data: unknown;
            if (oidParam) {
                let path: string;
                try { path = storyOidToRestPath(oidParam); } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 400); return; }
                data = await v1Fetch(rootDir, `/${path}`, { sel: storySel });
            } else {
                data = await v1Fetch(rootDir, '/Story', { sel: storySel, where: `Number='${number}'` });
            }
            const asset = pickStoryAsset(data);
            if (!asset) { json(res, { error: oidParam ? `Story oid ${oidParam} not found` : `Story ${number} not found` }, 404); return; }
            const attrs = asset.Attributes || {};
            const rawOid = (asset.id || '').split(':').slice(0, 2).join(':');
            const bUrl = process.env.V1_BASE_URL || process.env.AGILITY_BASE_URL || '';
            const uiBase = bUrl.replace('/rest-1.v1/Data', '').replace(/\/+$/, '');
            json(res, {
                id: asset.id, number: attrs.Number?.value, name: attrs.Name?.value, description: attrs.Description?.value ?? '',
                status: attrs['Status.Name']?.value ?? 'None', teamId: attrs.Team?.value, team: attrs['Team.Name']?.value ?? '',
                estimate: attrs.Estimate?.value, priority: attrs['Priority.Name']?.value ?? '',
                acceptanceCriteria: attrs.Custom_AcceptanceCriteria?.value ?? '', frontend: attrs.Custom_Frontend?.value ?? '',
                backend: attrs.Custom_Backend?.value ?? '', qa: attrs.Custom_QA?.value ?? '',
                project: attrs['Scope.Name']?.value ?? '', classOfService: attrs['ClassOfService.Name']?.value ?? '',
                url: uiBase ? `${uiBase}/story.mvc/Summary?oidToken=${rawOid}` : '' });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 502); }
    });

    // ── /api/agility/tasks/sync (must come before /api/agility/tasks) ────────
    use('/api/agility/tasks/sync', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId, storyNumber } = JSON.parse(body);
            if (!agentId || !storyNumber) { json(res, { error: 'agentId and storyNumber required' }, 400); return; }
            const statusFile = resolve(rootDir, `.${agentId}-status.json`);
            if (!existsSync(statusFile)) { json(res, { error: 'No status file found' }, 404); return; }
            if (isLocalStoryNumber(storyNumber)) {
                const statusRaw = parseJsonUtf8File(statusFile);
                const localTasks = loadLocalTasksForStory(rootDir, storyNumber);
                statusRaw.tasks = dedupeTasksPreserveOrder(localTasks.length > 0 ? localTasks : (statusRaw.tasks || []));
                statusRaw.storySource = 'local';
                writeFileSync(statusFile, JSON.stringify(statusRaw, null, 2));
                json(res, { ok: true, tasks: statusRaw.tasks, source: 'local' });
                return;
            }
            const parentStory = await v1Fetch(rootDir, '/Story', { sel: 'Number', where: `Number='${storyNumber}'` });
            const storyAsset = (parentStory.Assets || [])[0];
            if (!storyAsset) { json(res, { error: `Story ${storyNumber} not found` }, 404); return; }
            const data = await v1Fetch(rootDir, '/Task', { sel: 'Number,Name,Status.Name,Category.Name,DetailEstimate,ToDo,Done', where: `Parent='${storyAsset.id}'` });
            const agilityTasks = (data.Assets || []).map((a: V1Asset) => {
                const at = a.Attributes || {};
                return { number: at.Number?.value, name: at.Name?.value, status: mapV1TaskStatus(at['Status.Name']?.value), agilityStatus: at['Status.Name']?.value ?? null, category: at['Category.Name']?.value ?? null, hours: at.DetailEstimate?.value ?? 0, todo: at.ToDo?.value ?? 0, done: at.Done?.value ?? 0 };
            });
            const statusRaw = parseJsonUtf8File(statusFile);
            const localTasks: RawTask[] = dedupeTasksPreserveOrder(statusRaw.tasks || []);
            const localByNumber = new Map<string, RawTask>();
            for (const t of localTasks) {
                const k = taskIdentityKey(t);
                if (k) localByNumber.set(k, t);
            }
            const merged: RawTask[] = [];
            for (const at of agilityTasks) {
                const atKey = at.number != null ? String(at.number) : '';
                const local = atKey ? localByNumber.get(atKey) : undefined;
                if (local) {
                    merged.push({ ...local, name: at.name, status: at.status, hours: at.hours, category: at.category ?? local.category, agilityStatus: at.agilityStatus });
                    localByNumber.delete(atKey);
                } else {
                    merged.push({ id: at.number, number: at.number, name: at.name, status: at.status, hours: at.hours, category: at.category, agilityStatus: at.agilityStatus });
                }
            }
            for (const remaining of localByNumber.values()) merged.push(remaining);
            for (const t of localTasks) {
                if (!taskIdentityKey(t)) merged.push(t);
            }
            statusRaw.tasks = dedupeTasksPreserveOrder(merged);
            writeFileSync(statusFile, JSON.stringify(statusRaw, null, 2));
            json(res, { ok: true, tasks: statusRaw.tasks });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agility/tasks ───────────────────────────────────────────────────
    use('/api/agility/tasks', async (req, res) => {
        try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const story = url.searchParams.get('story');
            if (!story) { json(res, { error: 'story param required' }, 400); return; }
            if (isLocalStoryNumber(story)) {
                syncAgentTasksToLocalDB(rootDir, story);
                const tasks = loadLocalTasksForStory(rootDir, story).map((task) => ({
                    number: task.number,
                    name: task.name,
                    status: task.status,
                    agilityStatus: task.agilityStatus,
                    category: task.category,
                    owners: task.owners,
                    estimate: task.hours,
                    todo: task.todo,
                    done: task.done,
                    source: 'local',
                }));
                json(res, { tasks, source: 'local' });
                return;
            }
            const parentStory = await v1Fetch(rootDir, '/Story', { sel: 'Number', where: `Number='${story}'` });
            const storyAsset = (parentStory.Assets || [])[0];
            if (!storyAsset) { json(res, { error: `Story ${story} not found` }, 404); return; }
            const data = await v1Fetch(rootDir, '/Task', { sel: 'Number,Name,Status.Name,Category.Name,Owners.Name,DetailEstimate,ToDo,Done,Actuals', where: `Parent='${storyAsset.id}'` });
            const tasks = (data.Assets || []).map((a: V1Asset) => {
                const at = a.Attributes || {};
                const owners = at['Owners.Name']?.value ?? [];
                return { number: at.Number?.value, name: at.Name?.value, status: mapV1TaskStatus(at['Status.Name']?.value), agilityStatus: at['Status.Name']?.value ?? null, category: at['Category.Name']?.value ?? null, owners: Array.isArray(owners) ? owners : [owners], estimate: at.DetailEstimate?.value ?? 0, todo: at.ToDo?.value ?? 0, done: at.Done?.value ?? 0 };
            });
            json(res, { tasks });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 502); }
    });

    // ── /api/agility/create-story ────────────────────────────────────────────
    use('/api/agility/create-story', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { name, description, estimate, team, owner, classOfService, workspaceDir, mode: overrideMode, source, storySource, enrich } = JSON.parse(body);
            if (!name) { json(res, { error: 'name is required' }, 400); return; }
            const cosTrimmed = typeof classOfService === 'string' ? classOfService.trim() : '';
            if (!cosTrimmed) { json(res, { error: 'classOfService is required' }, 400); return; }
            if (source === 'local' || storySource === 'local') {
                let fields = {
                    description: description ? `<p>${description}</p>` : '',
                    acceptanceCriteria: '',
                    frontend: '',
                    backend: '',
                    qa: '',
                    estimate: estimate != null && estimate !== '' ? Number(estimate) : null,
                    classOfService: cosTrimmed,
                };
                let enriched = false;
                if (enrich) {
                    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
                    const enrichment = await enrichStoryFields({
                        name,
                        description,
                        estimate,
                        team,
                        owner,
                        classOfService: cosTrimmed,
                        workspaceDir,
                    }, {
                        ollamaHost,
                        rootDir,
                        agentId: 'frontend',
                        includeEstimateAndClassOfService: true,
                    });
                    fields = {
                        description: enrichment.fields.description || fields.description,
                        acceptanceCriteria: enrichment.fields.acceptanceCriteria || '',
                        frontend: enrichment.fields.frontend || '',
                        backend: enrichment.fields.backend || '',
                        qa: enrichment.fields.qa || '',
                        estimate: typeof enrichment.fields.estimate === 'number' ? enrichment.fields.estimate : fields.estimate,
                        classOfService: enrichment.fields.classOfService || fields.classOfService,
                    };
                    enriched = enrichment.enriched;
                }
                const story = createLocalStory(rootDir, {
                    name,
                    description: fields.description,
                    status: 'Backlog',
                    team: team || 'SDLC Framework',
                    estimate: fields.estimate,
                    classOfService: fields.classOfService,
                    acceptanceCriteria: fields.acceptanceCriteria,
                    frontend: fields.frontend,
                    backend: fields.backend,
                    qa: fields.qa,
                    owner,
                });
                json(res, { success: true, ok: true, story, number: story.number, name: story.name, url: `local-agility://${story.number}`, source: 'local', enriched, mode: getExecMode(configFile) });
                return;
            }
            let activeMode: ExecMode = (overrideMode && isValidMode(overrideMode)) ? overrideMode : getExecMode(configFile);
            // Fall back to cloud (speed) if Ollama is unavailable and a local mode was requested
            if ((activeMode === 'local' || activeMode === 'balanced') && !isOllamaAvailable()) {
                activeMode = 'speed';
            }
            const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
            const proj = cfg.project || {};
            let result: StoryResult;
            const gooseEnv = { apiKey: process.env.V1_ACCESS_TOKEN || process.env.AGILITY_API_KEY || '', baseUrl: process.env.V1_BASE_URL || process.env.AGILITY_BASE_URL || '', rootDir };
            const gooseStoryParams = { name, description, estimate, team: team || proj.team, owner, classOfService: cosTrimmed, workspaceDir, scope: proj.scope || team || 'Ninja Turtles', parent: proj.parent || 'General', category: proj.category || 'Roadmap Features' };
            const creationRoute = storyCreationRouteForMode(activeMode);
            if (creationRoute === 'goose') {
                result = await runGooseLocal(gooseStoryParams, gooseEnv, { model: process.env.LOCAL_LLM_MODEL || 'qwen3:8b' });
            } else {
                const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
                result = creationRoute === 'speed'
                    ? await createStorySpeed({ name, description, estimate, team, owner, classOfService: cosTrimmed, workspaceDir }, v1ApiAdapter, ollamaHost, rootDir)
                    : await createStoryBalanced({ name, description, estimate, team, owner, classOfService: cosTrimmed, workspaceDir }, v1ApiAdapter, ollamaHost, rootDir);
            }
            json(res, { ...result, mode: activeMode }, result.success ? 200 : 500);
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agility/story-status ────────────────────────────────────────────
    use('/api/agility/story-status', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { number, status } = JSON.parse(body);
            if (!number || !status) { json(res, { error: 'number and status are required' }, 400); return; }
            if (isLocalStoryNumber(number)) {
                const story = updateLocalStoryStatus(rootDir, String(number), String(status));
                const TERMINAL = ['Closed', 'Archived', 'Released'];
                if (TERMINAL.includes(status)) {
                    resetAgentsForStory(rootDir, String(number));
                }
                json(res, { ok: true, story, source: 'local' });
                return;
            }
            const findResp = await v1Fetch(rootDir, '/Story', { where: `Number='${number}'`, sel: 'Name,Status.Name' });
            const assets = findResp.Assets || [];
            if (assets.length === 0) { json(res, { error: `Story ${number} not found` }, 404); return; }
            const storyOid = assets[0].id;
            if (status === 'Released' || status === 'Done' || status === 'Closed') {
                if (isMockExternalMode(configFile)) { json(res, { ok: true, storyOid, status, mock: true }); return; }
                const { baseUrl: v1Base, token: v1Token } = getV1Config(rootDir);
                const opResp = await fetch(`${v1Base}/rest-1.v1/Data/${storyOid}?op=Inactivate`, { method: 'POST', headers: V1_HEADERS(v1Token), body: JSON.stringify({}) });
                if (!opResp.ok) { const errText = await opResp.text(); json(res, { error: `Agility API: ${errText}` }, opResp.status); return; }
            }
            json(res, { ok: true, storyOid, status });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agility/reorder-stories ────────────────────────────────────────
    use('/api/agility/reorder-stories', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { numbers } = JSON.parse(body);
            if (!Array.isArray(numbers)) { json(res, { error: 'numbers array is required' }, 400); return; }
            reorderLocalStories(rootDir, numbers as string[]);
            json(res, { ok: true });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agility/delete-story ────────────────────────────────────────────
    use('/api/agility/delete-story', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { number } = JSON.parse(body);
            if (!number) { json(res, { error: 'number is required' }, 400); return; }
            if (!isLocalStoryNumber(number)) { json(res, { error: 'Only local stories can be deleted' }, 400); return; }
            const story = deleteLocalStory(rootDir, String(number));
            json(res, { ok: true, story, source: 'local' });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agility/task-status ─────────────────────────────────────────────
    use('/api/agility/task-status', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { number, status, source } = JSON.parse(body);
            if (!number || !status) { json(res, { error: 'number and status are required' }, 400); return; }
            if (source === 'local' || String(number).startsWith('LOCAL-TK-')) {
                const task = updateLocalTaskStatus(rootDir, String(number), String(status));
                json(res, { ok: true, task, source: 'local' });
                return;
            }
            json(res, { error: 'Live Agility task status updates are not implemented yet' }, 501);
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
