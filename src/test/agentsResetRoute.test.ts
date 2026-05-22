import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { AGENT_RESET_CONFIRM_PHRASE } from '../shared/agentResetConfirm';

const TMP = resolve(__dirname, '.agents-reset-route-tmp');

let server: Server | null = null;
let baseUrl = '';

function writeJson(path: string, value: unknown) {
    writeFileSync(path, JSON.stringify(value, null, 2));
}

async function startServer() {
    server = http.createServer(createApp(TMP));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((r, j) => server!.close((err) => (err ? j(err) : r())));
    server = null;
    baseUrl = '';
}

async function req(path: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    return { res, body };
}

beforeEach(async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });

    writeJson(resolve(TMP, '.sdlc-framework.config.json'), {
        externalMode: 'mock',
        scheduler: { mode: 'notify', agents: { frontend: { enabled: true } } },
    });

    writeJson(resolve(TMP, '.frontend-status.json'), {
        storyNumber: 'B-99999',
        storyName: 'Dirty',
        currentPhase: 'generating-code',
        tasks: [{ id: 'T1', name: 'x', status: 'pending', hours: 1 }],
        prs: [],
        events: [],
        tokens: { cloud: { input: 1, output: 2 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
        cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
    });
    writeJson(resolve(TMP, '.frontend-messages.json'), [{ id: 'm1', from: 'user', message: 'hi', timestamp: '2026-01-01', status: 'pending' }]);

    await startServer();
});

afterEach(async () => {
    await stopServer();
    rmSync(TMP, { recursive: true, force: true });
});

describe('/api/agents/reset-to-idle', () => {
    it('rejects wrong confirmation phrase', async () => {
        const { res, body } = await req('/api/agents/reset-to-idle', {
            method: 'POST',
            body: JSON.stringify({ confirm: 'wrong' }),
        });
        expect(res.status).toBe(400);
        expect(body.error).toBeTruthy();
        const still = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        expect(still.storyNumber).toBe('B-99999');
    });

    it('resets agent files and clears messages when phrase matches', async () => {
        const { res, body } = await req('/api/agents/reset-to-idle', {
            method: 'POST',
            body: JSON.stringify({ confirm: AGENT_RESET_CONFIRM_PHRASE }),
        });
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(Array.isArray(body.written)).toBe(true);
        expect(body.written).toContain('.frontend-status.json');

        const fresh = JSON.parse(readFileSync(resolve(TMP, '.frontend-status.json'), 'utf-8'));
        expect(fresh.storyNumber).toBeNull();
        expect(fresh.currentPhase).toBe('idle');
        expect(fresh.tasks).toEqual([]);

        const msgs = readFileSync(resolve(TMP, '.frontend-messages.json'), 'utf-8').trim();
        expect(msgs).toBe('[]');
    });
});
