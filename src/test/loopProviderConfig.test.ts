import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { readLoopProviderConfig, detectLoopProvider } from '../server/agent-runner/provider';

const TMP = resolve(tmpdir(), `loop-provider-config-test-${Date.now()}`);
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');

beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(CONFIG, JSON.stringify({
        scheduler: {
            loopProvider: {
                baseUrl: 'http://localhost:9337/v1',
                model: 'default-14b',
                maxTokens: 4096,
            },
        },
    }, null, 2));
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
});

describe('detectLoopProvider', () => {
    it('detects MLX on port 8082', () => {
        expect(detectLoopProvider('http://localhost:8082/v1')).toBe('mlx');
    });

    it('detects MLX on port 8083 (14B)', () => {
        expect(detectLoopProvider('http://localhost:8083/v1')).toBe('mlx');
    });

    it('detects MLX by hostname containing mlx', () => {
        expect(detectLoopProvider('http://mlx-host:9000/v1')).toBe('mlx');
    });

    it('detects MeshLLM on port 9337', () => {
        expect(detectLoopProvider('http://localhost:9337/v1')).toBe('meshllm');
    });

    it('detects Ollama on port 11434', () => {
        expect(detectLoopProvider('http://localhost:11434/v1')).toBe('ollama');
    });

    it('detects OpenRouter by hostname', () => {
        expect(detectLoopProvider('https://openrouter.ai/api/v1')).toBe('openrouter');
    });

    it('returns custom for unknown endpoints', () => {
        expect(detectLoopProvider('http://localhost:4000/v1')).toBe('custom');
    });
});

describe('readLoopProviderConfig', () => {
    let savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        savedEnv = {
            MLX_HOST: process.env.MLX_HOST,
            MLX_HOST_14B: process.env.MLX_HOST_14B,
            MESHLLM_HOST: process.env.MESHLLM_HOST,
            LOOP_PROVIDER_BASE_URL: process.env.LOOP_PROVIDER_BASE_URL,
        };
        delete process.env.MLX_HOST;
        delete process.env.MLX_HOST_14B;
        delete process.env.MESHLLM_HOST;
        delete process.env.LOOP_PROVIDER_BASE_URL;
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('uses the configured loop provider model by default', () => {
        const config = readLoopProviderConfig(CONFIG);

        expect(config.model).toBe('default-14b');
    });

    it('allows an agent model override to use the same provider endpoint', () => {
        const config = readLoopProviderConfig(CONFIG, 'reviewer-32b');

        expect(config.baseUrl).toBe('http://localhost:9337/v1');
        expect(config.model).toBe('reviewer-32b');
    });

    it('uses MLX_HOST when set', () => {
        process.env.MLX_HOST = 'http://localhost:8082';
        const config = readLoopProviderConfig(CONFIG);

        expect(config.baseUrl).toBe('http://localhost:9337/v1');
    });

    it('uses MLX_HOST as default base when no explicit base or meshllm host is set', () => {
        process.env.MLX_HOST = 'http://localhost:8082';
        const config = readLoopProviderConfig(resolve(TMP, 'nonexistent.json'));

        expect(config.baseUrl).toBe('http://localhost:8082/v1');
    });

    it('prefers MLX_HOST_14B over MLX_HOST when both set', () => {
        process.env.MLX_HOST = 'http://localhost:8082';
        process.env.MLX_HOST_14B = 'http://localhost:8083';
        const config = readLoopProviderConfig(resolve(TMP, 'nonexistent.json'));

        expect(config.baseUrl).toBe('http://localhost:8083/v1');
    });

    it('prefers MESHLLM_HOST over MLX_HOST', () => {
        process.env.MLX_HOST = 'http://localhost:8082';
        process.env.MESHLLM_HOST = 'http://localhost:9337';
        const config = readLoopProviderConfig(resolve(TMP, 'nonexistent.json'));

        expect(config.baseUrl).toBe('http://localhost:9337/v1');
    });
});
