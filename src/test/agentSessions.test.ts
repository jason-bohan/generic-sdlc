import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import {
    closeDb,
    dbCreateWorkflowItem,
    dbCreateAgentSession,
    dbGetActiveAgentSession,
    dbGetAgentSession,
    dbListAgentSessions,
    dbUpdateAgentSession,
    initDb,
} from '../server/db';

const TMP = resolve(__dirname, '.agent-sessions-tmp');

let server: Server | null = null;
let baseUrl = '';

async function startServer() {
    server = http.createServer(createApp(TMP));
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((resolveClose, reject) => {
        server!.close((err) => err ? reject(err) : resolveClose());
    });
    server = null;
    baseUrl = '';
}

async function getJson(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    const body = await res.json();
    return { res, body };
}

beforeEach(async () => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    initDb(TMP);
    await startServer();
});

afterEach(async () => {
    await stopServer();
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
});

describe('agent session state', () => {
    it('stores and updates durable agent sessions in SQLite', () => {
        const workflow = dbCreateWorkflowItem({
            storyNumber: 'B-22001',
            storyName: 'Persist runner state',
            classification: 'frontend',
            activeAgentId: 'frontend',
            activePhase: 'reading-story',
            externalMode: 'mock',
        });
        const session = dbCreateAgentSession({
            agentId: 'frontend',
            workflowItemId: workflow.id,
            storyNumber: 'B-22001',
            storyName: 'Persist runner state',
            phase: 'reading-story',
            driver: 'goose',
            model: 'local',
            pid: 4242,
            workspaceDir: TMP,
            logFile: resolve(TMP, '.agent-output', 'frontend.log'),
            promptFile: resolve(TMP, '.agent-output', 'frontend-prompt.txt'),
            metadata: { assignedPrId: null },
        });

        expect(session.id).toMatch(/^session_/);
        expect(dbGetAgentSession(session.id)).toMatchObject({
            agent_id: 'frontend',
            workflow_item_id: workflow.id,
            status: 'running',
        });
        expect(dbGetActiveAgentSession('frontend')?.id).toBe(session.id);

        dbUpdateAgentSession(session.id, {
            status: 'completed',
            endedAt: '2026-05-14T12:00:00.000Z',
            metadata: { exitCode: 0 },
        });

        expect(dbGetAgentSession(session.id)).toMatchObject({
            status: 'completed',
            ended_at: '2026-05-14T12:00:00.000Z',
        });
        expect(dbGetActiveAgentSession('frontend')).toBeUndefined();
        expect(dbListAgentSessions({ agentId: 'frontend', status: 'completed' })).toHaveLength(1);
    });

    it('exposes active session IDs through status and session API routes', async () => {
        const session = dbCreateAgentSession({
            agentId: 'backend',
            storyNumber: 'B-22002',
            storyName: 'Expose sessions to MCP',
            phase: 'generating-code',
            driver: 'cursor',
            pid: 5252,
            workspaceDir: TMP,
            logFile: resolve(TMP, '.agent-output', 'backend.log'),
        });

        const status = await getJson('/api/status?agentId=backend');
        expect(status.res.status).toBe(200);
        expect(status.body).toMatchObject({
            activeSessionId: session.id,
            sessionId: session.id,
            isRunning: false,
        });

        const list = await getJson('/api/agent-sessions?agentId=backend&status=running');
        expect(list.res.status).toBe(200);
        expect(list.body.sessions).toHaveLength(1);
        expect(list.body.sessions[0]).toMatchObject({
            id: session.id,
            story_number: 'B-22002',
            phase: 'generating-code',
        });

        const single = await getJson(`/api/agent-sessions?id=${encodeURIComponent(session.id)}`);
        expect(single.res.status).toBe(200);
        expect(single.body.session).toMatchObject({ id: session.id, agent_id: 'backend' });
    });
});
