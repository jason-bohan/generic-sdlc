import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { shouldSuppressAgentSpawn, setTestRunnerActive } from '../server/spawn-agent';

const TMP = resolve(__dirname, '.spawn-suppress-tmp');

describe('shouldSuppressAgentSpawn', () => {
    const prevVitest = process.env.VITEST;
    const prevE2e = process.env.SDLC_FRAMEWORK_E2E;
    const prevAllow = process.env.SDLC_FRAMEWORK_ALLOW_AGENT_SPAWN;

    beforeEach(() => {
        mkdirSync(TMP, { recursive: true });
        writeFileSync(
            resolve(TMP, '.sdlc-framework.config.json'),
            JSON.stringify({ externalMode: 'mock' }, null, 2),
        );
    });

    afterEach(() => {
        rmSync(TMP, { recursive: true, force: true });
        setTestRunnerActive(false);
        if (prevVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = prevVitest;
        if (prevE2e === undefined) delete process.env.SDLC_FRAMEWORK_E2E;
        else process.env.SDLC_FRAMEWORK_E2E = prevE2e;
        if (prevAllow === undefined) delete process.env.SDLC_FRAMEWORK_ALLOW_AGENT_SPAWN;
        else process.env.SDLC_FRAMEWORK_ALLOW_AGENT_SPAWN = prevAllow;
    });

    it('suppresses in mock mode when VITEST or SDLC_FRAMEWORK_E2E is set', () => {
        process.env.VITEST = '1';
        expect(shouldSuppressAgentSpawn(TMP)).toBe(true);
        delete process.env.VITEST;
        process.env.SDLC_FRAMEWORK_E2E = '1';
        expect(shouldSuppressAgentSpawn(TMP)).toBe(true);
    });

    it('does not suppress live mode', () => {
        process.env.VITEST = '1';
        writeFileSync(
            resolve(TMP, '.sdlc-framework.config.json'),
            JSON.stringify({ externalMode: 'live' }, null, 2),
        );
        expect(shouldSuppressAgentSpawn(TMP)).toBe(false);
    });

    it('honors test runner latch and SDLC_FRAMEWORK_ALLOW_AGENT_SPAWN', () => {
        process.env.VITEST = '1';
        setTestRunnerActive(true);
        expect(shouldSuppressAgentSpawn(TMP)).toBe(true);
        setTestRunnerActive(false);
        process.env.SDLC_FRAMEWORK_ALLOW_AGENT_SPAWN = '1';
        expect(shouldSuppressAgentSpawn(TMP)).toBe(false);
    });
});
