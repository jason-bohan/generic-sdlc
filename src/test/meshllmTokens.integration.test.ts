import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const TMP = resolve(__dirname, '.meshllm-tokens-tmp');

let server: Server | null = null;
let baseUrl = '';
let originalFetch: typeof fetch;

function mockMeshllmProvider(result: {
    response: string;
    model: string;
    tokens: { input: number; output: number };
    provider: 'meshllm' | 'ollama';
}) {
    vi.doMock('../server/meshllmProvider', () => ({
        getMeshllmHealth: vi.fn(async () => ({ available: result.provider === 'meshllm' })),
        meshllmGenerate: vi.fn(async () => result),
        listMeshllmModels: vi.fn(async () => []),
        isMeshllmAvailable: vi.fn(() => result.provider === 'meshllm'),
        listMeshllmNodes: vi.fn(async () => ({ nodes: [] })),
        selectMeshllmNode: vi.fn(async () => true),
    }));
}

function writeJson(path: string, value: unknown) {
    writeFileSync(path, JSON.stringify(value, null, 2));
}

function readStatus(agentId: string) {
    return JSON.parse(readFileSync(resolve(TMP, `.${agentId}-status.json`), 'utf-8'));
}

async function startServer() {
    vi.resetModules();
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

async function postGenerate() {
    const res = await originalFetch(`${baseUrl}/api/meshllm/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            agentId: 'devops',
            prompt: 'write a tiny plan',
            system: 'be brief',
            model: 'Qwen3-8B',
        }),
    });
    const body = await res.json();
    return { res, body };
}

beforeEach(() => {
    originalFetch = global.fetch;
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    writeJson(resolve(TMP, '.sdlc-framework.config.json'), { executionMode: 'balanced' });
    writeJson(resolve(TMP, '.devops-status.json'), {
        currentPhase: 'idle',
        tasks: [],
        prs: [],
        events: [],
        tokens: { cloud: { input: 10, output: 4 }, ollama: { input: 0, output: 0 } },
    });
});

afterEach(async () => {
    await stopServer();
    vi.doUnmock('../server/meshllmProvider');
    vi.resetModules();
    rmSync(TMP, { recursive: true, force: true });
});

describe('/api/meshllm/generate token tracking', () => {
    it('records successful MeshLLM generations under the meshllm token bucket', async () => {
        mockMeshllmProvider({
            response: 'mesh answer',
            model: 'Qwen3-8B',
            tokens: { input: 12, output: 7 },
            provider: 'meshllm',
        });

        await startServer();
        const { res, body } = await postGenerate();

        expect(res.status, JSON.stringify(body)).toBe(200);
        expect(body.provider).toBe('meshllm');
        expect(body.tokens).toEqual({ input: 12, output: 7 });

        const status = readStatus('devops');
        expect(status.tokens.cloud).toEqual({ input: 10, output: 4 });
        expect(status.tokens.meshllm).toEqual({ input: 12, output: 7 });
        expect(status.tokens.ollama).toEqual({ input: 0, output: 0 });
    }, 10_000);

    it('records MeshLLM fallback generations under the ollama token bucket', async () => {
        mockMeshllmProvider({
            response: 'fallback answer',
            model: 'qwen3:8b',
            tokens: { input: 9, output: 3 },
            provider: 'ollama',
        });

        await startServer();
        const { res, body } = await postGenerate();

        expect(res.status, JSON.stringify(body)).toBe(200);
        expect(body.provider).toBe('ollama');
        expect(body.tokens).toEqual({ input: 9, output: 3 });

        const status = readStatus('devops');
        expect(status.tokens.cloud).toEqual({ input: 10, output: 4 });
        expect(status.tokens.meshllm).toEqual({ input: 0, output: 0 });
        expect(status.tokens.ollama).toEqual({ input: 9, output: 3 });
    }, 10_000);
});
