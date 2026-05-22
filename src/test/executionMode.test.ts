import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getExecMode, isValidMode } from '../server/modes';

const TMP_CONFIG = resolve(__dirname, '.test-exec-mode-config.json');

afterEach(() => {
    if (existsSync(TMP_CONFIG)) unlinkSync(TMP_CONFIG);
});

describe('getExecMode', () => {
    it('returns "balanced" when config file does not exist', () => {
        expect(getExecMode('/nonexistent/path/config.json')).toBe('balanced');
    });

    it('returns "balanced" when config is empty JSON', () => {
        writeFileSync(TMP_CONFIG, '{}');
        expect(getExecMode(TMP_CONFIG)).toBe('balanced');
    });

    it('returns "balanced" when executionMode is missing', () => {
        writeFileSync(TMP_CONFIG, JSON.stringify({ project: {} }));
        expect(getExecMode(TMP_CONFIG)).toBe('balanced');
    });

    it('returns "balanced" when executionMode is invalid', () => {
        writeFileSync(TMP_CONFIG, JSON.stringify({ executionMode: 'turbo' }));
        expect(getExecMode(TMP_CONFIG)).toBe('balanced');
    });

    it('returns "balanced" when config is corrupt / not JSON', () => {
        writeFileSync(TMP_CONFIG, 'not json at all {{{');
        expect(getExecMode(TMP_CONFIG)).toBe('balanced');
    });

    it('reads "local" correctly', () => {
        writeFileSync(TMP_CONFIG, JSON.stringify({ executionMode: 'local' }));
        expect(getExecMode(TMP_CONFIG)).toBe('local');
    });

    it('reads "balanced" correctly', () => {
        writeFileSync(TMP_CONFIG, JSON.stringify({ executionMode: 'balanced' }));
        expect(getExecMode(TMP_CONFIG)).toBe('balanced');
    });

    it('reads "speed" correctly', () => {
        writeFileSync(TMP_CONFIG, JSON.stringify({ executionMode: 'speed' }));
        expect(getExecMode(TMP_CONFIG)).toBe('speed');
    });
});

describe('isValidMode', () => {
    it('accepts local, balanced, speed', () => {
        expect(isValidMode('local')).toBe(true);
        expect(isValidMode('balanced')).toBe(true);
        expect(isValidMode('speed')).toBe(true);
    });

    it('rejects invalid values', () => {
        expect(isValidMode('turbo')).toBe(false);
        expect(isValidMode('')).toBe(false);
        expect(isValidMode('LOCAL')).toBe(false);
    });
});
