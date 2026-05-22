import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';
import { resetUserProfileStoreForTests } from '../server/user-profile-store';

const TMP = resolve(__dirname, '.user-profile-tmp');

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

async function request(path: string, init?: RequestInit): Promise<{ res: Response; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    return { res, body };
}

beforeEach(async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    initDb(TMP);
    resetUserProfileStoreForTests();
    await startServer();
});

afterEach(async () => {
    await stopServer();
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
    resetUserProfileStoreForTests();
});

describe('/api/user-profile', () => {
    it('returns default profile on GET', async () => {
        const { res, body } = await request('/api/user-profile');
        expect(res.status).toBe(200);
        expect(body).toMatchObject({
            displayName: expect.stringMatching(/./),
            email: expect.stringMatching(/./),
            bio: expect.any(String),
            avatarUrl: null,
        });
    });

    it('merges fields on PUT', async () => {
        const put = await request('/api/user-profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                displayName: 'Ada Lovelace',
                email: 'ada@localhost',
                bio: 'Writes notes.',
                avatarUrl: null,
            }),
        });
        expect(put.res.status).toBe(200);
        expect(put.body).toMatchObject({
            displayName: 'Ada Lovelace',
            email: 'ada@localhost',
            bio: 'Writes notes.',
            avatarUrl: null,
        });

        const get = await request('/api/user-profile');
        expect(get.body).toMatchObject({ displayName: 'Ada Lovelace' });
    });
});
