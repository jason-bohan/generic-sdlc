import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
    buildAiderSpawnSpec,
    buildClaudeCodeSpawnSpec,
    buildCursorSpawnSpec,
    buildGenericSpawnSpec,
    buildGooseSpawnSpec,
    buildGooseRecipeSpawnSpec,
    buildGooseVerifySpawnSpec,
    buildOpenCodeSpawnSpec,
    buildSpawnSpec,
    findAiderCli,
    findOpenCodeCli,
    readDriverConfig,
    resolveAgentDriverConfig,
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
    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${path}${sep}${originalPath ?? ''}`;
}

function writeFakeAider() {
    mkdirSync(FAKE_BIN, { recursive: true });
    const fakeAider = resolve(FAKE_BIN, isWin ? 'aider.cmd' : 'aider');
    writeFileSync(fakeAider, isWin ? '@echo off\r\nexit /b 0\r\n' : '#!/usr/bin/env sh\nexit 0\n');
    if (!isWin) chmodSync(fakeAider, 0o755);
    return fakeAider;
}

function writeFakeOpenCode() {
    mkdirSync(FAKE_BIN, { recursive: true });
    const fakeOpenCode = resolve(FAKE_BIN, isWin ? 'opencode.cmd' : 'opencode');
    writeFileSync(fakeOpenCode, isWin ? '@echo off\r\nexit /b 0\r\n' : '#!/usr/bin/env sh\nexit 0\n');
    if (!isWin) chmodSync(fakeOpenCode, 0o755);
    return fakeOpenCode;
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
    it('defaults to loop when no config file exists', () => {
        const cfg = readDriverConfig(resolve(TMP, 'nonexistent.json'));
        expect(cfg.type).toBe('loop');
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

    it('falls back to loop for unknown driver values', () => {
        writeConfig({ scheduler: { driver: 'windsurf' } });
        expect(readDriverConfig(CONFIG).type).toBe('loop');
    });

    it('falls back to loop on malformed JSON', () => {
        writeFileSync(CONFIG, '{ bad json }');
        expect(readDriverConfig(CONFIG).type).toBe('loop');
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
        writeConfig({ cursorAiEnabled: false, claudeAiEnabled: true, scheduler: { driver: 'claude-code' } });
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

    it.skipIf(isWin)('uses the bash launcher on macOS/Linux when run-agent-claude.sh exists', () => {
        const binDir = resolve(TMP, 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(resolve(binDir, 'run-agent-claude.sh'), '#!/usr/bin/env bash\n');

        const spec = buildClaudeCodeSpawnSpec('frontend', TMP, PROMPT_FILE, 'claude-sonnet-4-6', OUTPUT);
        expect('error' in spec).toBe(false);
        if ('error' in spec) return;

        expect(spec.cmd).toBe('/bin/bash');
        expect(spec.ignoreStdio).toBe(true);
        expect(spec.args[0]).toMatch(/run-agent-claude\.sh$/);
        // positional contract: <script> <agentId> <promptFile> <workspaceDir> <model>
        expect(spec.args).toEqual([
            resolve(binDir, 'run-agent-claude.sh'), 'frontend', PROMPT_FILE, TMP, 'claude-sonnet-4-6',
        ]);
    });

    it.skipIf(isWin)('passes model "auto" through to the bash launcher', () => {
        const binDir = resolve(TMP, 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(resolve(binDir, 'run-agent-claude.sh'), '#!/usr/bin/env bash\n');

        const spec = buildClaudeCodeSpawnSpec('frontend', TMP, PROMPT_FILE, 'auto', OUTPUT);
        expect('error' in spec).toBe(false);
        if ('error' in spec) return;
        expect(spec.args[spec.args.length - 1]).toBe('auto');
    });

    it.skipIf(isWin)('errors when run-agent-claude.sh is missing on macOS/Linux', () => {
        const spec = buildClaudeCodeSpawnSpec('frontend', TMP, PROMPT_FILE, 'claude-sonnet-4-6', OUTPUT);
        expect('error' in spec).toBe(true);
        if ('error' in spec) expect(spec.error).toContain('run-agent-claude.sh');
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

// ─── Goose recipe driver (verify-change wiring) ───────────────────────────────

describe('buildGooseRecipeSpawnSpec / buildGooseVerifySpawnSpec', () => {
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;

    // Plant a fake goose under a temp HOME so findGooseCli resolves deterministically,
    // independent of whether goose is actually installed on the test machine.
    function plantFakeGoose(): string {
        const binDir = resolve(TMP, 'home', '.local', 'bin');
        mkdirSync(binDir, { recursive: true });
        const goosePath = resolve(binDir, isWin ? 'goose.exe' : 'goose');
        writeFileSync(goosePath, isWin ? '@echo off\r\n' : '#!/usr/bin/env sh\n');
        if (!isWin) chmodSync(goosePath, 0o755);
        return goosePath;
    }

    beforeEach(() => {
        originalHome = process.env.HOME;
        originalUserProfile = process.env.USERPROFILE;
        const home = resolve(TMP, 'home');
        process.env.HOME = home;
        process.env.USERPROFILE = home;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        process.env.USERPROFILE = originalUserProfile;
    });

    it('errors when the recipe file is missing', () => {
        plantFakeGoose();
        const spec = buildGooseRecipeSpawnSpec(resolve(TMP, 'recipes', 'nope.yaml'), { scope: 'x' }, TMP);
        expect('error' in spec).toBe(true);
        if ('error' in spec) expect(spec.error).toContain('recipe not found');
    });

    it('builds a goose run --recipe with --params for the verify recipe', () => {
        const goosePath = plantFakeGoose();
        const recipeDir = resolve(TMP, 'recipes');
        mkdirSync(recipeDir, { recursive: true });
        writeFileSync(resolve(recipeDir, 'verify-change.yaml'), 'version: "1.0.0"\n');

        const spec = buildGooseVerifySpawnSpec('main..HEAD', TMP);
        expect('error' in spec).toBe(false);
        if ('error' in spec) return;

        expect(spec.cmd).toBe(goosePath);
        expect(spec.args.slice(0, 3)).toEqual(['run', '--recipe', resolve(recipeDir, 'verify-change.yaml')]);
        // scope + workspaceDir passed as --params; launch omitted when undefined.
        const joined = spec.args.join(' ');
        expect(joined).toContain('--params scope=main..HEAD');
        expect(joined).toContain(`--params workspaceDir=${TMP}`);
        expect(joined).not.toContain('launch=');
        expect(spec.args).toContain('--with-builtin');
    });

    it('includes the launch param only when provided, and skips empty values', () => {
        plantFakeGoose();
        const recipeDir = resolve(TMP, 'recipes');
        mkdirSync(recipeDir, { recursive: true });
        writeFileSync(resolve(recipeDir, 'verify-change.yaml'), 'version: "1.0.0"\n');

        const withLaunch = buildGooseVerifySpawnSpec('x', TMP, 'npm run server');
        if ('error' in withLaunch) throw new Error(withLaunch.error);
        expect(withLaunch.args.join(' ')).toContain('--params launch=npm run server');

        const emptyParam = buildGooseRecipeSpawnSpec(resolve(recipeDir, 'verify-change.yaml'), { scope: 'x', launch: '' }, TMP);
        if ('error' in emptyParam) throw new Error(emptyParam.error);
        expect(emptyParam.args.join(' ')).not.toContain('launch=');
    });
});

// ─── OpenCode ────────────────────────────────────────────────────────────────

describe('OpenCode driver', () => {
    it('finds opencode on PATH', () => {
        const fakeOpenCode = writeFakeOpenCode();
        prependPath(FAKE_BIN);

        const found = findOpenCodeCli();
        expect(found && (isWin ? found.toLowerCase() : found)).toBe(isWin ? fakeOpenCode.toLowerCase() : fakeOpenCode);
    });

    it('builds args supported by opencode run', () => {
        const fakeOpenCode = writeFakeOpenCode();
        prependPath(FAKE_BIN);

        const spec = buildOpenCodeSpawnSpec('frontend', TMP, PROMPT_FILE, 'anthropic/claude-sonnet-4-5', OUTPUT);

        expect('error' in spec).toBe(false);
        if ('error' in spec) return;
        expect(spec.cmd).toBe(fakeOpenCode);
        expect(spec.args).toEqual([
            'run',
            '--dir', TMP,
            '--file', PROMPT_FILE,
            '--dangerously-skip-permissions',
            '--model', 'anthropic/claude-sonnet-4-5',
            'Follow the instructions in the attached prompt file.',
        ]);
    });

    it('omits the model flag when model is auto', () => {
        writeFakeOpenCode();
        prependPath(FAKE_BIN);

        const spec = buildOpenCodeSpawnSpec('qa', TMP, PROMPT_FILE, 'auto', OUTPUT);

        expect('error' in spec).toBe(false);
        if ('error' in spec) return;
        expect(spec.args).not.toContain('--model');
    });

    it('routes opencode driver through opencode spec', () => {
        const fakeOpenCode = writeFakeOpenCode();
        prependPath(FAKE_BIN);

        const cfg: AgentDriverConfig = { type: 'opencode' };
        const spec = buildSpawnSpec(cfg, 'frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);

        expect('error' in spec).toBe(false);
        if ('error' in spec) return;
        expect(spec.cmd).toBe(fakeOpenCode);
        expect(spec.args).toContain('--dir');
        expect(spec.args).toContain('--file');
    });
});

// ─── OpenCode-only policy ────────────────────────────────────────────────────

describe('OpenCode-only driver policy (no Claude, no Cursor)', () => {
    it('resolveCursorSafeDriverConfig returns opencode when enabled and configured', () => {
        writeFakeOpenCode();
        prependPath(FAKE_BIN);
        writeConfig({ opencodeEnabled: true, scheduler: { driver: 'opencode' } });

        expect(resolveCursorSafeDriverConfig(CONFIG).type).toBe('opencode');
    });

    it('resolveCursorSafeDriverConfig does not use opencode when opencodeEnabled is false', () => {
        writeFakeOpenCode();
        prependPath(FAKE_BIN);
        writeConfig({ opencodeEnabled: false, scheduler: { driver: 'opencode' } });

        const resolved = resolveCursorSafeDriverConfig(CONFIG).type;
        expect(resolved).not.toBe('opencode');
        expect(['aider', 'goose', 'loop']).toContain(resolved);
    });

    it('resolveCursorSafeDriverConfig does not use opencode when SDLC_FRAMEWORK_OPENCODE=0', () => {
        writeFakeOpenCode();
        prependPath(FAKE_BIN);
        writeConfig({ opencodeEnabled: true, scheduler: { driver: 'opencode' } });
        const prev = process.env.SDLC_FRAMEWORK_OPENCODE;
        process.env.SDLC_FRAMEWORK_OPENCODE = '0';
        try {
            const resolved = resolveCursorSafeDriverConfig(CONFIG).type;
            expect(resolved).not.toBe('opencode');
            expect(['aider', 'goose', 'loop']).toContain(resolved);
        } finally {
            if (prev === undefined) delete process.env.SDLC_FRAMEWORK_OPENCODE;
            else process.env.SDLC_FRAMEWORK_OPENCODE = prev;
        }
    });

    it('resolveAgentDriverConfig uses per-agent opencode override when enabled', () => {
        writeFakeOpenCode();
        prependPath(FAKE_BIN);
        writeConfig({
            opencodeEnabled: true,
            scheduler: { driver: 'loop', agents: { frontend: { driver: 'opencode' } } },
        });

        expect(resolveAgentDriverConfig('frontend', CONFIG).type).toBe('opencode');
    });

    it('resolveAgentDriverConfig does not use opencode for per-agent override when disabled', () => {
        writeFakeOpenCode();
        prependPath(FAKE_BIN);
        writeConfig({
            opencodeEnabled: false,
            scheduler: { driver: 'loop', agents: { frontend: { driver: 'opencode' } } },
        });

        const resolved = resolveAgentDriverConfig('frontend', CONFIG).type;
        expect(resolved).not.toBe('opencode');
        expect(['aider', 'goose', 'loop']).toContain(resolved);
    });

    it('resolveAgentDriverConfig global opencode driver is used when no per-agent override exists', () => {
        writeFakeOpenCode();
        prependPath(FAKE_BIN);
        writeConfig({ opencodeEnabled: true, scheduler: { driver: 'opencode' } });

        expect(resolveAgentDriverConfig('reviewer', CONFIG).type).toBe('opencode');
    });

    it('other agents fall back to global driver when only one agent has an opencode override', () => {
        writeFakeOpenCode();
        prependPath(FAKE_BIN);
        writeConfig({
            opencodeEnabled: true,
            scheduler: { driver: 'loop', agents: { frontend: { driver: 'opencode' } } },
        });

        expect(resolveAgentDriverConfig('devops', CONFIG).type).toBe('loop');
        expect(resolveAgentDriverConfig('frontend', CONFIG).type).toBe('opencode');
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

    it.skipIf(isWin)('finds aider on PATH', () => {
        const fakeAider = writeFakeAider();
        prependPath(FAKE_BIN);

        expect(findAiderCli()).toBe(fakeAider);
    });

    it.skipIf(isWin)('creates a shell launcher using MeshLLM with Ollama fallback', () => {
        const fakeAider = writeFakeAider();
        prependPath(FAKE_BIN);

        const spec = buildAiderSpawnSpec('frontend', TMP, PROMPT_FILE, 'auto', OUTPUT);

        expect('error' in spec).toBe(false);
        if ('error' in spec) return;
        expect(spec.cmd).toBe('/bin/sh');
        expect(spec.args).toEqual([resolve(OUTPUT, 'frontend-aider-launcher.sh')]);
        expect(spec.ignoreStdio).toBe(true);

        const launcher = readFileSync(resolve(OUTPUT, 'frontend-aider-launcher.sh'), 'utf-8');
        expect(launcher).toContain(`cd '${TMP}'`);
        expect(launcher).toContain(`'${fakeAider}'`);
        expect(launcher).toContain("--model 'openai/qwen3:8b'");
        expect(launcher).toContain("mesh_base='http://localhost:9337/v1'");
        expect(launcher).toContain('--openai-api-base "$mesh_base"');
        expect(launcher).toContain('--openai-api-base "$ollama_base"');
        expect(launcher).toContain('--message-file');
        expect(launcher).toContain('--no-auto-commits');
        expect(launcher).toContain('curl -fsS');
    });

    it.skipIf(isWin)('uses an explicit model instead of auto default', () => {
        writeFakeAider();
        prependPath(FAKE_BIN);

        const spec = buildAiderSpawnSpec('qa', TMP, PROMPT_FILE, 'sdlc-tuned', OUTPUT);

        expect('error' in spec).toBe(false);
        const launcher = readFileSync(resolve(OUTPUT, 'qa-aider-launcher.sh'), 'utf-8');
        expect(launcher).toContain("--model 'openai/sdlc-tuned'");
        expect(launcher).not.toContain("--model 'openai/qwen3:8b'");
    });

    it('routes aider driver through aider spec', () => {
        const cfg: AgentDriverConfig = { type: 'aider' };
        const spec = buildSpawnSpec(cfg, 'frontend', 'do work', TMP, PROMPT_FILE, undefined, OUTPUT);
        if ('error' in spec) {
            expect(spec.error).toMatch(/Aider|Windows|PowerShell|pipx/);
        } else {
            expect(spec.cmd).toMatch(isWin ? /powershell\.exe$/i : /\/bin\/sh$/);
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
        // No launcher script in TMP/bin, so the claude path errors referencing the
        // platform's launcher (.ps1 on Windows, .sh on macOS/Linux).
        expect('error' in spec).toBe(true);
        if ('error' in spec) {
            expect(spec.error.includes(isWin ? 'run-agent-claude.ps1' : 'run-agent-claude.sh')).toBe(true);
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
