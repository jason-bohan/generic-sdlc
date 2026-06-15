import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
    computeRailFlags, strengthForModel, deskRailFlags, decayStrength,
    learnedStrengthFrom, recordRunOutcome, readModelStats, resolveBaseStrength, resolveModelId, LEARNED_STRENGTH_MIN_SAMPLES,
} from './railFlags';

describe('learnedStrengthFrom (Phase 3)', () => {
    it('returns undefined below the sample threshold', () => {
        expect(learnedStrengthFrom({ runs: LEARNED_STRENGTH_MIN_SAMPLES - 1, cleanRuns: 4, stalledRuns: 0, devLoopStartsTotal: 0 })).toBeUndefined();
    });
    it('clean record with little bouncing → strong', () => {
        expect(learnedStrengthFrom({ runs: 10, cleanRuns: 9, stalledRuns: 1, devLoopStartsTotal: 5 })).toBe('strong');
    });
    it('decent record → mid', () => {
        expect(learnedStrengthFrom({ runs: 10, cleanRuns: 6, stalledRuns: 4, devLoopStartsTotal: 40 })).toBe('mid');
    });
    it('poor record → weak', () => {
        expect(learnedStrengthFrom({ runs: 10, cleanRuns: 2, stalledRuns: 8, devLoopStartsTotal: 70 })).toBe('weak');
    });
});

describe('recordRunOutcome / readModelStats / resolveBaseStrength (Phase 3, file-backed)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'modelstats-')); mkdirSync(resolve(dir, '.sdlc-framework')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('accumulates outcomes per model', () => {
        recordRunOutcome(dir, 'm1', { stalled: false, devLoopStarts: 1 });
        recordRunOutcome(dir, 'm1', { stalled: true, devLoopStarts: 9 });
        const s = readModelStats(dir, 'm1');
        expect(s).toEqual({ runs: 2, cleanRuns: 1, stalledRuns: 1, devLoopStartsTotal: 10 });
    });
    it('no model → no-op', () => {
        recordRunOutcome(dir, undefined, { stalled: true, devLoopStarts: 5 });
        expect(readModelStats(dir, 'whatever').runs).toBe(0);
    });
    it('resolveBaseStrength prefers learned history over the config prior', () => {
        writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ agentStrength: { m2: 'strong' } }));
        // m2 is configured strong, but a poor track record demotes it once there's enough data
        for (let i = 0; i < 6; i++) recordRunOutcome(dir, 'm2', { stalled: true, devLoopStarts: 9 });
        expect(resolveBaseStrength('m2', resolve(dir, 'config.json'), dir)).toBe('weak');
    });
    it('resolveBaseStrength falls back to config when history is thin', () => {
        writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ agentStrength: { m3: 'mid' } }));
        recordRunOutcome(dir, 'm3', { stalled: false, devLoopStarts: 0 }); // 1 run < threshold
        expect(resolveBaseStrength('m3', resolve(dir, 'config.json'), dir)).toBe('mid');
    });
});

describe('resolveModelId (auto → concrete loop-provider model)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'resolvemodel-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
    const writeConfig = (obj: unknown) => writeFileSync(resolve(dir, 'config.json'), JSON.stringify(obj));

    it("resolves 'auto'/'default'/'' to scheduler.loopProvider.model", () => {
        writeConfig({ scheduler: { loopProvider: { model: 'openai/gpt-oss-120b:free' } } });
        const cfg = resolve(dir, 'config.json');
        expect(resolveModelId('auto', cfg)).toBe('openai/gpt-oss-120b:free');
        expect(resolveModelId('Default', cfg)).toBe('openai/gpt-oss-120b:free');
        expect(resolveModelId('', cfg)).toBe('openai/gpt-oss-120b:free');
    });
    it('leaves a concrete model id unchanged', () => {
        writeConfig({ scheduler: { loopProvider: { model: 'x' } } });
        expect(resolveModelId('mistral-large-latest', resolve(dir, 'config.json'))).toBe('mistral-large-latest');
    });
    it("returns 'auto' when no loopProvider model is configured", () => {
        writeConfig({});
        expect(resolveModelId('auto', resolve(dir, 'config.json'))).toBe('auto');
    });
    it("resolveBaseStrength scores an 'auto' agent at the loop-provider model's tier (not weak)", () => {
        // The original bug: 'auto' fell through to _default ('weak'). Now it resolves
        // 'auto' → 'openai/gpt-oss-120b:free' → (suffix-tolerant) → 'mid'.
        writeConfig({
            agentStrength: { 'openai/gpt-oss-120b': 'mid', _default: 'weak' },
            scheduler: { loopProvider: { model: 'openai/gpt-oss-120b:free' } },
        });
        expect(resolveBaseStrength('auto', resolve(dir, 'config.json'), dir)).toBe('mid');
    });
});

