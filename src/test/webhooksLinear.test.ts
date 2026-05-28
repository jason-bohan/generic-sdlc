import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { createHmac } from 'crypto';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';

const TMP = resolve(__dirname, '.webhooks-linear-tmp');

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
    return createHmac('sha256', secret).update(body).digest('hex');
}

function issueUpdatePayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        action: 'update',
        type: 'Issue',
        data: {
            id: 'test-id',
            identifier: 'UNW-1',
            number: 1,
            title: 'Test issue',
            description: 'desc',
            state: { name: 'In Progress' },
            team: { id: 'team-1', name: 'Team' },
            assignee: { id: 'user-1', name: 'Alice' },
            labels: [],
            url: 'https://linear.app/test',
        },
        updatedFrom: { assigneeId: null },
        ...overrides,
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
    delete process.env.LINEAR_WEBHOOK_SECRET;
});

describe('POST /api/webhooks/linear', () => {
    it('rejects non-POST methods', async () => {
        const res = await fetch(`${baseUrl}/api/webhooks/linear`);
        expect(res.status).toBe(405);
    });

    it('accepts requests without a secret configured', async () => {
        const payload = issueUpdatePayload({ updatedFrom: { assigneeId: 'other-user' } });
        const { status } = await post('/api/webhooks/linear', payload);
        // Will attempt to contact scheduler but that's fine — just not a 4xx auth error
        expect(status).not.toBe(401);
    });

    it('rejects requests with wrong signature when secret is set', async () => {
        process.env.LINEAR_WEBHOOK_SECRET = 'mysecret';
        const payload = issueUpdatePayload();
        const { status, body } = await post('/api/webhooks/linear', payload, {
            'linear-signature': 'badsignature',
        });
        expect(status).toBe(401);
        expect(body.error).toContain('Invalid signature');
    });

    it('accepts requests with correct HMAC signature', async () => {
        process.env.LINEAR_WEBHOOK_SECRET = 'mysecret';
        const payload = issueUpdatePayload();
        const sig = sign('mysecret', payload);
        const { status } = await post('/api/webhooks/linear', payload, {
            'linear-signature': sig,
        });
        expect(status).not.toBe(401);
    });

    it('rejects invalid JSON', async () => {
        const { status, body } = await post('/api/webhooks/linear', 'not-json');
        expect(status).toBe(400);
        expect(body.error).toContain('Invalid JSON');
    });

    it('skips non-Issue events', async () => {
        const payload = JSON.stringify({ action: 'create', type: 'Comment', data: {} });
        const { body } = await post('/api/webhooks/linear', payload);
        expect(body.skipped).toBe(true);
        expect(body.reason).toContain('not an issue update');
    });

    it('skips non-update actions', async () => {
        const payload = JSON.stringify({ action: 'create', type: 'Issue', data: {} });
        const { body } = await post('/api/webhooks/linear', payload);
        expect(body.skipped).toBe(true);
    });

    it('skips when assignee is unchanged', async () => {
        const payload = issueUpdatePayload({ updatedFrom: {} }); // no assigneeId in updatedFrom
        const { body } = await post('/api/webhooks/linear', payload);
        expect(body.skipped).toBe(true);
        expect(body.reason).toContain('assignee unchanged');
    });

    it('skips when assignee is cleared', async () => {
        const payload = issueUpdatePayload({
            data: {
                id: 'x', identifier: 'UNW-2', number: 2, title: 'T',
                assignee: null, labels: [],
            },
            updatedFrom: { assigneeId: 'prev-user' },
        });
        const { body } = await post('/api/webhooks/linear', payload);
        expect(body.skipped).toBe(true);
    });

    it('skips when no agent is mapped for the assignee', async () => {
        // No config file written, no labels — resolver returns null
        const payload = issueUpdatePayload({ updatedFrom: { assigneeId: 'old-user' } });
        const { body } = await post('/api/webhooks/linear', payload);
        expect(body.skipped).toBe(true);
        expect(body.reason).toContain('no agent mapped');
    });
});

describe('POST /api/webhooks/linear/test', () => {
    it('rejects non-POST methods', async () => {
        const res = await fetch(`${baseUrl}/api/webhooks/linear/test`);
        expect(res.status).toBe(405);
    });

    it('requires identifier and agentId', async () => {
        const { status, body } = await post('/api/webhooks/linear/test', JSON.stringify({}));
        expect(status).toBe(400);
        expect(body.error).toContain('identifier and agentId required');
    });
});
