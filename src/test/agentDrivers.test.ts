import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
    buildAiderSpawnSpec,
    buildClaudeCodeSpawnSpec,
    buildCursorSpawnSpec,
    buildGenericSpawnSpec,
    buildGooseSpawnSpec,
    buildSpawnSpec,
    findAiderCli,
    readDriverConfig,
    resolveCursorSafeDriverConfig,
    runInlineQuery,
    type AgentDriverConfig,
} from '../server/agent-drivers';

const TMP = resolve(__dirname, '.agent-drivers-tmp');
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');
const OUTPUT = resolve(TMP, '.agent-output');
const PROMPT_FILE = resolve(TMP, 'prompt.txt');
const FAKE_BIN = resolve(TMP, 'fake-bin');

let originalPath: string | undefined;

function writeConfig(partial: object) {
    writeFileSync(CONFIG, JSON.stringify(partial));
}

function prependPath(path: string) {
    process.env.PATH = `${path};${originalPath ?? ''}`;
}

function writeFakeAider() {
    mkdirSync(FAKE_BIN, { recursive: true });
    const fakeAider = resolve(FAKE_BIN, isWin ? 'aider.cmd' : 'aider');
    writeFileSync(fakeAider, isWin ? '@echo off\r\nexit /b 0\r\n' : '#!/usr/bin/env sh\nexit 0\n');
    return fakeAider;
}

beforeEach(() => {
    originalPath = process.env.PATH;
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(OUTPUT, { recursive: true });
    writeFileSync(PROMPT_FILE, 'test prompt');
});

afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(TMP, { recursive: true, force: true });
});

// ─── readDriverConfig ─────────────────────────────────────────────────────────

describe('readDriverConfig', () => {
    it('defaults to cursor when no config file exists', () => {
        const cfg = readDriverConfig(resolve(TMP, 'nonexistent.json'));
        expect(cfg.type).toBe('cursor');
    });

    it('reads cursor driver', () => {
        writeConfig({ scheduler: { driver: 'cursor' } });
        expect(readDriverConfig(CONFIG).type).toBe('cursor');
    });

    it('reads claude-code driver', () => {
        writeConfig({ scheduler: { driver: 'claude-code' } });
        expect(readDriverConfig(CONFIG).type).toBe('claude-code');
    });

    it('reads aider driver', () => {
        writeConfig({ scheduler: { driver: 'aider' } });
        expect(readDriverConfig(CONFIG).type).toBe('aider');
    });

    it('reads goose driver', () => {
        writeConfig({ scheduler: { driver: 'goose' } });
        expect(readDriverConfig(CONFIG).type).toBe('goose');
    });

    it('reads generic driver with config', () => {
        writeConfig({
            scheduler: {
                driver: 'generic',
                genericDriver: { command: 'my-cli', args: ['{prompt}'] },
            },
        });
        const cfg = readDriverConfig(CONFIG);
        expect(cfg.type).toBe('generic');
        expect(cfg.generic?.command).toBe('my-cli');
    });

    it('falls back to cursor for unknown driver values', () => {
        writeConfig({ scheduler: { driver: 'windsurf' } });
        expect(readDriverConfig(CONFIG).type).toBe('cursor');
    });

    it('falls back to cursor on malformed JSON', () => {
        writeFileSync(CONFIG, '{ bad json }');
        expect(readDriverConfig(CONFIG).type).toBe('cursor');
    });

    it('routes configured cursor driver away from cursor when Cursor AI is disabled', () => {
        writeConfig({ cursorAiEnabled: false, scheduler: { driver: 'cursor' } });
        expect(readDriverConfig(CONFIG).type).toBe('cursor');
        // Falls back to aider (if installed), goose (if installed), or loop
        const resolved = resolveCursorSafeDriverConfig(CONFIG).type;
        expect(resolved).not.toBe('cursor');
        expect(['aider', 'goose', 'loop']).toContain(resolved);
    });

    it.skipIf(!isWin)('prefers aider when Cursor AI is disabled and aider is on PATH', () => {
        writeFakeAider();
        prependPath(FAKE_BIN);
        writeConfig({ cursorAiEnabled: false, scheduler: { driver: 'cursor' } });

        expect(resolveCursorSafeDriverConfig(CONFIG).type).toBe('aider');
    });

    it.skipIf(!isWin)('prefers aider when Claude Code is disabled and aider is on PATH', () => {
        writeFakeAider();
        prependPath(FAKE_BIN);
        writeConfig({ claudeAiEnabled: false, scheduler: { driver: 'claude-code' } });

        expect(resolveCursorSafeDriverConfig(CONFIG).type).toBe('aider');
    });

    it('keeps non-Cursor drivers when Cursor AI is disabled', () => {
        writeConfig({ cursorAiEnabled: false, scheduler: { driver: 'claude-code' } });
        expect(resolveCursorSafeDriverConfig(CONFIG).type).toBe('claude-code');
    });
});

