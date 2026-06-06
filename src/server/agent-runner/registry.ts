import { resolve } from 'path';
import { existsSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { AgentRunner } from './AgentRunner';
import { OpenAICompatibleProvider, readLoopProviderConfig, detectLoopProvider } from './provider';
import { resolveSmartModel } from '../brainModel';
import { updateTokens } from '../tokens';
import type { TokenSource } from '../tokens';
import {
    dbCreateSession,
    dbGetActiveSession,
    dbUpdateSessionMessages,
    dbEndSession,
    dbGetSession,
} from '../db';
import type { Message } from './types';
import { parseJsonUtf8File } from '../json-file';
import { AGENT_STEP_MODE_PHASES } from '../../shared/agentPhases';

/** Generic phase progression for agents without a role-specific list. */
const GENERIC_PHASE_ORDER = ['analyzing', 'generating-code', 'committing', 'validating', 'creating-pr'];

export const registryEvents = new EventEmitter();
registryEvents.setMaxListeners(50);

const TERMINAL_PHASES = new Set(['idle', 'complete', 'error']);

const runners = new Map<string, AgentRunner>();

/** Map the resolved loop-provider backend to a token-ledger source bucket. */
function loopTokenSource(baseUrl: string): TokenSource {
    switch (detectLoopProvider(baseUrl)) {
        case 'openrouter': return 'cloud';
        case 'meshllm': return 'meshllm';
        case 'ollama': return 'ollama';
        case 'mlx': return 'mlx';
        default: return 'cloud'; // custom OpenAI-compatible endpoint — bucket as cloud
    }
}

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

/**
 * Capable models (cloud-hosted or large local) get prompt *latitude* — the phase
 * steps are framed as guidance they may improve on. Small quantized local models
 * (e.g. Qwen2.5-Coder-14B via MLX) get strict rails because they can't infer the
 * happy path. Heuristic: any openrouter-served model, or a known capable family /
 * large size, is "capable"; everything else (the 14B etc.) is kept strict.
 */
const CAPABLE_MODEL_RE = /(claude|gpt-?4|gpt-5|o[13]-|gemini|deepseek|grok|mistral-large|command-r-plus|llama[-\w.]*?70b|qwen[-\w.]*?(?:32|72)b)/i;
export function isCapablePromptModel(model: string, baseUrl: string): boolean {
    if (detectLoopProvider(baseUrl) === 'openrouter') return true;
    return CAPABLE_MODEL_RE.test(model);
}

function buildSystemPrompt(agentId: string, _frameworkDir: string, promptLatitude: boolean): string {
    const phaseOrder = (AGENT_STEP_MODE_PHASES[agentId] ?? GENERIC_PHASE_ORDER).join(' → ');
    return [
        `You are the ${agentId} agent in the SDLC Framework automation platform.`,
        'You drive one story through every SDLC phase by calling tools. You do the work by calling tools — never in prose.',
        '',
        '## How to call a tool',
        '- Respond with EXACTLY ONE tool call per message, as a single JSON object and nothing else:',
        '    {"name": "read_file", "arguments": {"path": "skills/frontend/SKILL.md"}}',
        '- No prose around it, no second tool in the same message. Then wait for the tool result before the next call.',
        '- CRITICAL: never write a plan instead of acting. If you catch yourself writing "I will..." or "Step 1:", emit the tool call instead.',
        '- If a tool result shows the action already succeeded, move on — never repeat an identical successful call.',
        '- If a file is not found at a relative path, retry with the absolute path shown in the prompt.',
        '',
        '## Tools (call by exact name — no other names are valid)',
        '- read_file{path}, write_file{path,content}, list_directory{path}',
        '- edit_file{path,old_string,new_string} — PREFER THIS to change an existing file. Send only the snippet that changes (old_string must match the file exactly and be unique). Do NOT re-send the whole file via write_file for a small change.',
        '- search_in_files{query,path} — locate code before you edit it',
        '- run_command{command} — run builds, tests, git',
        '- create_task{name,estimate} — register work items (do NOT use http_request for this)',
        '- http_request{url,method?,body?,headers?} — call external APIs',
        '- update_status{phase} — refresh the dashboard; call after each phase',
        '- complete_phase{next_phase,summary,...} — REQUIRED to end every phase',
        '',
        '## Phases (advance in this order)',
        `    ${phaseOrder}`,
        '- Finish the current phase fully, then call complete_phase with next_phase set to the next phase above.',
        '- Always pass next_phase + summary. Also pass the evidence the phase produced:',
        '    designing → design_spec; generating-code → code_changes, branch_plan;',
        '    validating → validation_results, test_results, static_analysis;',
        '    reviewing-pr → review_verdict; monitoring-build → build.',
        '- Report only results you actually produced — never fabricate test, review, or build evidence.',
        '- Call complete_phase exactly once per phase. The runner stops automatically when it succeeds and resumes at the next phase.',
        '',
        '## The framework handles commit & PR — so you can focus',
        '- You do not need to run git add/commit/push or `gh pr create`. In the committing and creating-pr phases, just call complete_phase and the framework stages, commits, pushes, and opens/updates the PR (idempotently) for you.',
        '- This is here to take the git/PR boilerplate off your plate so you can spend your effort where it matters — the implementation, the tests, the review. Doing it by hand only races the framework and creates duplicate/orphan PRs, so let it carry that part.',
        '',
        ...(promptLatitude ? [
            '## Latitude (you are a capable model)',
            '- The per-phase steps are guidance, not a rigid script. On the reasoning phases (analyzing, generating-code, addressing-feedback), back your own judgment on the approach whenever it produces a better result — that is exactly where your effort is most valuable, so aim high.',
            '- The framework owning commit/PR (above) is what frees you to focus there. Pour your effort into the work itself; let the framework handle the plumbing.',
            '',
        ] : []),
        '## Start & interrupts',
        '- Begin by reading your skill guide (path is in the first user message) with read_file, then work the phases.',
        '- IMMEDIATELY read the project package.json (or equivalent) to discover the tech stack, framework, and test runner — never assume.',
        '- When you receive a [/btw] message, address it at the next logical break point.',
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
    frameworkDir: string,
    workspaceDir: string,
    configPath: string,
    model?: string,
    opts?: { showTerminal?: boolean },
): AgentRunner {
    stopRunner(agentId);

    const modelOverride = model && model !== 'auto' && model !== 'local' && model !== 'cloud' ? model : undefined;
    // The reviewer is a "brain" role (see brainModel.ts): review is judgment-heavy and the
    // local 14B can't drive it, so escalate to the cloud brain (OpenRouter, e.g. deepseek-v3.2)
    // via resolveSmartModel — a direct OpenAI-compatible call, no opencode subprocess. Falls
    // back to the local loop provider automatically when no cloud key is set. Every other agent
    // stays on the local loopProvider — UNLESS spawned with model='cloud' (the rework-cap
    // escalation: a dev that has looped against the reviewer gets one cloud-brain attempt).
    const useBrain = agentId === 'reviewer' || model === 'cloud';
    const providerConfig = useBrain
        ? (() => { const sm = resolveSmartModel(configPath); return { baseUrl: sm.baseUrl, model: sm.model, apiKey: sm.apiKey, maxTokens: 4096 }; })()
        : readLoopProviderConfig(configPath, modelOverride);
    const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
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
    const runner = new AgentRunner(agentId, provider, workspaceDir, frameworkDir, configPath, {
        sessionId,
        initialMessages,
        onCheckpoint: (messages) => {
            try {
                dbUpdateSessionMessages(sessionId!, JSON.stringify(messages), readCurrentPhase(statusFile));
            } catch { /* non-critical */ }
        },
    });

    // Output log — same location the dashboard polls
    const outputDir = resolve(frameworkDir, '.agent-output');
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

    const spawnLog = resolve(frameworkDir, '.agent-spawns.log');
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
        const { type, data } = ev as { type: string; data?: { message?: string; name?: string; content?: string; outputLength?: number; usage?: { input: number; output: number } } };
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
        } else if (type === 'phase_complete') {
            const nextPhase = (data as { nextPhase?: string })?.nextPhase ?? '?';
            console.log(`[agent-runner:${agentId}] phase complete → ${nextPhase}`);
            appendFileSync(logFile, `[phase_complete] ${evTs} → ${nextPhase}\n`);
            appendFileSync(spawnLog, `${evTs} | ${agentId} | loop | session=${sessionId} PHASE_COMPLETE → ${nextPhase}\n`);
        } else if (type === 'injection') {
            appendFileSync(logFile, `[btw] ${evTs} injected\n`);
        } else if (type === 'complete') {
            console.log(`[agent-runner:${agentId}] complete`);
            appendFileSync(logFile, `[exit] ${evTs} COMPLETE\n`);
            appendFileSync(spawnLog, `${evTs} | ${agentId} | loop | session=${sessionId} COMPLETE\n`);
            // Record token usage to the ledger. The in-process loop driver is the
            // only agent path with the model's usage in hand (subprocess drivers
            // pipe to a log and report nothing). updateTokens also attributes the
            // story from the status file and updates per-source status accounting.
            const usage = data?.usage;
            if (usage && (usage.input > 0 || usage.output > 0)) {
                try {
                    updateTokens(frameworkDir, {
                        agentId,
                        source: loopTokenSource(providerConfig.baseUrl),
                        input: usage.input,
                        output: usage.output,
                        phase: agentId === 'reviewer' ? 'review' : 'development',
                    });
                    appendFileSync(logFile, `[tokens] ${evTs} recorded input=${usage.input} output=${usage.output} source=${loopTokenSource(providerConfig.baseUrl)}\n`);
                } catch { /* non-critical — ledger is informational for AIQA */ }
            }
        }
    });

    const cleanup = (status: 'complete' | 'error') => {
        runners.delete(agentId);
        try { dbEndSession(sessionId!, status); } catch { /* non-critical */ }
        let stoppedPhase: string | null = null;
        if (existsSync(statusFile)) {
            try {
                const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                const phase = String(s.currentPhase ?? 'idle');
                if (!TERMINAL_PHASES.has(phase)) stoppedPhase = phase;
                s.isRunning = false;
                writeFileSync(statusFile, JSON.stringify(s, null, 2));
            } catch { /* non-critical */ }
        }
        if (status === 'complete' && stoppedPhase) {
            registryEvents.emit('agent-stopped', { agentId, phase: stoppedPhase, configPath, frameworkDir });
        }
    };

    runner.on('complete', () => cleanup('complete'));
    runner.on('error', () => cleanup('error'));

    runners.set(agentId, runner);

    const promptLatitude = isCapablePromptModel(providerConfig.model, providerConfig.baseUrl);
    const systemPrompt = buildSystemPrompt(agentId, frameworkDir, promptLatitude);
    const fullPrompt = `Workspace: ${workspaceDir}\n\n${prompt}`;

    runner.run(systemPrompt, fullPrompt).catch((e: unknown) => {
        console.error(`[agent-runner:${agentId}] unhandled:`, e);
        cleanup('error');
    });

    return runner;
}
