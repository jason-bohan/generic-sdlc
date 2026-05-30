import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
    readVerifyTriggerConfig,
    shouldTriggerVerify,
    verifyScopeFor,
    maybeTriggerVerification,
    type VerifyTriggerConfig,
} from '../server/verify-trigger';
import type { StatusChangeEvent } from '../server/status-events';

const isWin = process.platform === 'win32';
const TMP = resolve(__dirname, '.verify-trigger-tmp');
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');

function ev(agentId: string, currentPhase: string, extra: Record<string, unknown> = {}): StatusChangeEvent {
    return { agentId, status: { currentPhase, ...extra }, timestamp: new Date().toISOString() };
}

let originalHome: string | undefined;
let originalUserProfile: string | undefined;

/** Plant a fake goose CLI + the verify recipe so the spec builder resolves. */
function plantGooseAndRecipe() {
    const binDir = resolve(TMP, 'home', '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    const goosePath = resolve(binDir, isWin ? 'goose.exe' : 'goose');
    writeFileSync(goosePath, isWin ? '@echo off\r\n' : '#!/usr/bin/env sh\n');
    if (!isWin) chmodSync(goosePath, 0o755);

    const recipeDir = resolve(TMP, 'recipes');
    mkdirSync(recipeDir, { recursive: true });
    writeFileSync(resolve(recipeDir, 'verify-change.yaml'), 'version: "1.0.0"\n');
    return goosePath;
}

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
});

afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    rmSync(TMP, { recursive: true, force: true });
});

describe('readVerifyTriggerConfig', () => {
    it('is disabled when no config file exists', () => {
        expect(readVerifyTriggerConfig(resolve(TMP, 'none.json')).enabled).toBe(false);
    });

    it('enables on scheduler.verifyOnComplete and keeps default phases', () => {
        writeFileSync(CONFIG, JSON.stringify({ scheduler: { verifyOnComplete: true } }));
        const cfg = readVerifyTriggerConfig(CONFIG);
        expect(cfg.enabled).toBe(true);
        expect(cfg.phases).toEqual(['build-passed', 'complete']);
    });

    it('honours custom scheduler.verifyOnPhases', () => {
        writeFileSync(CONFIG, JSON.stringify({ scheduler: { verifyOnComplete: true, verifyOnPhases: ['pending-build'] } }));
        expect(readVerifyTriggerConfig(CONFIG).phases).toEqual(['pending-build']);
    });

    it('disabled on malformed config', () => {
        writeFileSync(CONFIG, '{ not json');
        expect(readVerifyTriggerConfig(CONFIG).enabled).toBe(false);
    });
});

describe('shouldTriggerVerify', () => {
    const enabled: VerifyTriggerConfig = { enabled: true, phases: ['build-passed', 'complete'] };

    it('false when disabled even on a trigger phase', () => {
        expect(shouldTriggerVerify(ev('backend', 'complete'), { enabled: false, phases: ['complete'] })).toBe(false);
    });

    it('true for an implementation agent on a trigger phase', () => {
        expect(shouldTriggerVerify(ev('backend', 'build-passed'), enabled)).toBe(true);
    });

    it('false on a non-trigger phase', () => {
        expect(shouldTriggerVerify(ev('backend', 'generating-code'), enabled)).toBe(false);
    });

    it('false for aiqa (the verifier itself) and orchestrator', () => {
        expect(shouldTriggerVerify(ev('aiqa', 'complete'), enabled)).toBe(false);
        expect(shouldTriggerVerify(ev('orchestrator', 'complete'), enabled)).toBe(false);
    });
});

describe('verifyScopeFor', () => {
    it('uses the story number when present', () => {
        expect(verifyScopeFor(ev('backend', 'complete', { storyNumber: 'B-42' }))).toContain('B-42');
    });
    it('defaults to the local branch diff', () => {
        expect(verifyScopeFor(ev('backend', 'complete'))).toBe('main..HEAD');
    });
});

describe('maybeTriggerVerification', () => {
    it('spawns the goose verify recipe when enabled on a trigger phase', () => {
        plantGooseAndRecipe();
        process.env.HOME = resolve(TMP, 'home');
        process.env.USERPROFILE = resolve(TMP, 'home');

        const calls: Array<{ cmd: string; args: string[] }> = [];
        const spawnImpl = ((cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            return { unref() {} };
        }) as unknown as typeof import('child_process').spawn;

        const res = maybeTriggerVerification(TMP, CONFIG, ev('backend', 'build-passed'), {
            spawnImpl,
            config: { enabled: true, phases: ['build-passed'] },
        });

        expect(res.triggered).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].args.slice(0, 2)).toEqual(['run', '--recipe']);
        expect(calls[0].args.join(' ')).toContain('--params scope=main..HEAD');
    });

    it('does not spawn when disabled', () => {
        let spawned = false;
        const spawnImpl = (() => { spawned = true; return { unref() {} }; }) as unknown as typeof import('child_process').spawn;
        const res = maybeTriggerVerification(TMP, CONFIG, ev('backend', 'complete'), {
            spawnImpl,
            config: { enabled: false, phases: ['complete'] },
        });
        expect(res.triggered).toBe(false);
        expect(spawned).toBe(false);
    });

    it('does not spawn (reports the error) when goose/recipe are missing', () => {
        process.env.HOME = resolve(TMP, 'empty-home');
        process.env.USERPROFILE = resolve(TMP, 'empty-home');
        let spawned = false;
        const spawnImpl = (() => { spawned = true; return { unref() {} }; }) as unknown as typeof import('child_process').spawn;
        const res = maybeTriggerVerification(TMP, CONFIG, ev('backend', 'complete'), {
            spawnImpl,
            config: { enabled: true, phases: ['complete'] },
        });
        expect(res.triggered).toBe(false);
        expect(spawned).toBe(false);
    });
});
