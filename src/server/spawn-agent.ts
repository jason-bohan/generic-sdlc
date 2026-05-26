import { spawn } from 'child_process';
import { existsSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { getMockModeSafetyDirective } from './test-safety';
import { buildSpawnSpec, resolveCursorSafeDriverConfig, resolveAgentDriverConfig, LOOP_DRIVER_SENTINEL, type AgentDriverType, type DriverSpawnSpec } from './agent-drivers';
import { isCursorAiEnabled, isClaudeEnabled } from './cursor-ai-policy';
import { isMockExternalMode } from './external-mode';
import { ensureMockShims } from './mock-mode-guard';
import { startRunner } from './agent-runner';
import { readLoopProviderConfig } from './agent-runner/provider';
import { dbCreateAgentSession, dbUpdateAgentSession } from './db';
import { parseJsonUtf8File } from './json-file';
import { getActiveProject } from './project-config';

export interface SpawnResult {
    spawned: boolean;
    pid?: number;
    sessionId?: string;
    reason?: string;
}

interface ActiveAgent {
    pid: number;
    spawnedAt: number;
    sessionId?: string;
}

const activeAgents = new Map<string, ActiveAgent>();
const DEDUP_WINDOW_MS = 60_000;

let _testRunnerActive = false;
export function setTestRunnerActive(active: boolean): void { _testRunnerActive = active; }
export function isTestRunnerActive(): boolean { return _testRunnerActive; }

function isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Spawn an agent CLI process for the next SDLC phase.
 *
 * Which CLI is used is determined by scheduler.driver in .sdlc-framework.config.json:
 *   cursor      — Cursor agent CLI (default, existing behavior)
 *   claude-code — Claude Code CLI via bin/run-agent-claude.ps1
 *   goose       — Goose CLI for local/Ollama models
 *   generic     — Configurable command via scheduler.genericDriver
 *
 * model='local' continues to route to Goose for backward compatibility.
 *
 * Deduplicates by agentId within a 60s window to prevent double-spawns
 * from watcher hooks and API calls racing.
 */
export interface SpawnAgentOptions {
    /** When true, spawn even if `.${agentId}-status.json` has handoffDispatched (wrap-up after build-passed). */
    bypassHandoffDispatched?: boolean;
}

/** True when agent CLI subprocesses must not start (Vitest, Cypress docker mock E2E, test runner). */
export function shouldSuppressAgentSpawn(workspaceDir: string): boolean {
    if (_testRunnerActive) return true;
    const configPath = resolve(workspaceDir, '.sdlc-framework.config.json');
    if (!isMockExternalMode(configPath)) return false;
    if (process.env.SDLC_FRAMEWORK_ALLOW_AGENT_SPAWN === '1') return false;
    return process.env.VITEST === '1' || process.env.SDLC_FRAMEWORK_E2E === '1';
}

export function spawnAgent(
    agentId: string,
    prompt: string,
    workspaceDir: string,
    model?: string,
    opts?: SpawnAgentOptions,
): SpawnResult {
    if (shouldSuppressAgentSpawn(workspaceDir)) {
        return { spawned: false, reason: 'Suppressed: mock test environment' };
    }

    const configPath = resolve(workspaceDir, '.sdlc-framework.config.json');
    const safetyDirective = getMockModeSafetyDirective(configPath);
    const effectivePrompt = safetyDirective ? `${safetyDirective}\n\n${prompt}` : prompt;

    const statusFile = resolve(workspaceDir, `.${agentId}-status.json`);
    if (existsSync(statusFile)) {
        try {
            const status = parseJsonUtf8File(statusFile);
            if (status.handoffDispatched && !opts?.bypassHandoffDispatched) {
                return { spawned: false, reason: `${agentId} handoffDispatched already true` };
            }
        } catch { /* proceed */ }
    }

    const existing = activeAgents.get(agentId);
    if (existing) {
        const elapsed = Date.now() - existing.spawnedAt;
        if (elapsed < DEDUP_WINDOW_MS && isProcessAlive(existing.pid)) {
            return { spawned: false, pid: existing.pid, sessionId: existing.sessionId, reason: `${agentId} already spawned ${Math.round(elapsed / 1000)}s ago (PID ${existing.pid})` };
        }
        activeAgents.delete(agentId);
    }

    const outputDir = resolve(workspaceDir, '.agent-output');
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = resolve(outputDir, `${agentId}-${timestamp}.log`);
    const promptFilePath = resolve(outputDir, `${agentId}-prompt.txt`);
    writeFileSync(promptFilePath, effectivePrompt, 'utf-8');

    // model='local' routes through the standard cursor driver (run-agent.ps1)
    // which has its own Goose routing with -KeepOpen, banners, and file watchers.
    const driverConfig = resolveAgentDriverConfig(agentId, configPath);
    const profile = getActiveProject(configPath);
    const agentWorkspace = profile.workspacePath && existsSync(profile.workspacePath)
        ? profile.workspacePath
        : workspaceDir;
    const launchWorkspace = driverConfig.type === 'aider' ? agentWorkspace : workspaceDir;
    const providerBaseUrl = driverConfig.type === 'aider'
        ? readLoopProviderConfig(configPath, model && model !== 'auto' && model !== 'local' ? model : undefined).baseUrl
        : undefined;

    const spec = buildSpawnSpec(driverConfig, agentId, effectivePrompt, launchWorkspace, promptFilePath, model, outputDir, providerBaseUrl);

    // Loop driver: start an in-process AgentRunner instead of a subprocess
    if (spec === LOOP_DRIVER_SENTINEL) {
        if (existsSync(statusFile)) {
            try {
                const s = parseJsonUtf8File(statusFile);
                s.handoffDispatched = true;
                writeFileSync(statusFile, JSON.stringify(s, null, 2));
            } catch { /* non-critical */ }
        }
        startRunner(agentId, effectivePrompt, workspaceDir, agentWorkspace, configPath, model, { showTerminal: true });
        console.log(`[spawn-agent] ${agentId} started via loop driver`);
        return { spawned: true };
    }

    if ('error' in spec) {
        if (driverConfig.type === 'aider' && spec.error.includes('Aider not found')) {
            appendFileSync(resolve(workspaceDir, '.agent-spawns.log'), `${new Date().toISOString()} | ${agentId} | FALLBACK | Aider not found, using loop driver\n`);
            startRunner(agentId, effectivePrompt, workspaceDir, agentWorkspace, configPath, model, { showTerminal: true });
            console.warn(`[spawn-agent] ${agentId}: Aider not found, using loop driver`);
            return { spawned: true, reason: 'Aider not found, using loop driver' };
        }
        // Try fallback drivers before giving up (not when model='local' — goose is explicit)
        if (model !== 'local') {
            const fallback = _buildFallbackSpec(driverConfig.type, agentId, effectivePrompt, workspaceDir, promptFilePath, model, outputDir, isCursorAiEnabled(configPath), isClaudeEnabled(configPath));
            if (fallback) {
                const msg = `primary driver '${driverConfig.type}' failed (${spec.error}), falling back to '${fallback.usedDriver}'`;
                console.warn(`[spawn-agent] ${agentId}: ${msg}`);
                appendFileSync(resolve(workspaceDir, '.agent-spawns.log'), `${new Date().toISOString()} | ${agentId} | FALLBACK | ${msg}\n`);
                return _doSpawn(fallback.spec, agentId, effectivePrompt, workspaceDir, statusFile, logFile, promptFilePath, model, fallback.usedDriver);
            }
        }
        _writeSpawnError(statusFile, agentId, spec.error);
        return { spawned: false, reason: spec.error };
    }

    return _doSpawn(spec, agentId, effectivePrompt, workspaceDir, statusFile, logFile, promptFilePath, model, driverConfig.type);
}

// Ordered list of drivers to try when the primary spec fails.
const DRIVER_FALLBACK_CHAIN: AgentDriverType[] = ['claude-code', 'aider', 'goose', 'cursor'];

function _buildFallbackSpec(
    primaryType: AgentDriverType,
    agentId: string,
    prompt: string,
    workspaceDir: string,
    promptFilePath: string,
    model: string | undefined,
    outputDir: string,
    allowCursor: boolean,
    allowClaude: boolean,
): { spec: DriverSpawnSpec; usedDriver: AgentDriverType } | null {
    for (const type of DRIVER_FALLBACK_CHAIN) {
        if (type === primaryType) continue;
        if (type === 'cursor' && !allowCursor) continue;
        if (type === 'claude-code' && !allowClaude) continue;
        const spec = buildSpawnSpec({ type }, agentId, prompt, workspaceDir, promptFilePath, model, outputDir);
        if (!('error' in spec)) return { spec, usedDriver: type };
    }
    return null;
}

function _writeSpawnError(statusFile: string, agentId: string, reason: string): void {
    if (!existsSync(statusFile)) return;
    try {
        const status = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        if (!Array.isArray(status.events)) status.events = [];
        (status.events as unknown[]).push({
            timestamp: new Date().toISOString(),
            type: 'error',
            message: `[spawn] Could not start ${agentId}: ${reason}` });
        status.spawnError = { reason, timestamp: new Date().toISOString() };
        writeFileSync(statusFile, JSON.stringify(status, null, 2));
    } catch { /* non-critical */ }
}

function _doSpawn(
    spec: DriverSpawnSpec,
    agentId: string,
    effectivePrompt: string,
    workspaceDir: string,
    statusFile: string,
    logFile: string,
    promptFile: string,
    model: string | undefined,
    driver: AgentDriverType,
): SpawnResult {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(spec.env ?? {}) };

    // Keep Cursor shim dir on PATH when it exists (harmless for other drivers)
    const shimDir = resolve(process.env.LOCALAPPDATA || '', 'cursor-agent', 'bin');
    if (existsSync(shimDir)) childEnv.PATH = `${shimDir};${childEnv.PATH || ''}`;

    // Inject mock-bin shims for every driver when in mock mode — blocks git push and az at the process level
    const configPath = resolve(workspaceDir, '.sdlc-framework.config.json');
    if (isMockExternalMode(configPath)) {
        const mockBin = ensureMockShims(workspaceDir);
        childEnv.PATH = `${mockBin};${childEnv.PATH || ''}`;
        childEnv.SDLC_FRAMEWORK_MOCK_MODE = '1';
    }

    try {
        const stdio: ['ignore', 'ignore', 'ignore'] | ['ignore', 'pipe', 'pipe'] = spec.ignoreStdio
            ? ['ignore', 'ignore', 'ignore']
            : ['ignore', 'pipe', 'pipe'];

        const child = spawn(spec.cmd, spec.args, {
            detached: true,
            cwd: workspaceDir,
            env: childEnv,
            windowsHide: false,
            shell: spec.needsShell ?? false,
            stdio });

        const { pid } = child;
        if (!pid) return { spawned: false, reason: `Failed to get PID for ${agentId}` };

        const sessionId = _createDurableSession({
            agentId,
            statusFile,
            workspaceDir,
            logFile,
            promptFile,
            model,
            driver,
            pid });

        child.on('error', (err: Error) => {
            console.error(`[spawn-agent] ${agentId} error: ${err.message}`);
            appendFileSync(logFile, `\n[error] ${err.message} at ${new Date().toISOString()}\n`);
            if (sessionId) _finishDurableSession(sessionId, 'failed', { error: err.message });
            activeAgents.delete(agentId);
        });

        if (!spec.ignoreStdio && child.stdout && child.stderr) {
            const stream = (label: string) => (data: Buffer) => appendFileSync(logFile, `[${label}] ${data}`);
            child.stdout.on('data', stream('stdout'));
            child.stderr.on('data', stream('stderr'));
        }

        child.on('exit', (code: number | null) => {
            appendFileSync(logFile, `\n[exit] code=${code} at ${new Date().toISOString()}\n`);
            if (sessionId) _finishDurableSession(sessionId, code === 0 ? 'completed' : 'failed', { exitCode: code });
            activeAgents.delete(agentId);
        });

        child.unref();
        activeAgents.set(agentId, { pid, spawnedAt: Date.now(), sessionId });

        const modelTag = model && model !== 'auto' ? ` | model=${model}` : '';
        const sessionTag = sessionId ? ` | session=${sessionId}` : '';
        appendFileSync(resolve(workspaceDir, '.agent-spawns.log'), `${new Date().toISOString()} | ${agentId} | PID ${pid}${modelTag}${sessionTag} | "${effectivePrompt.slice(0, 120)}"\n`);
        appendFileSync(logFile, `[spawn] ${new Date().toISOString()} agent=${agentId} pid=${pid}${modelTag}${sessionTag}\n[prompt] ${effectivePrompt}\n\n`);

        if (existsSync(statusFile)) {
            try {
                const s = parseJsonUtf8File(statusFile);
                s.handoffDispatched = true;
                s.spawnedPid = pid;
                if (sessionId) {
                    s.sessionId = sessionId;
                    s.activeSessionId = sessionId;
                }
                writeFileSync(statusFile, JSON.stringify(s, null, 2));
            } catch { /* non-critical */ }
        }

        console.log(`[spawn-agent] ${agentId} spawned as PID ${pid}${modelTag}${sessionTag}`);
        return { spawned: true, pid, sessionId };
    } catch (err: unknown) {
        const msg = `Failed to spawn ${agentId}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[spawn-agent] ${msg}`);
        appendFileSync(resolve(workspaceDir, '.agent-spawns.log'), `${new Date().toISOString()} | ${agentId} | FAILED | ${err instanceof Error ? err.message : String(err)}\n`);
        return { spawned: false, reason: msg };
    }
}

