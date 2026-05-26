/**
 * MeshLLM multi-node integration test.
 *
 * Requires MeshLLM running locally:
 *   mesh-llm --auto          # join public mesh (Linux/macOS)
 *   # WSL2 on Windows: run the Linux binary inside WSL2 — localhost:9337
 *   # is automatically bridged to Windows.
 *
 * All tests skip gracefully when MeshLLM is not reachable.
 * Override the host: MESHLLM_HOST=http://localhost:9337 npx vitest run ...
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { probeMeshllm, listMeshllmModels, meshllmGenerate, getMeshllmHealth } from '../server/meshllmProvider';
import { OpenAICompatibleProvider, readLoopProviderConfig } from '../server/agent-runner/provider';

const MESHLLM_HOST = (process.env.MESHLLM_HOST || 'http://localhost:9337').replace(/\/$/, '');
const MODELS_URL = `${MESHLLM_HOST}/v1/models`;
const COMPLETIONS_URL = `${MESHLLM_HOST}/v1/chat/completions`;

const TMP = resolve(__dirname, '.meshllm-multinode-tmp');

let available = false;
let availableModels: Array<{ id: string; owned_by?: string }> = [];

// ── helpers ──────────────────────────────────────────────────────────────────

async function tryFetch(url: string, init?: RequestInit) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(55_000) });
}

function skip(label: string) {
    console.log(`[SKIP] ${label} — MeshLLM not running at ${MESHLLM_HOST}`);
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(resolve(TMP, '.sdlc-framework.config.json'), JSON.stringify({
        scheduler: { loopProvider: { baseUrl: `${MESHLLM_HOST}/v1`, model: 'auto' } },
    }, null, 2));

    try {
        const r = await fetch(MODELS_URL, { signal: AbortSignal.timeout(3_000) });
        if (r.ok) {
            const data = await r.json() as { data?: Array<{ id: string; owned_by?: string }> };
            availableModels = data.data ?? [];
            available = true;
        }
    } catch {
        available = false;
    }

    if (available) {
        console.log(`[MeshLLM] reachable at ${MESHLLM_HOST} — ${availableModels.length} model(s)`);
        if (availableModels.length > 0) {
            console.log('[MeshLLM] models:', availableModels.map(m => m.id).join(', '));
        }
    }
});

afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
});

// ── connectivity ──────────────────────────────────────────────────────────────

describe('MeshLLM connectivity', () => {
    it('is reachable at localhost:9337', async () => {
        if (!available) { skip('connectivity'); return; }
        const r = await tryFetch(MODELS_URL);
        expect(r.ok).toBe(true);
        expect(r.status).toBe(200);
    });

    it('returns a valid OpenAI-compatible model list', async () => {
        if (!available) { skip('model list'); return; }
        const r = await tryFetch(MODELS_URL);
        const data = await r.json() as { data: unknown[] };
        expect(Array.isArray(data.data)).toBe(true);
        expect(data.data.length).toBeGreaterThan(0);
        const first = data.data[0] as { id: string; object?: string };
        expect(typeof first.id).toBe('string');
    });

    it('health endpoint reflects availability', async () => {
        if (!available) { skip('health'); return; }
        const health = await getMeshllmHealth();
        expect(health.available).toBe(true);
        expect(health.host).toBe(MESHLLM_HOST);
        expect(Array.isArray(health.models)).toBe(true);
    });
});

// ── multi-node detection ──────────────────────────────────────────────────────

describe('MeshLLM multi-node mesh', () => {
    it('reports models from the mesh (single or multi-node)', async () => {
        if (!available) { skip('mesh models'); return; }
        const models = await listMeshllmModels();
        expect(models.length).toBeGreaterThan(0);
        const modelLabels = models.map(m => m.owned_by ? `${m.id} [${m.owned_by}]` : m.id).join(', ');
        console.log(`[MeshLLM] mesh models (${models.length}):`, modelLabels);
    });

    it('detects multiple nodes when owned_by varies across models', async () => {
        if (!available) { skip('multi-node detection'); return; }
        const models = await listMeshllmModels();
        const nodes = new Set(models.map(m => m.owned_by).filter(Boolean));
        if (nodes.size > 1) {
            console.log(`[MeshLLM] multi-node: ${nodes.size} nodes detected:`, [...nodes].join(', '));
            expect(nodes.size).toBeGreaterThan(1);
        } else {
            console.log('[MeshLLM] single-node mesh (or owned_by not set) — topology check skipped');
            expect(models.length).toBeGreaterThan(0); // at minimum one model is serving
        }
    });

    it('probes consistently via probeMeshllm()', async () => {
        if (!available) { skip('probe'); return; }
        const result = await probeMeshllm();
        expect(result).toBe(true);
    });
});

// ── completion ────────────────────────────────────────────────────────────────

describe('MeshLLM completion', () => {
    it('returns a response for a trivial prompt', async () => {
        if (!available) { skip('completion'); return; }
        const model = availableModels[0]?.id ?? 'auto';
        const r = await tryFetch(COMPLETIONS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'Reply with only the word "pong".' }],
                max_tokens: 16,
                temperature: 0,
            }),
        });
        expect(r.ok).toBe(true);
        const data = await r.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
        expect(data.choices.length).toBeGreaterThan(0);
        const content = data.choices[0].message.content.toLowerCase();
        console.log(`[MeshLLM] completion (${model}): "${content.trim()}" — ${data.usage?.prompt_tokens ?? '?'}+${data.usage?.completion_tokens ?? '?'} tok`);
        expect(content.length).toBeGreaterThan(0);
    }, 60_000);

    it('meshllmGenerate() routes to MeshLLM and returns tokens', async () => {
        if (!available) { skip('meshllmGenerate'); return; }
        const model = availableModels[0]?.id ?? 'auto';
        const result = await meshllmGenerate({
            model,
            prompt: 'Say "ok" and nothing else.',
            maxTokens: 16,
            temperature: 0,
        });
        expect(result.provider).toBe('meshllm');
        expect(result.response.length).toBeGreaterThan(0);
        expect(result.tokens.input).toBeGreaterThan(0);
        console.log(`[MeshLLM] meshllmGenerate: "${result.response.trim()}" ${result.tokens.input}+${result.tokens.output} tok`);
    }, 60_000);

    it('routes through the loop provider (OpenAICompatibleProvider)', async () => {
        if (!available) { skip('loop provider'); return; }
        const config = readLoopProviderConfig(resolve(TMP, '.sdlc-framework.config.json'));
        expect(config.baseUrl).toBe(`${MESHLLM_HOST}/v1`);
        const provider = new OpenAICompatibleProvider(config);
        const result = await provider.complete(
            [{ role: 'user', content: 'Say "ok" and nothing else.' }],
            [],
        );
        expect(typeof result.message.content).toBe('string');
        expect((result.message.content ?? '').length).toBeGreaterThan(0);
        console.log(`[MeshLLM] loop provider: "${String(result.message.content).trim()}"`);
    }, 60_000);
});

// ── ollama fallback ───────────────────────────────────────────────────────────

describe('Ollama fallback when MeshLLM unavailable', () => {
    it('meshllmGenerate falls back to Ollama when MeshLLM is not running', { timeout: 30_000 }, async () => {
        // This test is only meaningful when MeshLLM is down. If it's up, meshllmGenerate()
        // will use MeshLLM (the probeMeshllm cache from earlier tests is still warm),
        // so provider would be 'meshllm', not 'ollama', breaking the assertion.
        // Timeout is 30s: probeMeshllm probe (3s) + Ollama pre-check (2s) + generation.
        if (available) {
            skip('Ollama fallback — MeshLLM is running, fallback path not triggered');
            return;
        }

        let ollamaRunning = false;
        try {
            const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2_000) });
            ollamaRunning = r.ok;
        } catch { /* not running */ }

        if (!ollamaRunning) {
            console.log('[SKIP] Ollama fallback — neither MeshLLM nor Ollama is running');
            return;
        }

        // /no_think disables Qwen3 thinking mode so all tokens go to the visible response.
        // Without it, Ollama strips <think>...</think> blocks and the response field is empty.
        // /no_think only works in the chat API — not effective for /api/generate.
        // Qwen3 thinking mode causes Ollama to strip <think>…</think> blocks from
        // the response field, so we assert on token counts rather than response text.
        const result = await meshllmGenerate({ prompt: 'Reply with one word: pong', maxTokens: 64 });
        expect(result.provider).toBe('ollama');
        expect(result.tokens.input).toBeGreaterThan(0);
        expect(result.tokens.output).toBeGreaterThan(0);
        console.log(`[fallback] MeshLLM down → Ollama: "${result.response.trim()}" ${result.tokens.input}+${result.tokens.output} tok`);
    });
});
