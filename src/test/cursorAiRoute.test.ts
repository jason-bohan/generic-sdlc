import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';
import { parseJsonUtf8File } from '../server/json-file';

const TMP = resolve(__dirname, '.cursor-ai-route-tmp');
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');

let server: Server | null = null;
let baseUrl = '';

async function startServer() {
    server = http.createServer(createApp(TMP));
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((resolveClose, reject) => {
        server!.close((err) => (err ? reject(err) : resolveClose()));
    });
    server = null;
    baseUrl = '';
}

async function request(path: string, init?: RequestInit): Promise<{ res: Response; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    return { res, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
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

describe('/api/cursor-ai', () => {
    it('returns disabled by default and persists PUT updates', async () => {
        const initial = await request('/api/cursor-ai');
        expect(initial.res.status).toBe(200);
        expect(initial.body).toEqual({ enabled: false });

        const updated = await request('/api/cursor-ai', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        });
        expect(updated.res.status).toBe(200);
        expect(updated.body).toEqual({ enabled: false });
        expect(parseJsonUtf8File(CONFIG).cursorAiEnabled).toBe(false);
    });

    it('rejects non-boolean updates', async () => {
        const result = await request('/api/cursor-ai', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: 'nope' }),
        });
        expect(result.res.status).toBe(400);
        expect(result.body.error).toContain('enabled must be boolean');
    });
});

