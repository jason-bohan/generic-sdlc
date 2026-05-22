import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createApp } from '../../server/app';

export type TestServerHandle = {
    baseUrl: string;
    stop: () => Promise<void>;
    request: (path: string, init?: RequestInit) => Promise<{ res: Response; body: unknown }>;
};

export async function startServer(rootDir: string): Promise<TestServerHandle> {
    const server = http.createServer(createApp(rootDir));
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    return {
        baseUrl,
        stop: () =>
            new Promise<void>((resolveClose, reject) => {
                server.close((err) => (err ? reject(err) : resolveClose()));
            }),
        request: async (path: string, init?: RequestInit) => {
            const res = await fetch(`${baseUrl}${path}`, {
                ...init,
                headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
            });
            const text = await res.text();
            const body = text ? JSON.parse(text) : null;
            return { res, body };
        },
    };
}

export function writeJson(filePath: string, data: unknown): void {
    writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function readJson<T = Record<string, any>>(filePath: string): T {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

export function cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}
