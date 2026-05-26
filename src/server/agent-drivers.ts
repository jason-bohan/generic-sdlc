import { existsSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execFile } from 'child_process';
import { parseJsonUtf8File } from './json-file';
import { isCursorAiEnabled, isClaudeEnabled } from './cursor-ai-policy';
import { OpenAICompatibleProvider, readLoopProviderConfig } from './agent-runner/provider';
import { ollamaHost } from './ollamaManager';

export type AgentDriverType = 'cursor' | 'claude-code' | 'aider' | 'goose' | 'generic' | 'loop';

export interface GenericDriverConfig {
    command: string;
    // Supports placeholders: {prompt}, {promptFile}, {workspaceDir}, {model}, {agentId}
    args: string[];
}

export interface AgentDriverConfig {
    type: AgentDriverType;
    generic?: GenericDriverConfig;
}

export interface DriverSpawnSpec {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    needsShell?: boolean;
    /** If true, stdio is piped (driver script handles its own I/O). */
    ignoreStdio?: boolean;
}

export function readDriverConfig(configPath: string): AgentDriverConfig {
    if (!existsSync(configPath)) return { type: 'loop' };
    try {
        const cfg = parseJsonUtf8File(configPath);
        const raw = cfg.scheduler?.driver as string | undefined;
        const valid: AgentDriverType[] = ['cursor', 'claude-code', 'aider', 'goose', 'generic', 'loop'];
        return {
            type: valid.includes(raw as AgentDriverType) ? (raw as AgentDriverType) : 'loop',
            generic: cfg.scheduler?.genericDriver };
    } catch {
        return { type: 'loop' };
    }
}

export function resolveCursorSafeDriverConfig(configPath: string): AgentDriverConfig {
    const cfg = readDriverConfig(configPath);
    if ((cfg.type === 'cursor' && !isCursorAiEnabled(configPath)) ||
        (cfg.type === 'claude-code' && !isClaudeEnabled(configPath))) {
        // Prefer aider (coding-optimised) → goose (general) → loop (in-process)
        if (findAiderCli()) return { ...cfg, type: 'aider' };
        if (existsSync(findGooseCli())) return { ...cfg, type: 'goose' };
        return { ...cfg, type: 'loop' };
    }
    return cfg;
}

/**
 * Like resolveCursorSafeDriverConfig but honours per-agent driver overrides.
 * Set scheduler.agents.<id>.driver in .sdlc-framework.config.json to route a
 * specific agent (e.g. "reviewer") to a different driver than the global default.
 */
