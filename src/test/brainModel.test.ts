import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { resolveSmartModel } from '../server/brainModel';

const TMP = resolve(__dirname, '.brain-tmp');
const CFG = resolve(TMP, '.sdlc-framework.config.json');

function writeConfig(openrouter: boolean) {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(CFG, JSON.stringify({
        scheduler: {
            loopProvider: {
                model: 'qwen2.5-coder:14b',
                baseUrl: 'http://localhost:8083/v1',
                providerEnabled: { openrouter, mlx: true },
            },
        },
    }));
}

const ORIG_KEY = process.env.OPENROUTER_API_KEY;
const ORIG_32B = process.env.MLX_MODEL_32B;
const ORIG_BRAIN_LOCAL = process.env.BRAIN_MODEL_LOCAL;

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (ORIG_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = ORIG_KEY;
    if (ORIG_32B === undefined) delete process.env.MLX_MODEL_32B;
    else process.env.MLX_MODEL_32B = ORIG_32B;
    if (ORIG_BRAIN_LOCAL === undefined) delete process.env.BRAIN_MODEL_LOCAL;
    else process.env.BRAIN_MODEL_LOCAL = ORIG_BRAIN_LOCAL;
});

describe('resolveSmartModel (cloud-first, local-second)', () => {
    it('uses cloud when a cloud key is set and openrouter is enabled', () => {
        process.env.OPENROUTER_API_KEY = 'sk-or-test';
        writeConfig(true);
        const m = resolveSmartModel(CFG);
        expect(m.source).toBe('cloud');
        expect(m.baseUrl).toContain('openrouter.ai');
        expect(m.apiKey).toBe('sk-or-test');
    });

    it('falls back to local when there is no cloud key', () => {
        delete process.env.OPENROUTER_API_KEY;
        writeConfig(true);
        const m = resolveSmartModel(CFG);
        expect(m.source).toBe('local');
        expect(m.baseUrl).toContain('8083');
    });

    it('falls back to local when openrouter is disabled even with a key', () => {
        process.env.OPENROUTER_API_KEY = 'sk-or-test';
        writeConfig(false);
        const m = resolveSmartModel(CFG);
        expect(m.source).toBe('local');
    });

    it('brain roles escalate to the 32B locally when MLX_MODEL_32B is set, keeping the 14B baseUrl', () => {
        delete process.env.OPENROUTER_API_KEY;
        process.env.MLX_MODEL_32B = 'mlx-community/Qwen2.5-Coder-32B-Instruct-4bit';
        writeConfig(true);
        const m = resolveSmartModel(CFG);
        expect(m.source).toBe('local');
        expect(m.model).toBe('mlx-community/Qwen2.5-Coder-32B-Instruct-4bit');
        expect(m.baseUrl).toContain('8083'); // same MLX server as the 14B
    });

    it('falls back to the loop provider model (14B) when no brain model is configured', () => {
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.MLX_MODEL_32B;
        delete process.env.BRAIN_MODEL_LOCAL;
        writeConfig(true);
        const m = resolveSmartModel(CFG);
        expect(m.source).toBe('local');
        expect(m.model).toBe('qwen2.5-coder:14b');
    });
});
