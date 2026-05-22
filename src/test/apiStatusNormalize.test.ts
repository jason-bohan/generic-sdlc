import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import * as spawnAgentMod from '../server/spawn-agent';

const TMP = resolve(__dirname, '.api-status-normalize-tmp');

let server: Server | null = null;
let baseUrl = '';

async function startServer() {
    server = http.createServer(createApp(TMP));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((res, rej) => server!.close((err) => (err ? rej(err) : res())));
    server = null;
    baseUrl = '';
}

beforeEach(async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    await startServer();
});

afterEach(async () => {
    await stopServer();
    rmSync(TMP, { recursive: true, force: true });
});

describe('/api/status normalization', () => {
    it('parses agent status JSON with UTF-8 BOM (PowerShell / Notepad)', async () => {
        const body = { currentPhase: 'idle', assignedPR: null, events: [], tasks: [], prs: [] };
        writeFileSync(resolve(TMP, '.devops-status.json'), '\uFEFF' + JSON.stringify(body, null, 2), 'utf8');
        const res = await fetch(`${baseUrl}/api/status?agentId=devops`);
        expect(res.status).toBe(200);
        const j = await res.json() as { currentPhase: string };
        expect(j.currentPhase).toBe('idle');
    });

    it('parses agent status file with repeated raw UTF-8 BOM byte sequences', async () => {
        const body = { currentPhase: 'idle', assignedPR: null, events: [], tasks: [], prs: [] };
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const payload = Buffer.concat([bom, bom, Buffer.from(JSON.stringify(body, null, 2), 'utf8')]);
        writeFileSync(resolve(TMP, '.devops-status.json'), payload);
        const res = await fetch(`${baseUrl}/api/status?agentId=devops`);
        expect(res.status).toBe(200);
        const j = await res.json() as { currentPhase: string };
        expect(j.currentPhase).toBe('idle');
    });

    it('reviewer work card keeps at most 5 PRs and marks idle desk entries Complete', async () => {
        const prs = Array.from({ length: 6 }, (_, i) => ({
            id: 5000 + i,
            title: `PR ${5000 + i}`,
            status: 'active',
            comments: 0,
            approvals: 0,
        }));
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({
                currentPhase: 'idle',
                assignedPR: null,
                tasks: [],
                prs,
                events: [],
            }, null, 2),
        );
        const res = await fetch(`${baseUrl}/api/status?agentId=reviewer`);
        expect(res.status).toBe(200);
        const j = await res.json() as { prs: Array<{ id: number; status: string }> };
        expect(j.prs).toHaveLength(5);
        expect(j.prs.every((p) => p.status === 'completed')).toBe(true);
        const ids = j.prs.map((p) => p.id).sort((a, b) => a - b);
        expect(ids).toEqual([5001, 5002, 5003, 5004, 5005]);
    });

    it('backfills reviewer work card from events when prs is empty', async () => {
        writeFileSync(
            resolve(TMP, '.reviewer-status.json'),
            JSON.stringify({
                currentPhase: 'idle',
                assignedPR: null,
                tasks: [],
                prs: [],
                events: [
                    { timestamp: '2026-01-01', type: 'info', message: 'Noise' },
                    { timestamp: '2026-01-02', type: 'info', message: 'PR #5006 approved with suggestions.' },
                ],
            }, null, 2),
        );
        const res = await fetch(`${baseUrl}/api/status?agentId=reviewer`);
        expect(res.status).toBe(200);
        const j = await res.json() as { prs: Array<{ id: number; status: string; title: string }> };
        expect(j.prs.length).toBeGreaterThanOrEqual(1);
        expect(j.prs.some((p) => p.id === 5006 && p.status === 'completed')).toBe(true);
    });

    it('returns isRunning=false when no agent process is tracked', async () => {
        writeFileSync(
            resolve(TMP, '.frontend-status.json'),
            JSON.stringify({
                storyNumber: 'B-99999',
                currentPhase: 'generating-code',
                tasks: [],
                events: [],
            }, null, 2),
        );
        const res = await fetch(`${baseUrl}/api/status?agentId=frontend`);
        expect(res.status).toBe(200);
        const j = await res.json() as { currentPhase: string; isRunning: boolean };
        expect(j.currentPhase).toBe('generating-code');
        expect(j.isRunning).toBe(false);
    });

    it('returns isRunning=true when getActiveAgents reports the agent', async () => {
        writeFileSync(
            resolve(TMP, '.frontend-status.json'),
            JSON.stringify({
                storyNumber: 'B-99999',
                currentPhase: 'generating-code',
                tasks: [],
                events: [],
            }, null, 2),
        );
        const spy = vi.spyOn(spawnAgentMod, 'getActiveAgents').mockReturnValue({
            frontend: { pid: 99999, spawnedAt: new Date().toISOString() },
        });
        try {
            const res = await fetch(`${baseUrl}/api/status?agentId=frontend`);
            expect(res.status).toBe(200);
            const j = await res.json() as { currentPhase: string; isRunning: boolean };
            expect(j.currentPhase).toBe('generating-code');
            expect(j.isRunning).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });

    it('returns isRunning=false for idle agent with no status file', async () => {
        const res = await fetch(`${baseUrl}/api/status?agentId=frontend`);
        expect(res.status).toBe(200);
        const j = await res.json() as { currentPhase: string; isRunning: boolean };
        expect(j.currentPhase).toBe('idle');
        expect(j.isRunning).toBe(false);
    });
});
