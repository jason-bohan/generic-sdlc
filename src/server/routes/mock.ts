import { writeFileSync } from 'fs';
import { resolve as pathResolve } from 'path';
import { isMockExternalMode } from '../external-mode';
import { mockV1Fetch, mockV1Http } from '../mock-external';
import { readBody, json, cors } from '../router';
import { normalizeTasks, type RawTask } from '../status-normalize';
import { emitStatusChange } from '../status-events';
import { getActiveAgents } from '../spawn-agent';
import { buildStatusBroadcast } from '../status-broadcast';
import type { V1Asset } from '../route-shared';
import type { UseFn } from './types';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/agent/write-status (test-only, mock mode) ────────────────────
    use('/api/agent/write-status', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        if (!isMockExternalMode(configFile) && process.env.SDLC_FRAMEWORK_E2E !== '1') {
            json(res, { error: 'write-status only available in mock mode' }, 403);
            return;
        }
        const body = await readBody(req);
        try {
            const { agentId, status: statusData } = JSON.parse(body);
            if (!agentId || !statusData) { json(res, { error: 'agentId and status required' }, 400); return; }
            const statusFile = pathResolve(rootDir, `.${agentId}-status.json`);
            if (Array.isArray(statusData.tasks)) {
                statusData.tasks = normalizeTasks(statusData.tasks as RawTask[]);
            }
            writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
            const active = getActiveAgents();
            const isRunning = agentId in active;
            emitStatusChange(agentId, buildStatusBroadcast(statusData as Record<string, unknown>, agentId, isRunning, rootDir));
            json(res, { ok: true, agentId });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/agent/write-reviewer-comments (test-only, mock mode) ──────────
    use('/api/agent/write-reviewer-comments', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        if (!isMockExternalMode(configFile)) { json(res, { error: 'write-reviewer-comments only available in mock mode' }, 403); return; }
        const body = await readBody(req);
        try {
            const { prId, threads } = JSON.parse(body);
            if (typeof prId !== 'number' || !Array.isArray(threads)) { json(res, { error: 'prId number and threads array required' }, 400); return; }
            const safeThreads = threads
                .filter((thread: unknown): thread is Record<string, unknown> => thread != null && typeof thread === 'object')
                .map((thread) => ({
                    ...(typeof thread.id === 'string' ? { id: thread.id } : {}),
                    ...(typeof thread.file === 'string' ? { file: thread.file } : {}),
                    ...(typeof thread.line === 'number' ? { line: thread.line } : {}),
                    ...(typeof thread.comment === 'string' ? { comment: thread.comment } : {}),
                    ...(typeof thread.severity === 'string' ? { severity: thread.severity } : {}),
                }))
                .filter((thread) => typeof thread.comment === 'string' && thread.comment.trim());
            writeFileSync(pathResolve(rootDir, '.reviewer-comments.json'), JSON.stringify({ prId, threads: safeThreads }, null, 2));
            json(res, { ok: true, prId, count: safeThreads.length });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /mock-v1/stories — convenience REST shortcut ──────────────────────
    // Agents sometimes call /mock-v1/stories/B-17001 instead of the
    // VersionOne-compatible /mock-v1/rest-1.v1/Data/Story path.  Redirect
    // to the same in-memory mock so those requests succeed.
    use('/mock-v1/stories', async (req, res) => {
        cors(res, 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'GET') { json(res, { error: 'Method not allowed' }, 405); return; }
        const tail = new URL(req.url!, `http://${req.headers.host}`).pathname.replace(/^\/mock-v1\/stories\/?/, '');
        if (tail) {
            const data = mockV1Fetch(rootDir, '/Story', { where: `Number='${tail}'`, sel: 'Number,Name,Description,Status.Name,Team.Name,Estimate,Priority.Name,Custom_AcceptanceCriteria,Custom_Frontend,Custom_Backend,Custom_QA,Scope.Name,ClassOfService.Name' }) as { Assets?: V1Asset[] };
            const asset = (data.Assets || [])[0];
            if (!asset) { json(res, { error: `Story ${tail} not found` }, 404); return; }
            const a = asset.Attributes || {};
            json(res, {
                id: asset.id, number: a.Number?.value, name: a.Name?.value,
                description: a.Description?.value ?? '', status: a['Status.Name']?.value ?? 'None',
                team: a['Team.Name']?.value ?? '', estimate: a.Estimate?.value,
                priority: a['Priority.Name']?.value ?? '',
                acceptanceCriteria: a.Custom_AcceptanceCriteria?.value ?? '',
                frontend: a.Custom_Frontend?.value ?? '', backend: a.Custom_Backend?.value ?? '',
                qa: a.Custom_QA?.value ?? '', project: a['Scope.Name']?.value ?? '',
                classOfService: a['ClassOfService.Name']?.value ?? '',
            });
        } else {
            const data = mockV1Fetch(rootDir, '/Story', {}) as { Assets?: V1Asset[] };
            const stories = (data.Assets || []).map((asset: V1Asset) => {
                const a = asset.Attributes || {};
                return { id: asset.id, number: a.Number?.value, name: a.Name?.value, status: a['Status.Name']?.value ?? 'None', team: a['Team.Name']?.value ?? '' };
            });
            json(res, { stories, total: stories.length });
        }
    });

    // ── /mock-v1/rest-1.v1/Data ─────────────────────────────────────────────
    // VersionOne-compatible mock API for local MCP testing (mock mode only).
    // Mirrors live Agility paths so the bundled MCP server works without credentials.
    use('/mock-v1/rest-1.v1/Data', async (req, res) => {
        cors(res, 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((value, key) => { queryParams[key] = value; });
        const assetPath = url.pathname.replace(/^\/mock-v1\/rest-1\.v1\/Data/, '') || '/';
        if (req.method === 'GET') {
            json(res, mockV1Http(rootDir, 'GET', assetPath, queryParams));
            return;
        }
        if (req.method === 'POST') {
            const body = await readBody(req);
            try {
                const parsed = body ? JSON.parse(body) : {};
                json(res, mockV1Http(rootDir, 'POST', assetPath, queryParams, parsed));
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 400); }
            return;
        }
        res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' }));
    });
}
