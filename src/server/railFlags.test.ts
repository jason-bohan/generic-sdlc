import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { computeRailFlags, strengthForModel, deskRailFlags } from './railFlags';

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