describe('decayStrength (Phase 2)', () => {
    it('keeps strength below the first threshold', () => {
        expect(decayStrength('strong', 0)).toBe('strong');
        expect(decayStrength('strong', 2)).toBe('strong');
    });
    it('demotes one tier at 3 dev-loop starts, two at 6', () => {
        expect(decayStrength('strong', 3)).toBe('mid');
        expect(decayStrength('strong', 6)).toBe('weak');
        expect(decayStrength('mid', 3)).toBe('weak');
    });
    it('clamps at weak and only tightens', () => {
        expect(decayStrength('weak', 99)).toBe('weak');
        expect(decayStrength('mid', 6)).toBe('weak');
    });
});

describe('computeRailFlags', () => {
    it('strong → only the always-on rails', () => {
        expect(new Set(computeRailFlags('strong'))).toEqual(new Set(['behaviorGate', 'devLoopPauseCap']));
    });
    it('mid → adds the code-quality rails but not forward-progress coercion', () => {
        const mid = new Set(computeRailFlags('mid'));
        expect(mid.has('emptyCodeGenGate')).toBe(true);
        expect(mid.has('idempotentFixPrompt')).toBe(true);
        expect(mid.has('commitAmend')).toBe(true);
        expect(mid.has('forwardProgressCoerce')).toBe(false); // weak-only
    });
    it('weak → every rail', () => {
        expect(computeRailFlags('weak')).toHaveLength(7);
        expect(new Set(computeRailFlags('weak')).has('forwardProgressCoerce')).toBe(true);
    });
});

describe('strengthForModel + deskRailFlags (file-backed)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'railflags-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    const writeConfig = (obj: unknown) => writeFileSync(resolve(dir, 'config.json'), JSON.stringify(obj));

    it('maps a configured model to its strength', () => {
        writeConfig({ agentStrength: { 'claude-x': 'strong', _default: 'weak' } });
        expect(strengthForModel('claude-x', resolve(dir, 'config.json'))).toBe('strong');
    });
    it('falls back to _default for an unknown model', () => {
        writeConfig({ agentStrength: { _default: 'mid' } });
        expect(strengthForModel('who-dis', resolve(dir, 'config.json'))).toBe('mid');
    });
    it('defaults to weak with no config / no agentStrength', () => {
        expect(strengthForModel('x', resolve(dir, 'missing.json'))).toBe('weak');
        writeConfig({});
        expect(strengthForModel('x', resolve(dir, 'config.json'))).toBe('weak');
    });
    it('tolerates a provider variant suffix (e.g. :free)', () => {
        writeConfig({ agentStrength: { 'openai/gpt-oss-120b': 'mid', _default: 'weak' } });
        expect(strengthForModel('openai/gpt-oss-120b:free', resolve(dir, 'config.json'))).toBe('mid');
    });

    it('deskRailFlags reads the flags written on the desk', () => {
        writeFileSync(resolve(dir, '.backend-status.json'), JSON.stringify({ railFlags: ['behaviorGate', 'devLoopPauseCap'] }));
        const flags = deskRailFlags('backend', dir);
        expect(flags.has('behaviorGate')).toBe(true);
        expect(flags.has('emptyCodeGenGate')).toBe(false);
    });
    it('deskRailFlags fails safe to the weak set when the desk has none', () => {
        writeFileSync(resolve(dir, '.backend-status.json'), JSON.stringify({}));
        expect(deskRailFlags('backend', dir).size).toBe(7);
    });
    it('deskRailFlags fails safe to the weak set when there is no desk', () => {
        expect(deskRailFlags('frontend', dir).size).toBe(7);
    });
});
