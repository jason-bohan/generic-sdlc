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

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (ORIG_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = ORIG_KEY;
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
});