export function resolveAgentDriverConfig(agentId: string, configPath: string): AgentDriverConfig {
    const valid: AgentDriverType[] = ['cursor', 'claude-code', 'aider', 'goose', 'generic', 'loop'];
    try {
        if (existsSync(configPath)) {
            const cfg = parseJsonUtf8File(configPath);
            const perAgent = cfg.scheduler?.agents?.[agentId]?.driver as string | undefined;
            if (perAgent && valid.includes(perAgent as AgentDriverType)) {
                const overrideType = perAgent as AgentDriverType;
                if ((overrideType === 'cursor' && !isCursorAiEnabled(configPath)) ||
                    (overrideType === 'claude-code' && !isClaudeEnabled(configPath))) {
                    if (findAiderCli()) return { type: 'aider' };
                    if (existsSync(findGooseCli())) return { type: 'goose' };
                    return { type: 'loop' };
                }
                return { type: overrideType, generic: cfg.scheduler?.genericDriver };
            }
        }
    } catch { /* fall through to global */ }
    return resolveCursorSafeDriverConfig(configPath);
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

export function findCursorCli(): string | null {
    const localAppData = process.env.LOCALAPPDATA || '';

    const shimCmd = resolve(localAppData, 'cursor-agent', 'bin', 'agent.cmd');
    if (existsSync(shimCmd)) return shimCmd;

    const versionsDir = resolve(localAppData, 'cursor-agent', 'versions');
    if (existsSync(versionsDir)) {
        try {
            const versions = readdirSync(versionsDir).sort().reverse();
            for (const v of versions) {
                const nodeExe = resolve(versionsDir, v, 'node.exe');
                const entryJs = resolve(versionsDir, v, 'dist-package', 'index.js');
                const flatEntryJs = resolve(versionsDir, v, 'index.js');
                if (existsSync(nodeExe) && (existsSync(entryJs) || existsSync(flatEntryJs))) return nodeExe;
            }
        } catch { /* fall through */ }
    }

    const legacy = [
        resolve(localAppData, 'Programs', 'cursor-cli', 'agent.exe'),
        resolve(process.env.USERPROFILE || '', '.cursor', 'bin', 'agent.exe'),
    ];
    for (const p of legacy) { if (existsSync(p)) return p; }

    return null;
}

function findCursorNodeEntryJs(): string | null {
    const versionsDir = resolve(process.env.LOCALAPPDATA || '', 'cursor-agent', 'versions');
    if (!existsSync(versionsDir)) return null;
    try {
        const versions = readdirSync(versionsDir).sort().reverse();
        for (const v of versions) {
            const entryJs = resolve(versionsDir, v, 'dist-package', 'index.js');
            if (existsSync(entryJs)) return entryJs;
            const flatEntryJs = resolve(versionsDir, v, 'index.js');
            if (existsSync(flatEntryJs)) return flatEntryJs;
        }
    } catch { /* */ }
    return null;
}

export function buildCursorSpawnSpec(
    agentId: string,
    prompt: string,
    workspaceDir: string,
    promptFilePath: string,
    model: string | undefined,
    outputDir: string,
): DriverSpawnSpec | { error: string } {
    const driverScript = resolve(workspaceDir, 'bin', 'run-agent.ps1');
    const effectiveModel = model && model !== 'auto' ? model : undefined;

    if (existsSync(driverScript) && process.platform !== 'win32') {
        return {
            error: 'bin/run-agent.ps1 requires Windows. Install Cursor CLI or use another scheduler.driver on Linux/Docker.' };
    }

    if (existsSync(driverScript) && process.platform === 'win32') {
        const launcherPath = resolve(outputDir, `${agentId}-launcher.cmd`);
        const psExe = resolve(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const shimDir = resolve(process.env.LOCALAPPDATA || '', 'cursor-agent', 'bin');
        const modelArg = effectiveModel ? ` -Model "${effectiveModel}"` : '';
        writeFileSync(launcherPath, [
            '@echo off',
            `set "PATH=${shimDir};%PATH%"`,
            `"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${driverScript}" -AgentId ${agentId} -PromptFile "${promptFilePath}" -WorkspaceDir "${workspaceDir}"${modelArg} -KeepOpen`,
        ].join('\r\n'));
        const comSpec = process.env.ComSpec || resolve(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'cmd.exe');
        return { cmd: comSpec, args: ['/c', launcherPath], ignoreStdio: true };
    }

    const agentCli = findCursorCli();
    if (!agentCli) {
        return {
            error: 'Cursor CLI not found and bin/run-agent.ps1 is missing. ' +
                'Run bin/setup.ps1 or set scheduler.driver in .sdlc-framework.config.json.' };
    }

    const modelArgs = effectiveModel ? ['--model', effectiveModel] : [];
    const entryJs = findCursorNodeEntryJs();
    const baseArgs = ['-p', '--force', '--trust', '--approve-mcps', ...modelArgs, '--workspace', workspaceDir];

    if (agentCli.endsWith('node.exe')) {
        if (!entryJs) {
            return {
                error: 'Cursor CLI found (node.exe) but index.js entry point is missing. ' +
                    'Try reinstalling Cursor or updating to the latest version.' };
        }
        return { cmd: agentCli, args: [entryJs, ...baseArgs, prompt] };
    }
    return {
        cmd: agentCli,
        args: [...baseArgs, prompt],
        needsShell: agentCli.endsWith('.cmd') || agentCli.endsWith('.bat') };
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

export function buildClaudeCodeSpawnSpec(
    agentId: string,
    workspaceDir: string,
    promptFilePath: string,
    model: string | undefined,
    outputDir: string,
): DriverSpawnSpec | { error: string } {
    const driverScript = resolve(workspaceDir, 'bin', 'run-agent-claude.ps1');
    if (process.platform !== 'win32') {
        return { error: 'Claude Code driver requires Windows (bin/run-agent-claude.ps1).' };
    }
    if (!existsSync(driverScript)) {
        return { error: 'bin/run-agent-claude.ps1 not found. Run bin/setup.ps1 to generate it.' };
    }

    const launcherPath = resolve(outputDir, `${agentId}-claude-launcher.cmd`);
    const psExe = resolve(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const effectiveModel = model && model !== 'auto' ? model : undefined;
    const modelArg = effectiveModel ? ` -Model "${effectiveModel}"` : '';
    writeFileSync(launcherPath, [
        '@echo off',
        `"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${driverScript}" -AgentId ${agentId} -PromptFile "${promptFilePath}" -WorkspaceDir "${workspaceDir}"${modelArg}`,
    ].join('\r\n'));

    const comSpec = process.env.ComSpec || resolve(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'cmd.exe');
    return { cmd: comSpec, args: ['/c', launcherPath], ignoreStdio: true };
}

// ─── Goose ───────────────────────────────────────────────────────────────────

function findGooseCli(): string {
    return resolve(process.env.USERPROFILE || '', '.local', 'bin', 'goose.exe');
}

export function buildGooseSpawnSpec(
    prompt: string,
    workspaceDir: string,
): DriverSpawnSpec | { error: string } {
    const gooseExe = findGooseCli();
    if (!existsSync(gooseExe)) {
        return {
            error: 'Goose CLI not found at ~/.local/bin/goose.exe. ' +
                'Install from https://block.github.io/goose/ or set scheduler.driver to another option.' };
    }
    return {
        cmd: gooseExe,
        args: ['run', '--text', prompt, '--with-builtin', 'developer', '--no-session', '--max-turns', '20'],
        env: { OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://localhost:11434' } };
}

// ─── Aider ───────────────────────────────────────────────────────────────────

export function findAiderCli(): string | null {
    // Search PATH directly — avoids spawning `which`/`where`, which can miss
    // process.env.PATH mutations in test workers on Linux.
    const pathEnv = process.env.PATH || '';
    const sep = process.platform === 'win32' ? ';' : ':';
    const names = process.platform === 'win32' ? ['aider.exe', 'aider.cmd', 'aider.bat'] : ['aider'];
    for (const dir of pathEnv.split(sep).filter(Boolean)) {
        for (const name of names) {
            const candidate = resolve(dir, name);
            if (existsSync(candidate)) return candidate;
        }
    }
    // Microsoft Store Python (common on Windows 11)
    const localAppData = process.env.LOCALAPPDATA || '';
    const msStorePkgs = resolve(localAppData, 'Packages');
    if (existsSync(msStorePkgs)) {
        try {
            const pkgs = readdirSync(msStorePkgs).filter(p => p.startsWith('PythonSoftwareFoundation.Python'));
            for (const pkg of pkgs.sort().reverse()) {
                const candidate = resolve(msStorePkgs, pkg, 'LocalCache', 'local-packages', 'Python311', 'Scripts', 'aider.exe');
                if (existsSync(candidate)) return candidate;
            }
        } catch { /* fall through */ }
    }
    // pipx install (Windows: USERPROFILE, macOS/Linux: HOME)
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const pipxBin = resolve(home, '.local', 'bin', process.platform === 'win32' ? 'aider.exe' : 'aider');
    if (existsSync(pipxBin)) return pipxBin;
    return null;
}

/**
 * Spawn Aider against the target workspace.
 * Uses MeshLLM as the primary provider, falls back to Ollama when MeshLLM is absent.
 * Both endpoints are OpenAI-compatible so the same model name works for both.
 */
export function buildAiderSpawnSpec(
    agentId: string,
    workspaceDir: string,
    promptFilePath: string,
    model: string | undefined,
    outputDir: string,
    providerBaseUrl?: string,
): DriverSpawnSpec | { error: string } {
    const aiderExe = findAiderCli();
    if (!aiderExe) {
        return { error: 'Aider not found. Install with: pipx install aider-chat' };
    }
    const meshllmBase = providerBaseUrl || ((process.env.MESHLLM_HOST || 'http://localhost:9337') + '/v1');
    const ollamaBase = ollamaHost() + '/v1';
    const effectiveModel = model && model !== 'auto' ? model : 'qwen3:8b';
    const agentOutputDir = resolve(workspaceDir, '.agent-output');

    if (process.platform !== 'win32') {
        const launcherPath = resolve(outputDir, `${agentId}-aider-launcher.sh`);
        const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
        writeFileSync(launcherPath, [
            '#!/bin/sh',
            'set -eu',
            `cd ${q(workspaceDir)}`,
            `mkdir -p ${q(agentOutputDir)}`,
            `log_path=${q(resolve(agentOutputDir, `${agentId}-`))}$(date +%Y-%m-%dT%H-%M-%S).log`,
            `mesh_base=${q(meshllmBase)}`,
            `ollama_base=${q(ollamaBase)}`,
            `if curl -fsS "$mesh_base/models" >/dev/null 2>&1; then`,
            `  echo "Backend: MeshLLM" >> "$log_path"`,
            `  exec ${q(aiderExe)} --model ${q(`openai/${effectiveModel}`)} --openai-api-base "$mesh_base" --openai-api-key meshllm --yes-always --no-auto-commits --map-tokens 0 --no-show-model-warnings --no-check-update --message-file ${q(promptFilePath)} >> "$log_path" 2>&1`,
            'else',
            `  echo "Backend: Ollama" >> "$log_path"`,
            `  exec ${q(aiderExe)} --model ${q(`openai/${effectiveModel}`)} --openai-api-base "$ollama_base" --openai-api-key ollama --yes-always --no-auto-commits --map-tokens 0 --no-show-model-warnings --no-check-update --message-file ${q(promptFilePath)} >> "$log_path" 2>&1`,
            'fi',
        ].join('\n'), 'utf-8');
        return {
            cmd: '/bin/sh',
            args: [launcherPath],
            env: { OLLAMA_HOST: ollamaHost(), SDLC_AGENT_OUTPUT_DIR: agentOutputDir },
            ignoreStdio: true,
        };
    }

    const launcherPath = resolve(outputDir, `${agentId}-aider-launcher.ps1`);
    const q = (s: string) => s.replace(/'/g, "''");  // PS single-quote escape

    writeFileSync(launcherPath, [
        `$host.ui.RawUI.WindowTitle = 'SDLC Framework Aider: ${agentId}'`,
        `Write-Host '  SDLC Framework Aider — ${agentId}' -ForegroundColor Cyan`,
        `Write-Host '  Model : ${effectiveModel}' -ForegroundColor Yellow`,
        `Write-Host ''`,
        `Set-Location -LiteralPath '${q(workspaceDir)}'`,
        // Create log dir and pick a timestamped log file
        `$logDir = '${q(agentOutputDir)}'`,
        `if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }`,
        `$ts = (Get-Date -Format 'yyyy-MM-ddTHH-mm-ss')`,
        `$logPath = Join-Path $logDir "${agentId}-$($ts).log"`,
        `Write-Host "  Log  : $logPath" -ForegroundColor DarkGray`,
        `$useMesh = $false`,
        `try { $null = Invoke-WebRequest -Uri '${meshllmBase}/models' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop; $useMesh = $true } catch {}`,
        `if ($useMesh) {`,
        `    Write-Host '  Backend: MeshLLM' -ForegroundColor Green`,
        `    & '${q(aiderExe)}' --model 'openai/${effectiveModel}' --openai-api-base '${meshllmBase}' --openai-api-key 'meshllm' --yes-always --no-auto-commits --map-tokens 0 --no-show-model-warnings --no-check-update --message-file '${q(promptFilePath)}' 2>&1 | Tee-Object -FilePath $logPath -Append`,
        `} else {`,
        `    Write-Host '  Backend: Ollama' -ForegroundColor Yellow`,
        `    & '${q(aiderExe)}' --model 'openai/${effectiveModel}' --openai-api-base '${ollamaBase}' --openai-api-key 'ollama' --yes-always --no-auto-commits --map-tokens 0 --no-show-model-warnings --no-check-update --message-file '${q(promptFilePath)}' 2>&1 | Tee-Object -FilePath $logPath -Append`,
        `}`,
        `Write-Host ''`,
        `Write-Host '  Aider complete. Press any key to close.' -ForegroundColor Green`,
        `$null = $host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')`,
    ].join('\r\n'), 'utf-8');

    const psExe = resolve(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { cmd: psExe, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath], ignoreStdio: true };
}

// ─── Generic ─────────────────────────────────────────────────────────────────

export function buildGenericSpawnSpec(
    genericConfig: GenericDriverConfig | undefined,
    agentId: string,
    prompt: string,
    workspaceDir: string,
    promptFilePath: string,
    model: string | undefined,
): DriverSpawnSpec | { error: string } {
    if (!genericConfig?.command) {
        return { error: 'Generic driver requires scheduler.genericDriver.command in .sdlc-framework.config.json.' };
    }
    const effectiveModel = model || 'auto';
    const sub = (s: string) =>
        s.replace('{agentId}', agentId)
         .replace('{prompt}', prompt)
         .replace('{promptFile}', promptFilePath)
         .replace('{workspaceDir}', workspaceDir)
         .replace('{model}', effectiveModel);

    return {
        cmd: sub(genericConfig.command),
        args: (genericConfig.args || []).map(sub) };
}

// ─── Unified dispatcher ───────────────────────────────────────────────────────

/** Sentinel returned when driver=loop — spawn-agent handles this specially. */
export const LOOP_DRIVER_SENTINEL: DriverSpawnSpec = { cmd: '__loop__', args: [] };

export function buildSpawnSpec(
    driverConfig: AgentDriverConfig,
    agentId: string,
    prompt: string,
    workspaceDir: string,
    promptFilePath: string,
    model: string | undefined,
    outputDir: string,
    providerBaseUrl?: string,
): DriverSpawnSpec | { error: string } {
    switch (driverConfig.type) {
        case 'loop':
            return LOOP_DRIVER_SENTINEL;
        case 'claude-code':
            return buildClaudeCodeSpawnSpec(agentId, workspaceDir, promptFilePath, model, outputDir);
        case 'aider':
            return buildAiderSpawnSpec(agentId, workspaceDir, promptFilePath, model, outputDir, providerBaseUrl);
        case 'goose':
            return buildGooseSpawnSpec(prompt, workspaceDir);
        case 'generic':
            return buildGenericSpawnSpec(driverConfig.generic, agentId, prompt, workspaceDir, promptFilePath, model);
        case 'cursor':
        default:
            return buildCursorSpawnSpec(agentId, prompt, workspaceDir, promptFilePath, model, outputDir);
    }
}

// ─── Inline query (synchronous, captures stdout) ─────────────────────────────

/**
 * Run a prompt through the active IDE's CLI and return the text response.
 * Used for synchronous AI queries (e.g. chat replies) where the caller needs
 * the output immediately, as opposed to fire-and-forget agent spawns.
 *
 * Driver is read from scheduler.driver in .sdlc-framework.config.json.
 */
export function runInlineQuery(
    prompt: string,
    workspaceDir: string,
    configPath: string,
    options?: { model?: string; timeout?: number },
): Promise<string> {
    const driver = resolveCursorSafeDriverConfig(configPath);
    const model = options?.model;
    const timeout = options?.timeout ?? 120_000;
    const effectiveModel = model && model !== 'auto' ? model : undefined;
    const modelArgs = effectiveModel ? ['--model', effectiveModel] : [];

    switch (driver.type) {
        case 'loop':
        case 'aider':  // Aider is for full coding sessions; use loop provider for inline queries
            return _runLoopProviderInlineQuery(prompt, configPath);

        case 'claude-code':
            if (!isClaudeEnabled(configPath)) return _runLoopProviderInlineQuery(prompt, configPath);
            return _execInline(
                'claude',
                ['--dangerously-skip-permissions', '-p', prompt, ...modelArgs],
                workspaceDir,
                timeout,
                true,  // needsShell — 'claude' resolved from PATH
            );

        case 'goose': {
            const gooseExe = findGooseCli();
            return _execInline(
                gooseExe,
                ['run', '--text', prompt, '--with-builtin', 'developer', '--no-session', '--max-turns', '5'],
                workspaceDir,
                timeout,
                false,
                { OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://localhost:11434' },
            );
        }

        case 'generic': {
            if (!driver.generic?.command) {
                return Promise.reject(new Error('Generic driver requires scheduler.genericDriver.command in .sdlc-framework.config.json.'));
            }
            const sub = (s: string) =>
                s.replace('{prompt}', prompt)
                 .replace('{workspaceDir}', workspaceDir)
                 .replace('{model}', effectiveModel || 'auto');
            return _execInline(
                sub(driver.generic.command),
                (driver.generic.args || []).map(sub),
                workspaceDir,
                timeout,
            );
        }

        case 'cursor':
        default: {
            const cli = findCursorCli();
            if (!cli) {
                return Promise.reject(new Error(
                    'Cursor CLI not found. Set scheduler.driver in .sdlc-framework.config.json to use a different IDE.',
                ));
            }
            const entryJs = findCursorNodeEntryJs();
            const baseArgs = ['-p', '--force', '--trust', '--approve-mcps', ...modelArgs, '--workspace', workspaceDir];
            const args = cli.endsWith('node.exe') && entryJs
                ? [entryJs, ...baseArgs, prompt]
                : [...baseArgs, prompt];
            return _execInline(cli, args, workspaceDir, timeout, cli.endsWith('.cmd') || cli.endsWith('.bat'));
        }
    }
}

async function _runLoopProviderInlineQuery(prompt: string, configPath: string): Promise<string> {
    const provider = new OpenAICompatibleProvider(readLoopProviderConfig(configPath));
    const result = await provider.complete([{ role: 'user', content: prompt }], []);
    const content = result.message.content?.trim();
    if (!content) throw new Error('Loop provider returned an empty response');
    return content;
}

function _execInline(
    cmd: string,
    args: string[],
    cwd: string,
    timeout: number,
    shell = false,
    extraEnv?: Record<string, string>,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
        execFile(cmd, args, {
            timeout,
            maxBuffer: 5 * 1024 * 1024,
            cwd,
            env,
            shell,
            windowsHide: true }, (err, stdout) => {
            if (err) { reject(new Error(`Inline query failed (${cmd}): ${err.message}`)); return; }
            resolve((stdout || '').trim());
        });
    });
}
