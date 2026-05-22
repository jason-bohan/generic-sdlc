import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { closeDb, initDb } from '../server/db';
import { cleanup, startServer } from './helpers/server-harness';

const TMP = resolve(__dirname, '.health-tmp');

let httpServer: Awaited<ReturnType<typeof startServer>> | null = null;

async function request(path: string, init?: RequestInit) {
    const { res, body } = await httpServer!.request(path, init);
    return { res, body: body as Record<string, any> };
}

beforeEach(async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    initDb(TMP);
    httpServer = await startServer(TMP);
});

afterEach(async () => {
    if (httpServer) await httpServer.stop();
    httpServer = null;
    closeDb();
    cleanup(TMP);
});

describe('health endpoint', () => {
    it('returns 200 and reports DB as ok when healthy', async () => {
        const r = await request('/health');
        expect(r.res.status).toBe(200);
        expect(r.body).toHaveProperty('status', 'ok');
        expect(r.body).toHaveProperty('services');
        expect(r.body.services).toHaveProperty('db');
        expect(r.body.services.db).toHaveProperty('ok', true);
    });
});

