import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { readLoopProviderConfig } from '../server/agent-runner/provider';

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

describe('readLoopProviderConfig', () => {
    it('uses the configured loop provider model by default', () => {
        const config = readLoopProviderConfig(CONFIG);

        expect(config.model).toBe('default-14b');
    });

    it('allows an agent model override to use the same provider endpoint', () => {
        const config = readLoopProviderConfig(CONFIG, 'reviewer-32b');

        expect(config.baseUrl).toBe('http://localhost:9337/v1');
        expect(config.model).toBe('reviewer-32b');
    });
});
