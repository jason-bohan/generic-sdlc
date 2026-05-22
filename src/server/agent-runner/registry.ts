import { resolve } from 'path';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { AgentRunner } from './AgentRunner';
import { OpenAICompatibleProvider, readLoopProviderConfig } from './provider';
import { skillSubdirForAgentId } from '../../shared/agentSkillDirs';
import {
    dbCreateSession,
    dbGetActiveSession,
    dbUpdateSessionMessages,
    dbEndSession,
    dbGetSession,
} from '../db';
import type { Message } from './types';
import { parseJsonUtf8File } from '../json-file';

const runners = new Map<string, AgentRunner>();

export function getRunner(agentId: string): AgentRunner | undefined {
    const runner = runners.get(agentId);
    if (runner && !runner.isRunning) {
        runners.delete(agentId);
        return undefined;
    }
    return runner;
}

/** Returns the sessionId of the currently active runner, if any. */
export function getActiveSessionId(agentId: string): string | undefined {
    return getRunner(agentId)?.sessionId;
}

export function injectMessage(agentId: string, text: string): boolean {
    const runner = getRunner(agentId);
    if (!runner) return false;
    runner.inject(text);
    return true;
}

export function stopRunner(agentId: string): boolean {
    const runner = runners.get(agentId);
    if (!runner) return false;
    runner.abort();
    runners.delete(agentId);
    return true;
}

export function isRunnerActive(agentId: string): boolean {
    return getRunner(agentId) !== undefined;
}

export function getActiveRunners(): string[] {
    for (const [id, runner] of runners) {
        if (!runner.isRunning) runners.delete(id);
    }
    return [...runners.keys()];
}

function buildSystemPrompt(agentId: string, sdlc-frameworkDir: string): string {
    const skillDir = skillSubdirForAgentId(agentId);
    const skillFile = resolve(sdlc-frameworkDir, 'skills', skillDir, 'SKILL.md');
    const skillContent = existsSync(skillFile)
        ? readFileSync(skillFile, 'utf-8')
        : `You are the ${agentId} agent in the SDLC Framework SDLC automation platform.`;

    return [
        skillContent,
        '',
        '## Runtime instructions',
        '- Your workspace is the directory passed in the initial prompt.',
        '- Use the provided tools (read_file, write_file, list_directory, run_command, search_in_files, update_status) to do your work.',
        '- Call update_status after completing each phase so the dashboard stays current.',
        '- When you receive a [/btw] message from the user, address it at the next logical break point.',
        '- When your work is complete, output a brief summary and stop calling tools.',
    ].join('\n');
}

function readStoryNumber(statusFile: string): string | null {
    if (!existsSync(statusFile)) return null;
    try {
        const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        const sn = s.storyNumber;
        return typeof sn === 'string' && sn.trim() ? sn.trim() : null;
    } catch { return null; }
}

function readCurrentPhase(statusFile: string): string {
    if (!existsSync(statusFile)) return 'idle';
    try {
        const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        return typeof s.currentPhase === 'string' ? s.currentPhase : 'idle';
    } catch { return 'idle'; }
}

/**
 * Create and start an AgentRunner for the given agent.
 *
 * If an existing active/paused session exists for the same (agentId, storyNumber),
 * its conversation history is resumed rather than starting from scratch.
 * The runner executes in the background; this function returns immediately.
 */