const isWin = process.platform === 'win32';

// ─── buildCursorSpawnSpec ─────────────────────────────────────────────────────

describe('buildCursorSpawnSpec', () => {
    it.skipIf(!isWin)('uses run-agent.ps1 driver script when present', () => {
        const binDir = resolve(TMP, 'bin');
        mkdirSync(binDir, { recursive: true });
        const driverScript = resolve(binDir, 'run-agent.ps1');
        writeFileSync(driverScript, '# stub');

        const spec = buildCursorSpawnSpec('frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);
        expect('error' in spec).toBe(false);
        if ('error' in spec) return;

        expect(spec.cmd.toLowerCase()).toMatch(/cmd\.exe$/);
        expect(spec.args).toContain('/c');
        expect(spec.ignoreStdio).toBe(true);
    });

    it.skipIf(isWin)('requires Windows when run-agent.ps1 is present on Linux', () => {
        const binDir = resolve(TMP, 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(resolve(binDir, 'run-agent.ps1'), '# stub');

        const spec = buildCursorSpawnSpec('frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);
        expect('error' in spec).toBe(true);
        if ('error' in spec) expect(spec.error).toContain('requires Windows');
    });

    it('returns error when cursor CLI and driver script are both missing', () => {
        // No bin/run-agent.ps1 and LOCALAPPDATA won't have cursor-agent
        const spec = buildCursorSpawnSpec('frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);
        // Either succeeds (if cursor CLI happens to be installed) or returns error
        if ('error' in spec) {
            expect(spec.error).toMatch(/Cursor CLI/);
        }
    });
});

// ─── buildClaudeCodeSpawnSpec ─────────────────────────────────────────────────

describe('buildClaudeCodeSpawnSpec', () => {
    it('returns an error when the claude driver cannot run', () => {
        const spec = buildClaudeCodeSpawnSpec('frontend', TMP, PROMPT_FILE, undefined, OUTPUT);
        expect('error' in spec).toBe(true);
        if ('error' in spec && isWin) {
            expect(spec.error).toContain('run-agent-claude.ps1');
        }
    });

    it.skipIf(!isWin)('creates a launcher .cmd when run-agent-claude.ps1 exists', () => {
        const binDir = resolve(TMP, 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(resolve(binDir, 'run-agent-claude.ps1'), '# stub');

        const spec = buildClaudeCodeSpawnSpec('frontend', TMP, PROMPT_FILE, 'claude-sonnet-4-6', OUTPUT);
        expect('error' in spec).toBe(false);
        if ('error' in spec) return;

        expect(spec.cmd.toLowerCase()).toMatch(/cmd\.exe$/);
        expect(spec.ignoreStdio).toBe(true);

        const launcherPath = resolve(OUTPUT, 'frontend-claude-launcher.cmd');
        expect(existsSync(launcherPath)).toBe(true);
        const content = require('fs').readFileSync(launcherPath, 'utf-8');
        expect(content).toContain('run-agent-claude.ps1');
        expect(content).toContain('claude-sonnet-4-6');
    });

    it.skipIf(!isWin)('omits model arg when model is auto', () => {
        const binDir = resolve(TMP, 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(resolve(binDir, 'run-agent-claude.ps1'), '# stub');

        buildClaudeCodeSpawnSpec('frontend', TMP, PROMPT_FILE, 'auto', OUTPUT);
        const content = require('fs').readFileSync(resolve(OUTPUT, 'frontend-claude-launcher.cmd'), 'utf-8');
        expect(content).not.toContain('-Model');
    });

    it.skipIf(isWin)('requires Windows when run-agent-claude.ps1 exists on Linux', () => {
        const binDir = resolve(TMP, 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(resolve(binDir, 'run-agent-claude.ps1'), '# stub');

        const spec = buildClaudeCodeSpawnSpec('frontend', TMP, PROMPT_FILE, 'claude-sonnet-4-6', OUTPUT);
        expect('error' in spec).toBe(true);
        if ('error' in spec) expect(spec.error).toContain('Windows');
    });
});

// ─── buildGooseSpawnSpec ──────────────────────────────────────────────────────

describe('buildGooseSpawnSpec', () => {
    it('returns error when goose.exe is not found', () => {
        const spec = buildGooseSpawnSpec('do work', TMP);
        // Only fails if goose isn't actually installed at the default path
        if ('error' in spec) {
            expect(spec.error).toContain('Goose CLI');
        }
    });
});

// ─── Aider ───────────────────────────────────────────────────────────────────

describe('Aider driver', () => {
    it.skipIf(!isWin)('finds aider on PATH', () => {
        const fakeAider = writeFakeAider();
        prependPath(FAKE_BIN);

        expect(findAiderCli()?.toLowerCase()).toBe(fakeAider.toLowerCase());
    });

    it.skipIf(!isWin)('creates a PowerShell launcher using MeshLLM with Ollama fallback', () => {
        const fakeAider = writeFakeAider();
        prependPath(FAKE_BIN);

        const spec = buildAiderSpawnSpec('frontend', TMP, PROMPT_FILE, 'auto', OUTPUT);

        expect('error' in spec).toBe(false);
        if ('error' in spec) return;
        expect(spec.cmd.toLowerCase()).toMatch(/powershell\.exe$/);
        expect(spec.args).toEqual(expect.arrayContaining(['-NoProfile', '-ExecutionPolicy', 'Bypass']));
        expect(spec.ignoreStdio).toBe(true);

        const launcher = readFileSync(resolve(OUTPUT, 'frontend-aider-launcher.ps1'), 'utf-8');
        expect(launcher).toContain(`Set-Location -LiteralPath '${TMP.replace(/'/g, "''")}'`);
        expect(launcher).toContain(`& '${fakeAider.replace(/'/g, "''")}'`);
        expect(launcher).toContain("--model 'openai/qwen3:8b'");
        expect(launcher).toContain("--openai-api-base 'http://localhost:9337/v1'");
        expect(launcher).toContain("--openai-api-base 'http://127.0.0.1:11434/v1'");
        expect(launcher).toContain("--message-file");
        expect(launcher).toContain("--no-auto-commits");
    });

    it.skipIf(!isWin)('uses an explicit model instead of auto default', () => {
        writeFakeAider();
        prependPath(FAKE_BIN);

        const spec = buildAiderSpawnSpec('qa', TMP, PROMPT_FILE, 'sdlc-tuned', OUTPUT);

        expect('error' in spec).toBe(false);
        const launcher = readFileSync(resolve(OUTPUT, 'qa-aider-launcher.ps1'), 'utf-8');
        expect(launcher).toContain("--model 'openai/sdlc-tuned'");
        expect(launcher).not.toContain("--model 'openai/qwen3:8b'");
    });

    it('routes aider driver through aider spec', () => {
        const cfg: AgentDriverConfig = { type: 'aider' };
        const spec = buildSpawnSpec(cfg, 'frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);
        if ('error' in spec) {
            expect(spec.error).toMatch(/Aider|Windows|PowerShell/);
        } else {
            expect(spec.cmd.toLowerCase()).toMatch(/powershell\.exe$/);
        }
    });
});

// ─── buildGenericSpawnSpec ────────────────────────────────────────────────────

describe('buildGenericSpawnSpec', () => {
    it('returns error when no generic config provided', () => {
        const spec = buildGenericSpawnSpec(undefined, 'frontend', 'prompt', TMP, PROMPT_FILE, undefined);
        expect('error' in spec).toBe(true);
        if ('error' in spec) expect(spec.error).toContain('genericDriver');
    });

    it('interpolates all placeholders', () => {
        const spec = buildGenericSpawnSpec(
            { command: 'my-cli', args: ['{agentId}', '{prompt}', '{promptFile}', '{workspaceDir}', '{model}'] },
            'frontend',
            'do work',
            TMP,
            PROMPT_FILE,
            'gpt-5',
        );
        expect('error' in spec).toBe(false);
        if ('error' in spec) return;

        expect(spec.cmd).toBe('my-cli');
        expect(spec.args[0]).toBe('frontend');
        expect(spec.args[1]).toBe('do work');
        expect(spec.args[2]).toBe(PROMPT_FILE);
        expect(spec.args[3]).toBe(TMP);
        expect(spec.args[4]).toBe('gpt-5');
    });

    it('substitutes auto for missing model', () => {
        const spec = buildGenericSpawnSpec(
            { command: 'cli', args: ['{model}'] },
            'qa', 'test', TMP, PROMPT_FILE, undefined,
        );
        expect('error' in spec).toBe(false);
        if ('error' in spec) return;
        expect(spec.args[0]).toBe('auto');
    });
});

// ─── buildSpawnSpec dispatcher ────────────────────────────────────────────────

describe('buildSpawnSpec', () => {
    it('routes cursor driver to cursor spec', () => {
        const cfg: AgentDriverConfig = { type: 'cursor' };
        const spec = buildSpawnSpec(cfg, 'frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);
        // Either a valid spec or an error about missing CLI — just confirm it ran the cursor path
        if (!('error' in spec)) {
            // If cursor CLI is present, it should return a cmd/args
            expect(spec.cmd).toBeTruthy();
        } else {
            expect(spec.error).toMatch(/Cursor CLI/);
        }
    });

    it('routes claude-code driver through claude spec', () => {
        const cfg: AgentDriverConfig = { type: 'claude-code' };
        const spec = buildSpawnSpec(cfg, 'frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);
        expect('error' in spec).toBe(true);
        if ('error' in spec) {
            expect(isWin ? spec.error.includes('run-agent-claude.ps1') : spec.error.includes('Windows')).toBe(true);
        }
    });

    it('routes goose driver through goose spec', () => {
        const cfg: AgentDriverConfig = { type: 'goose' };
        const spec = buildSpawnSpec(cfg, 'frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);
        if ('error' in spec) {
            expect(spec.error).toContain('Goose CLI');
        } else {
            expect(spec.cmd).toContain('goose');
        }
    });

    it('routes generic driver through generic spec', () => {
        const cfg: AgentDriverConfig = {
            type: 'generic',
            generic: { command: 'my-agent', args: ['--prompt', '{promptFile}'] },
        };
        const spec = buildSpawnSpec(cfg, 'frontend', 'do work', TMP, PROMPT_FILE, 'auto', OUTPUT);
        expect('error' in spec).toBe(false);
        if ('error' in spec) return;
        expect(spec.cmd).toBe('my-agent');
        expect(spec.args).toContain(PROMPT_FILE);
    });

    it('returns generic error for missing generic config', () => {
        const cfg: AgentDriverConfig = { type: 'generic' };
        const spec = buildSpawnSpec(cfg, 'frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);
        expect('error' in spec).toBe(true);
    });
});

describe('runInlineQuery with Cursor AI disabled', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('uses the configured OpenAI-compatible loop provider instead of Cursor', async () => {
        writeConfig({
            cursorAiEnabled: false,
            scheduler: {
                driver: 'cursor',
                loopProvider: {
                    baseUrl: 'http://provider.test/v1',
                    model: 'deepseek/deepseek-chat',
                    apiKey: 'test-key',
                },
            },
        });
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { role: 'assistant', content: 'loop reply' }, finish_reason: 'stop' }],
            }),
        })) as unknown as typeof fetch;
        global.fetch = fetchMock;

        await expect(runInlineQuery('hello', TMP, CONFIG)).resolves.toBe('loop reply');
        expect(fetchMock).toHaveBeenCalledWith(
            'http://provider.test/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
            }),
        );
    });
});
