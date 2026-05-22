import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TMP = resolve(__dirname, '.meeting-agent-route-tmp');

let server: Server | null = null;
let baseUrl = '';
let originalFetch: typeof fetch;

async function startServer() {
    vi.resetModules();
    vi.doMock('../server/meeting-agent', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../server/meeting-agent')>();
        return {
            ...actual,
            processMeetingText: vi.fn(async ({ text, memory }: { text: string; memory: string[] }) => {
                actual.rememberMeetingText(memory, text);
                return {
                    tasks: [{ title: 'Move AI controls into AICommandRoom', confidence: 0.91, agentId: 'frontend' }],
                    decisions: [],
                    dispatched: [],
                    trace: [{ type: 'task', title: 'Move AI controls into AICommandRoom', confidence: 0.91, action: 'held' }],
                    reply: 'Task detected: 1; decisions recorded: 0.',
                    memory,
                };
            }),
        };
    });
    const { createApp } = await import('../server/app');
    server = http.createServer(createApp(TMP));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((resolveClose, rejectClose) => server!.close((err) => (err ? rejectClose(err) : resolveClose())));
    server = null;
    baseUrl = '';
}

beforeEach(() => {
    originalFetch = global.fetch;
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    writeFileSync(resolve(TMP, '.sdlc-framework.config.json'), JSON.stringify({ executionMode: 'balanced' }));
});

afterEach(async () => {
    await stopServer();
    vi.doUnmock('../server/meeting-agent');
    vi.resetModules();
    rmSync(TMP, { recursive: true, force: true });
});

describe('/api/meeting-agent/messages', () => {
    it('serves a browser demo page on GET', async () => {
        await startServer();
        const res = await originalFetch(`${baseUrl}/api/meeting-agent/messages`);
        const html = await res.text();

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(html).toContain('Meeting Agent Demo');
        expect(html).toContain('/api/meeting-agent/messages');
    });

    it('accepts a Teams activity-shaped message and returns a Bot Framework-style reply', async () => {
        await startServer();
        const res = await originalFetch(`${baseUrl}/api/meeting-agent/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'message',
                text: 'We should move AI controls into AICommandRoom.',
                conversation: { id: 'meeting-1' },
                from: { name: 'Pat' },
                execute: false,
            }),
        });
        const body = await res.json();

        expect(res.status, JSON.stringify(body)).toBe(200);
        expect(body).toMatchObject({
            type: 'message',
            ok: true,
            text: 'Task detected: 1; decisions recorded: 0.',
        });
        expect(body.tasks[0]).toMatchObject({ title: 'Move AI controls into AICommandRoom' });
        expect(body.trace[0]).toMatchObject({ action: 'held' });
    });

    it('rejects empty meeting activity text', async () => {
        await startServer();
        const res = await originalFetch(`${baseUrl}/api/meeting-agent/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'message', text: '' }),
        });
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('text is required');
    });
});
