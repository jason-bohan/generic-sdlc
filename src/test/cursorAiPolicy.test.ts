import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isCursorAiEnabled, setCursorAiEnabled, isClaudeEnabled, setClaudeEnabled } from '../server/cursor-ai-policy';
import { parseJsonUtf8File } from '../server/json-file';

const TMP = resolve(__dirname, '.cursor-ai-policy-tmp');
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    delete process.env.SDLC_FRAMEWORK_CURSOR_AI;
    delete process.env.SDLC_FRAMEWORK_CLAUDE_AI;
});

afterEach(() => {
    delete process.env.SDLC_FRAMEWORK_CURSOR_AI;
    delete process.env.SDLC_FRAMEWORK_CLAUDE_AI;
    rmSync(TMP, { recursive: true, force: true });
});

describe('Cursor AI policy', () => {
    it('defaults to disabled (opt-in required)', () => {
        expect(isCursorAiEnabled(CONFIG)).toBe(false);
    });

    it('reads cursorAiEnabled from config', () => {
        writeFileSync(CONFIG, JSON.stringify({ cursorAiEnabled: false }));
        expect(isCursorAiEnabled(CONFIG)).toBe(false);
    });

    it('lets SDLC_FRAMEWORK_CURSOR_AI=0 override config', () => {
        writeFileSync(CONFIG, JSON.stringify({ cursorAiEnabled: true }));
        process.env.SDLC_FRAMEWORK_CURSOR_AI = '0';
        expect(isCursorAiEnabled(CONFIG)).toBe(false);
    });

    it('persists the toggle without removing existing config', () => {
        writeFileSync(CONFIG, JSON.stringify({ executionMode: 'balanced', scheduler: { driver: 'cursor' } }));
        const result = setCursorAiEnabled(CONFIG, false);
        const cfg = parseJsonUtf8File(CONFIG);

        expect(result).toEqual({ enabled: false });
        expect(cfg.cursorAiEnabled).toBe(false);
        expect(cfg.executionMode).toBe('balanced');
        expect(cfg.scheduler.driver).toBe('cursor');
    });

    it('creates a config file when none exists', () => {
        setCursorAiEnabled(CONFIG, false);
        expect(existsSync(CONFIG)).toBe(true);
        expect(isCursorAiEnabled(CONFIG)).toBe(false);
    });
});

describe('Claude AI policy', () => {
    it('defaults to disabled (opt-in required)', () => {
        expect(isClaudeEnabled(CONFIG)).toBe(false);
    });

    it('reads claudeAiEnabled from config', () => {
        writeFileSync(CONFIG, JSON.stringify({ claudeAiEnabled: false }));
        expect(isClaudeEnabled(CONFIG)).toBe(false);
    });

    it('lets SDLC_FRAMEWORK_CLAUDE_AI=0 override config', () => {
        writeFileSync(CONFIG, JSON.stringify({ claudeAiEnabled: true }));
        process.env.SDLC_FRAMEWORK_CLAUDE_AI = '0';
        expect(isClaudeEnabled(CONFIG)).toBe(false);
    });

    it('persists the toggle without removing existing config', () => {
        writeFileSync(CONFIG, JSON.stringify({ executionMode: 'balanced', cursorAiEnabled: false }));
        const result = setClaudeEnabled(CONFIG, false);
        const cfg = parseJsonUtf8File(CONFIG);

        expect(result).toEqual({ enabled: false });
        expect(cfg.claudeAiEnabled).toBe(false);
        expect(cfg.executionMode).toBe('balanced');
        expect(cfg.cursorAiEnabled).toBe(false);
    });

    it('creates a config file when none exists', () => {
        setClaudeEnabled(CONFIG, false);
        expect(existsSync(CONFIG)).toBe(true);
        expect(isClaudeEnabled(CONFIG)).toBe(false);
    });
});

