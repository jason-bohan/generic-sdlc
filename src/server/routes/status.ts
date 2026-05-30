import { resolve } from 'path';
import { existsSync } from 'fs';
import { parseJsonUtf8File } from '../json-file';
import { getActiveAgents } from '../spawn-agent';
import { dbGetActiveAgentSession, dbGetAgentSession, dbListAgentSessions, getDb } from '../db';
import { getOllamaHealth } from '../ollamaManager';
import { json } from '../router';
import { getDefaultStatus } from '../status-normalize';
import { onStatusChange, onAgentStatusChange, startStatusFileWatcher, type StatusChangeEvent } from '../status-events';
import { getActiveSessionId, isRunnerActive } from '../agent-runner/registry';
import type { IncomingMessage, ServerResponse } from 'http';
import type { UseFn } from './types';
import { buildStatusBroadcast } from '../status-broadcast';

const AGENT_IDS = ['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops', 'aiqa'];
const SSE_KEEPALIVE_MS = 25_000;

export function mount(use: UseFn, rootDir: string, _configFile: string): void {
    startStatusFileWatcher(rootDir);

    // ── /api/status/stream (SSE) — must be registered before /api/status ─────
    use('/api/status/stream', (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' });
            res.end(); return;
        }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const agentParam = url.searchParams.get('agentId') || 'all';
        const watchAll = agentParam === 'all';

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });

        const send = (ev: StatusChangeEvent) => {
            try {
                res.write(`data: ${JSON.stringify(ev)}\n\n`);
            } catch { /* client disconnected */ }
        };

        // Send initial snapshot(s) immediately
        const snapshotAgents = watchAll ? AGENT_IDS : [agentParam];
        const active = getActiveAgents();
        for (const id of snapshotAgents) {
            const statusFile = resolve(rootDir, `.${id}-status.json`);
            try {
                const raw = existsSync(statusFile)
                    ? parseJsonUtf8File(statusFile) as Record<string, unknown>
                    : getDefaultStatus(id) as Record<string, unknown>;
                const running = id in active || isRunnerActive(id);
                const status = buildStatusBroadcast(raw, id, running, rootDir);
                send({ agentId: id, status, timestamp: new Date().toISOString() });
            } catch { /* skip unreadable */ }
        }

        // Subscribe to future changes
        const unsub = watchAll
            ? onStatusChange(send)
            : onAgentStatusChange(agentParam, send);

        // Keepalive to prevent proxy timeouts
        const heartbeat = setInterval(() => {
            try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); }
        }, SSE_KEEPALIVE_MS);

        req.on('close', () => {
            clearInterval(heartbeat);
            unsub();
        });
    });

    // ── /api/agent-sessions ─────────────────────────────────────────────────
    use('/api/agent-sessions', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const sessionId = url.searchParams.get('id') || undefined;
        const agentId = url.searchParams.get('agentId') || undefined;
        const status = url.searchParams.get('status') || undefined;
        const workflowRaw = url.searchParams.get('workflowItemId');
        const parsedWorkflowItemId = workflowRaw ? Number(workflowRaw) : NaN;
        const workflowItemId = Number.isFinite(parsedWorkflowItemId) ? parsedWorkflowItemId : undefined;
        const limitRaw = Number(url.searchParams.get('limit') || '25');
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 25;
        try {
            if (sessionId) {
                const session = dbGetAgentSession(sessionId);
                if (!session) { json(res, { error: 'session not found' }, 404); return; }
                json(res, { session });
                return;
            }
            json(res, {
                sessions: dbListAgentSessions({
                    agentId,
                    status,
                    workflowItemId,
                    limit,
                }),
            });
        } catch (e) {
            json(res, { sessions: [], error: e instanceof Error ? e.message : String(e) }, 503);
        }
    });

    // ── /api/status ──────────────────────────────────────────────────────────
    use('/api/status', (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const agentId = url.searchParams.get('agentId') || 'frontend';
        const statusFile = resolve(rootDir, `.${agentId}-status.json`);
        const active = getActiveAgents();
        const isRunning = agentId in active || isRunnerActive(agentId);
        let raw: Record<string, unknown>;
        if (existsSync(statusFile)) {
            try { raw = parseJsonUtf8File(statusFile) as Record<string, unknown>; }
            catch (e) {
                console.error(`[status] Failed to read/normalize ${agentId}:`, e instanceof Error ? e.message : e);
                raw = getDefaultStatus(agentId) as Record<string, unknown>;
            }
        } else {
            raw = getDefaultStatus(agentId) as Record<string, unknown>;
        }
        const status = buildStatusBroadcast(raw, agentId, isRunning, rootDir);
        const activeSessionId = _activeSessionId(agentId, active[agentId]?.sessionId, status);
        json(res, { ...status, sessionId: status.sessionId ?? activeSessionId, activeSessionId });
    });

    // ── /health ───────────────────────────────────────────────────────────────
    // Lightweight service health endpoint for external probes and monitoring.
    use('/health', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const status: Record<string, unknown> = { status: 'ok', uptimeSeconds: Math.floor(process.uptime()), services: {} };
        let overallOk = true;

        // DB health (required) — verify existing connection, don't reinit/close
        try {
            getDb().prepare('SELECT 1').get();
            (status.services as any).db = { ok: true };
        } catch (e: unknown) {
            overallOk = false;
            (status.services as any).db = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }

        // Ollama health (informational)
        try {
            const oh = await getOllamaHealth();
            (status.services as any).ollama = oh;
            // Ollama offline does not make the whole service unhealthy, but it is reported
        } catch (e: unknown) {
            (status.services as any).ollama = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }

        if (!overallOk) {
            json(res, { ...status, status: 'unhealthy' }, 500);
            return;
        }
        json(res, status, 200);
    });
}

function _activeSessionId(agentId: string, trackedSessionId: string | undefined, status: Record<string, unknown>): string | null {
    if (trackedSessionId) return trackedSessionId;
    try {
        const active = dbGetActiveAgentSession(agentId)?.id;
        if (active) return active;
    } catch {
        // Fall through to status-file IDs when SQLite is not initialized.
    }
    if (typeof status.activeSessionId === 'string' && status.activeSessionId) return status.activeSessionId;
    if (typeof status.sessionId === 'string' && status.sessionId) return status.sessionId;
    return null;
}
