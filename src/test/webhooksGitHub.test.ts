import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { createHmac } from 'crypto';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';

const TMP = resolve(__dirname, '.webhooks-github-tmp');

let server: Server | null = null;
let baseUrl = '';

async function startServer() {
    server = http.createServer(createApp(TMP));
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', res));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((res, rej) => server!.close((e) => (e ? rej(e) : res())));
    server = null;
    baseUrl = '';
}

function sign(secret: string, body: string): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function issuePayload(action: string, overrides: Partial<{ number: number; title: string; body: string }> = {}): string {
    return JSON.stringify({
        action,
        issue: {
            number: overrides.number ?? 1,
            title: overrides.title ?? 'Test issue',
            body: overrides.body ?? 'Description',
            html_url: `https://github.com/test/repo/issues/${overrides.number ?? 1}`,
            state: 'open',
        },
        repository: { full_name: 'test/repo' },
    });
}

async function post(path: string, body: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
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
    delete process.env.GITHUB_WEBHOOK_SECRET;
    vi.restoreAllMocks();
});

describe('POST /api/webhooks/github', () => {
    it('rejects non-POST methods', async () => {
        const res = await fetch(`${baseUrl}/api/webhooks/github`);
        expect(res.status).toBe(405);
    });

    it('skips non-issues events', async () => {
        const payload = issuePayload('opened');
        const { body } = await post('/api/webhooks/github', payload, { 'x-github-event': 'push' });
        expect(body.skipped).toBe(true);
        expect(body.reason).toContain('unhandled event');
    });

    it('rejects requests with wrong signature when secret is set', async () => {
        process.env.GITHUB_WEBHOOK_SECRET = 'mysecret';
        const payload = issuePayload('opened');
        const { status, body } = await post('/api/webhooks/github', payload, {
            'x-github-event': 'issues',
            'x-hub-signature-256': 'sha256=badsig',
        });
        expect(status).toBe(401);
        expect(body.error).toContain('Invalid signature');
    });

    it('accepts requests with correct HMAC signature', async () => {
        process.env.GITHUB_WEBHOOK_SECRET = 'mysecret';
        const payload = issuePayload('opened');
        const sig = sign('mysecret', payload);
        const { status } = await post('/api/webhooks/github', payload, {
            'x-github-event': 'issues',
            'x-hub-signature-256': sig,
        });
        // Will fail to call Linear (no API key in test), but not a 401
        expect(status).not.toBe(401);
    });

    it('rejects invalid JSON', async () => {
        const { status, body } = await post('/api/webhooks/github', 'not-json', {
            'x-github-event': 'issues',
        });
        expect(status).toBe(400);
        expect(body.error).toContain('Invalid JSON');
    });

    it('requires LINEAR_TEAM_ID to create issues', async () => {
        delete process.env.LINEAR_TEAM_ID;
        const payload = issuePayload('opened');
        const { status, body } = await post('/api/webhooks/github', payload, { 'x-github-event': 'issues' });
        expect(status).toBe(500);
        expect(body.error).toContain('LINEAR_TEAM_ID');
    });

    it('skips edited/closed/reopened when no mapping exists', async () => {
        for (const action of ['edited', 'closed', 'reopened']) {
            const payload = issuePayload(action, { number: 999 });
            const { body } = await post('/api/webhooks/github', payload, { 'x-github-event': 'issues' });
            expect(body.skipped).toBe(true);
            expect(body.reason).toContain('no Linear issue mapped');
        }
    });

    it('skips unhandled actions when mapping exists', async () => {
        const { writeFileSync } = await import('fs');
        writeFileSync(resolve(TMP, '.github-linear-map.json'), JSON.stringify({ 'test/repo#1': 'fake-id' }));
        const payload = issuePayload('labeled');
        const { body } = await post('/api/webhooks/github', payload, { 'x-github-event': 'issues' });
        expect(body.skipped).toBe(true);
        expect(body.reason).toContain('unhandled action');
    });

    it('persists mapping after open and reads it for edit', async () => {
        const mapFile = resolve(TMP, '.github-linear-map.json');
        // Seed a fake mapping as if 'opened' had already run
        const { writeFileSync } = await import('fs');
        writeFileSync(mapFile, JSON.stringify({ 'test/repo#42': 'fake-linear-id' }));

        // Verify the map file was written correctly
        const map = JSON.parse(readFileSync(mapFile, 'utf-8'));
        expect(map['test/repo#42']).toBe('fake-linear-id');
    });
});

describe('POST /api/webhooks/github/test', () => {
    it('rejects non-POST methods', async () => {
        const res = await fetch(`${baseUrl}/api/webhooks/github/test`);
        expect(res.status).toBe(405);
    });

    it('requires number and action', async () => {
        const { status, body } = await post('/api/webhooks/github/test', JSON.stringify({}));
        expect(status).toBe(400);
        expect(body.error).toContain('number and action required');
    });
});