function _spawnTailTerminal(agentId: string, logFile: string, model: string): void {
    if (process.platform !== 'win32') return;
    const psExe = resolve(
        process.env.SystemRoot ?? 'C:\\WINDOWS',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const lf = logFile.replace(/'/g, "''");
    const id = agentId.replace(/'/g, "''");
    const mod = model.replace(/'/g, "''");
    const script = `$host.ui.RawUI.WindowTitle='SDLC Framework: ${id} [${mod}]'; Write-Host '  Agent : ${id}' -ForegroundColor Cyan; Write-Host '  Model : ${mod}' -ForegroundColor Yellow; Write-Host ''; Get-Content -LiteralPath '${lf}' -Wait -Encoding UTF8`;
    const child = spawn(psExe, ['-NoProfile', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
    });
    child.unref();
}

export function startRunner(
    agentId: string,
    prompt: string,
    sdlc-frameworkDir: string,
    workspaceDir: string,
    configPath: string,
    opts?: { showTerminal?: boolean },
): AgentRunner {
    stopRunner(agentId);

    const providerConfig = readLoopProviderConfig(configPath);
    const statusFile = resolve(sdlc-frameworkDir, `.${agentId}-status.json`);
    const storyNumber = readStoryNumber(statusFile);
    const currentPhase = readCurrentPhase(statusFile);

    // Look for an existing resumable session for this agent + story
    let sessionId: string | undefined;
    let initialMessages: Message[] | undefined;
    let isResume = false;

    try {
        const existing = dbGetActiveSession(agentId, storyNumber);
        if (existing) {
            // Reuse if the phase hasn't fundamentally changed (same story, not idle)
            const parsedMessages = JSON.parse(existing.messages_json) as Message[];
            if (parsedMessages.length > 0) {
                sessionId = existing.id;
                initialMessages = parsedMessages;
                isResume = true;
                console.log(`[agent-runner:${agentId}] resuming session ${sessionId} (${parsedMessages.length} messages)`);
            }
        }
    } catch { /* non-critical — start fresh if session lookup fails */ }

    // Create a new session row if not resuming
    if (!sessionId) {
        const newId = crypto.randomUUID();
        try {
            dbCreateSession({ id: newId, agentId, storyNumber, phase: currentPhase, model: providerConfig.model });
            sessionId = newId;
        } catch { sessionId = newId; /* proceed even if DB write fails */ }
    }

    const provider = new OpenAICompatibleProvider(providerConfig);
    const runner = new AgentRunner(agentId, provider, workspaceDir, sdlc-frameworkDir, configPath, {
        sessionId,
        initialMessages,
        onCheckpoint: (messages) => {
            try {
                dbUpdateSessionMessages(sessionId!, JSON.stringify(messages), readCurrentPhase(statusFile));
            } catch { /* non-critical */ }
        },
    });

    // Output log — same location the dashboard polls
    const outputDir = resolve(sdlc-frameworkDir, '.agent-output');
    mkdirSync(outputDir, { recursive: true });
    const sessionTs = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = resolve(outputDir, `${agentId}-${sessionTs}.log`);
    appendFileSync(logFile, [
        `[spawn] ${new Date().toISOString()} agent=${agentId} driver=loop model=${providerConfig.model}`,
        `[session] ${sessionId}${isResume ? ' (resumed)' : ' (new)'}`,
        `[prompt] ${prompt}`,
        '',
    ].join('\n'));

    if (opts?.showTerminal) _spawnTailTerminal(agentId, logFile, providerConfig.model);

    const spawnLog = resolve(sdlc-frameworkDir, '.agent-spawns.log');
    appendFileSync(spawnLog, `${new Date().toISOString()} | ${agentId} | loop | session=${sessionId} model=${providerConfig.model} | "${prompt.slice(0, 120)}"\n`);

    // Update status file: isRunning, sessionId, driver
    if (existsSync(statusFile)) {
        try {
            const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
            s.isRunning = true;
            s.driver = 'loop';
            s.sessionId = sessionId;
            s.spawnedPid = null;
            s.startedAt = new Date().toISOString();
            writeFileSync(statusFile, JSON.stringify(s, null, 2));
        } catch { /* non-critical */ }
    }

    runner.on('event', (ev) => {
        const { type, data } = ev as { type: string; data?: { message?: string; name?: string; content?: string; outputLength?: number } };
        const evTs = new Date().toISOString();
        if (type === 'error') {
            console.error(`[agent-runner:${agentId}] error:`, data?.message);
            appendFileSync(logFile, `[error] ${evTs} ${data?.message}\n`);
            appendFileSync(spawnLog, `${evTs} | ${agentId} | loop | ERROR: ${data?.message}\n`);
        } else if (type === 'tool_call') {
            console.log(`[agent-runner:${agentId}] tool: ${data?.name}`);
            appendFileSync(logFile, `[tool] ${evTs} ${data?.name}\n`);
        } else if (type === 'tool_result') {
            appendFileSync(logFile, `[result] ${evTs} ${data?.name} → ${data?.outputLength ?? 0}b\n`);
        } else if (type === 'message') {
            appendFileSync(logFile, `[message] ${evTs} ${String(data?.content ?? '').slice(0, 500)}\n`);
        } else if (type === 'injection') {
            appendFileSync(logFile, `[btw] ${evTs} injected\n`);
        } else if (type === 'complete') {
            console.log(`[agent-runner:${agentId}] complete`);
            appendFileSync(logFile, `[exit] ${evTs} COMPLETE\n`);
            appendFileSync(spawnLog, `${evTs} | ${agentId} | loop | session=${sessionId} COMPLETE\n`);
        }
    });

    const cleanup = (status: 'complete' | 'error') => {
        runners.delete(agentId);
        try { dbEndSession(sessionId!, status); } catch { /* non-critical */ }
        if (existsSync(statusFile)) {
            try {
                const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                s.isRunning = false;
                writeFileSync(statusFile, JSON.stringify(s, null, 2));
            } catch { /* non-critical */ }
        }
    };

    runner.on('complete', () => cleanup('complete'));
    runner.on('error', () => cleanup('error'));

    runners.set(agentId, runner);

    const systemPrompt = buildSystemPrompt(agentId, sdlc-frameworkDir);
    const fullPrompt = `Workspace: ${workspaceDir}\n\n${prompt}`;

    runner.run(systemPrompt, fullPrompt).catch((e: unknown) => {
        console.error(`[agent-runner:${agentId}] unhandled:`, e);
        cleanup('error');
    });

    return runner;
}
