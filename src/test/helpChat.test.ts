import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';

// Prevent the real driver (claude-code / cursor / goose) from spawning during tests.
// Without this, runInlineQuery can hit its timeout and fail the test while
// leaving SQLite locked for subsequent teardown.
vi.mock('../server/agent-drivers', () => ({
    runInlineQuery: vi.fn().mockRejectedValue(new Error('no driver in test')),
}));
import { runInlineQuery } from '../server/agent-drivers';

// Use a unique tmp dir per test file to avoid collisions with parallel test files
const TMP = resolve(__dirname, '.helpchat-tmp');

// Point OLLAMA_HOST at an unreachable port so pingOllama() fails immediately
// and tests never make real LLM inference calls. Without this, if Ollama is
// running locally the tests would time out waiting for a long inference response.
const FAKE_OLLAMA = 'http://127.0.0.1:19919';
let savedOllamaHost: string | undefined;

let server: Server | null = null;
let baseUrl = '';

async function startServer() {
    server = http.createServer(createApp(TMP));
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', res));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((res, rej) => server!.close((err) => err ? rej(err) : res()));
    server = null;
    baseUrl = '';
}

async function post(path: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
    savedOllamaHost = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = FAKE_OLLAMA;
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    initDb(TMP);
    await startServer();
});

afterEach(async () => {
    await stopServer();
    closeDb();
    if (savedOllamaHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = savedOllamaHost;
    // Brief pause to let SQLite release its file lock before rmSync (Windows)
    await new Promise((r) => setTimeout(r, 100));
    rmSync(TMP, { recursive: true, force: true });
});

describe('/api/help/chat', () => {
    it('rejects GET with 405', async () => {
        const r = await get('/api/help/chat');
        expect(r.status).toBe(405);
        expect(r.body).toHaveProperty('error');
    });

    it('rejects empty message with 400', async () => {
        const r = await post('/api/help/chat', { message: '' });
        expect(r.status).toBe(400);
        expect(r.body).toHaveProperty('error');
    });

    it('rejects missing message with 400', async () => {
        const r = await post('/api/help/chat', {});
        expect(r.status).toBe(400);
        expect(r.body).toHaveProperty('error');
    });

    it('rejects whitespace-only message with 400', async () => {
        const r = await post('/api/help/chat', { message: '   ' });
        expect(r.status).toBe(400);
        expect(r.body).toHaveProperty('error');
    });

    // These tests exercise the offline fallback path: ping fails (FAKE_OLLAMA unreachable),
    // driver mock throws immediately → source is 'offline'. Fast; no real inference.
    it('returns 200 with answer and source for valid message', async () => {
        const r = await post('/api/help/chat', {
            message: 'what is step mode?',
            history: [],
        });
        expect(r.status).toBe(200);
        expect(r.body).toHaveProperty('answer');
        expect(r.body).toHaveProperty('source');
        expect(typeof r.body.answer).toBe('string');
        expect(['kb', 'ollama', 'driver', 'offline']).toContain(r.body.source);
    }, 15_000);

    it('accepts conversation history', async () => {
        const r = await post('/api/help/chat', {
            message: 'how do I advance to the next step?',
            history: [
                { role: 'user', content: 'what is step mode?' },
                { role: 'assistant', content: 'Step mode pauses agent execution at phase boundaries.' },
            ],
        });
        expect(r.status).toBe(200);
        expect(r.body).toHaveProperty('answer');
    }, 15_000);

    it('ignores invalid history entries and still responds', async () => {
        const r = await post('/api/help/chat', {
            message: 'what is step mode?',
            history: 'not-an-array',
        });
        expect(r.status).toBe(200);
        expect(r.body).toHaveProperty('answer');
    }, 15_000);

    // Ollama unreachable + driver mock throws → source must be 'offline', answer non-empty.
    it('gracefully falls back when Ollama is offline', async () => {
        const r = await post('/api/help/chat', { message: 'what agents are available?', history: [] });
        expect(r.status).toBe(200);
        expect(typeof r.body.answer).toBe('string');
        expect(r.body.answer.length).toBeGreaterThan(0);
        expect(r.body.source).not.toBe('ollama');
    }, 15_000);

    it('uses the configured driver fallback when Ollama is offline and KB has no direct answer', async () => {
        vi.mocked(runInlineQuery).mockResolvedValueOnce('Driver fallback answer');

        const r = await post('/api/help/chat', { message: 'explain zetaquill', history: [] });

        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
            answer: 'Driver fallback answer',
            source: 'driver',
        });
    }, 15_000);

    it('KB mentions reviewer pending-review headless logs and SKILL.md', async () => {
        const r = await post('/api/help/chat', {
            message: 'What happens when the reviewer is pending-review with a PR?',
            history: [],
        });
        expect(r.status).toBe(200);
        expect(r.body.answer).toMatch(/\.agent-output/);
        expect(r.body.answer).toContain('reviewer-');
        expect(r.body.answer).toContain('.log');
        expect(r.body.answer).toMatch(/SKILL\.md/);
        expect(r.body.answer).toMatch(/spawnedPid/);
    }, 15_000);

    it('includes configured reviewer display name in KB agent table', async () => {
        writeFileSync(
            resolve(TMP, '.sdlc-framework.config.json'),
            JSON.stringify({
                scheduler: {
                    mode: 'notify',
                    agents: { reviewer: { enabled: true, displayName: 'JudgeCustom' } },
                },
            }),
        );
        const r = await post('/api/help/chat', {
            message: 'list sdlc-framework agents and their roles',
            history: [],
        });
        expect(r.status).toBe(200);
        expect(r.body.answer).toContain('JudgeCustom');
        expect(r.body.answer).toContain('| reviewer |');
    }, 15_000);
});