export function isAgentActive(agentId: string): boolean {
    const entry = activeAgents.get(agentId);
    if (!entry) return false;
    if (!isProcessAlive(entry.pid)) { activeAgents.delete(agentId); return false; }
    return true;
}

export function getActiveAgents(): Record<string, { pid: number; spawnedAt: string; sessionId?: string }> {
    const result: Record<string, { pid: number; spawnedAt: string; sessionId?: string }> = {};
    for (const [id, entry] of activeAgents) {
        if (isProcessAlive(entry.pid)) {
            result[id] = { pid: entry.pid, spawnedAt: new Date(entry.spawnedAt).toISOString(), sessionId: entry.sessionId };
        } else {
            activeAgents.delete(id);
        }
    }
    return result;
}

function _readStatusSnapshot(statusFile: string): Record<string, unknown> {
    if (!existsSync(statusFile)) return {};
    try {
        return parseJsonUtf8File(statusFile) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function _numberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function _stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

function _createDurableSession(params: {
    agentId: string;
    statusFile: string;
    workspaceDir: string;
    logFile: string;
    promptFile: string;
    model?: string;
    driver: AgentDriverType;
    pid: number;
}): string | undefined {
    try {
        const status = _readStatusSnapshot(params.statusFile);
        const session = dbCreateAgentSession({
            agentId: params.agentId,
            workflowItemId: _numberOrNull(status.workflowItemId),
            storyNumber: _stringOrNull(status.storyNumber) ?? _stringOrNull((status.assignedPR as Record<string, unknown> | undefined)?.storyNumber),
            storyName: _stringOrNull(status.storyName) ?? _stringOrNull((status.assignedPR as Record<string, unknown> | undefined)?.title),
            phase: _stringOrNull(status.currentPhase),
            driver: params.driver,
            model: params.model ?? null,
            status: 'running',
            pid: params.pid,
            workspaceDir: params.workspaceDir,
            logFile: params.logFile,
            promptFile: params.promptFile,
            metadata: {
                assignedPrId: (status.assignedPR as Record<string, unknown> | undefined)?.id ?? null } });
        return session.id;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[spawn-agent] ${params.agentId}: durable session unavailable: ${message}`);
        return undefined;
    }
}

function _finishDurableSession(sessionId: string, status: 'completed' | 'failed' | 'stopped', metadata: Record<string, unknown>): void {
    try {
        dbUpdateAgentSession(sessionId, {
            status,
            endedAt: new Date().toISOString(),
            metadata });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[spawn-agent] ${sessionId}: durable session update failed: ${message}`);
    }
}
