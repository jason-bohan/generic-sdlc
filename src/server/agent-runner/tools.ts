import {
    existsSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    mkdirSync,
    statSync,
} from 'fs';
import { resolve, dirname, relative, sep } from 'path';
import { execFile } from 'child_process';
import { isMockExternalMode } from '../external-mode';
import { ensureMockShims } from '../mock-mode-guard';
import { emitStatusChange } from '../status-events';
import { buildStatusBroadcast } from '../status-broadcast';
import type { ToolDefinition } from './types';
import { parseJsonUtf8File } from '../json-file';

// ---------------------------------------------------------------------------
// Tool definitions (sent to the LLM)
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file. Path may be absolute or relative to the workspace root.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write (or overwrite) a file. Creates parent directories if needed.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to write' },
                    content: { type: 'string', description: 'Content to write' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List files and subdirectories at a path.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path' },
                    recursive: { type: 'boolean', description: 'List recursively (default false)' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command (git, dotnet, nx, npm, etc.) and return stdout + stderr.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Executable or shell command' },
                    args: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Arguments list',
                    },
                    cwd: {
                        type: 'string',
                        description: 'Working directory (defaults to workspace root)',
                    },
                    timeout_ms: {
                        type: 'number',
                        description: 'Timeout in ms (default 120000)',
                    },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_in_files',
            description: 'Search for a text pattern across files. Returns matching lines with file paths.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Text to search for (case-insensitive)' },
                    directory: {
                        type: 'string',
                        description: 'Directory to search in (defaults to workspace root)',
                    },
                    extensions: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'File extensions to include, e.g. [".ts", ".cs"] (defaults to all)',
                    },
                    max_results: {
                        type: 'number',
                        description: 'Maximum number of matching lines to return (default 50)',
                    },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'http_request',
            description: 'Make an HTTP request to a URL. Use this to call the SDLC API (create tasks, complete phases, etc.) instead of curl.',
            parameters: {
                type: 'object',
                properties: {
                    method: { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, DELETE' },
                    url: { type: 'string', description: 'Full URL to request' },
                    body: { type: 'object', description: 'JSON body to send (for POST/PUT/PATCH)' },
                    headers: { type: 'object', description: 'Additional headers (optional)' },
                },
                required: ['method', 'url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_task',
            description: 'Create an implementation task for the current story. Returns the task ID.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Short task name, e.g. "Add input validation to POST /api/tasks"' },
                    estimate: { type: 'number', description: 'Estimated hours (1-8)' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'complete_phase',
            description: 'Mark the current SDLC phase as complete and advance to the next phase. Call this to signal phase completion — do NOT use http_request for this. Required at the end of every phase.',
            parameters: {
                type: 'object',
                properties: {
                    next_phase: { type: 'string', description: 'Next phase id to advance to (e.g. "analyzing", "generating-code", "creating-pr")' },
                    summary: { type: 'string', description: 'Short human-readable summary of what was accomplished in this phase' },
                    branch_plan: { type: 'string', description: 'Git branch name for this story, e.g. "fix/2-validate-input". Required for phases that produce branchPlan.' },
                    risks: { type: 'string', description: 'Risks or blockers identified. Required for phases that produce risks; use "None identified" only after actually checking.' },
                    open_questions: { type: 'string', description: 'Open questions or unknowns. Required for phases that produce openQuestions; use "None" only after actually checking.' },
                    test_matrix: { type: 'string', description: 'Test plan or test matrix description. Required for phases that produce testMatrix.' },
                    code_changes: { type: 'string', description: 'Summary of code changes made (for generating-code / validating phases)' },
                    classification: { type: 'string', description: 'Story classification, e.g. "feature", "bug", "refactor"' },
                    affected_repo: { type: 'string', description: 'Name of the affected repository or project' },
                    review_verdict: { type: 'string', description: 'Review decision: "approved", "request-changes", or "rejected" (for reviewing-pr phase)' },
                    design_spec: { type: 'string', description: 'Design specification summary (for designing phase)' },
                    validation_results: { type: 'string', description: 'Validation/lint/build results summary' },
                    test_results: { type: 'string', description: 'Test run results summary' },
                    static_analysis: { type: 'string', description: 'Static analysis results summary' },
                    build: { type: 'string', description: 'Build outcome summary' },
                },
                required: ['next_phase', 'summary'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_status',
            description: 'Update the agent status file. Call this after completing each phase.',
            parameters: {
                type: 'object',
                properties: {
                    phase: { type: 'string', description: 'Current phase name (e.g. "analyzing", "coding", "creating-pr")' },
                    storyNumber: { type: 'string', description: 'Story number being worked on' },
                    currentTask: { type: 'string', description: 'Short description of what is being done right now' },
                    message: { type: 'string', description: 'Human-readable status message' },
                    tasks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                                status: { type: 'string' },
                            },
                        },
                        description: 'Task list for the current story',
                    },
                },
                required: ['phase'],
            },
        },
    },
];

// ---------------------------------------------------------------------------
// Path safety helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path relative to workspaceDir if relative,
 * or as-is if absolute, and verify it stays under one of the allowedRoots.
 *
 * Uses path.relative() rather than startsWith() to prevent sibling-path
 * escapes (e.g. /repos/workspace-evil matching root /repos/workspace).
 *
 * Returns { ok: true, resolved } or { ok: false, error }.
 */
function safePath(
    inputPath: string,
    workspaceDir: string,
    allowedRoots: string[],
): { ok: true; resolved: string } | { ok: false; error: string } {
    const isAbsolute = /^[A-Za-z]:[/\\]/.test(inputPath) || inputPath.startsWith('/');
    const resolved = isAbsolute ? resolve(inputPath) : resolve(workspaceDir, inputPath);

    for (const root of allowedRoots) {
        const rel = relative(resolve(root), resolved);
        // rel that doesn't start with '..' means resolved is under root.
        // An empty rel means they are the same path — also allowed.
        // On Windows, cross-drive relative paths always start with '..', so this is safe.
        if (!rel.startsWith('..')) {
            return { ok: true, resolved };
        }
    }

    return {
        ok: false,
        error: `Path "${resolved}" is outside allowed roots: ${allowedRoots.join(', ')}. Use a relative path or a path within the workspace.`,
    };
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

function toolReadFile(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
    const check = safePath(String(args.path ?? ''), workspaceDir, [workspaceDir, frameworkDir]);
    if (!check.ok) return `Error: ${check.error}`;
    if (!existsSync(check.resolved)) return `Error: file not found: ${check.resolved}`;
    try {
        const content = readFileSync(check.resolved, 'utf-8');
        return content.length > 200_000
            ? content.slice(0, 200_000) + `\n\n[... truncated at 200KB, total ${content.length} bytes]`
            : content;
    } catch (e) {
        return `Error reading file: ${e instanceof Error ? e.message : String(e)}`;
    }
}

function toolWriteFile(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
): string {
    const check = safePath(String(args.path ?? ''), workspaceDir, [workspaceDir, frameworkDir]);
    if (!check.ok) return `Error: ${check.error}`;
    const content = String(args.content ?? '');
    try {
        mkdirSync(dirname(check.resolved), { recursive: true });
        writeFileSync(check.resolved, content, 'utf-8');
        return `Written ${content.length} bytes to ${check.resolved}`;
    } catch (e) {
        return `Error writing file: ${e instanceof Error ? e.message : String(e)}`;
    }
}

function toolListDirectory(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
    const check = safePath(String(args.path ?? '.'), workspaceDir, [workspaceDir, frameworkDir]);
    if (!check.ok) return `Error: ${check.error}`;
    const path = check.resolved;
    const recursive = args.recursive === true;
    if (!existsSync(path)) return `Error: path not found: ${path}`;
    try {
        if (recursive) {
            const entries: string[] = [];
            const walk = (dir: string, depth: number) => {
                if (depth > 6) return;
                for (const entry of readdirSync(dir)) {
                    if (entry === 'node_modules' || entry === '.git') continue;
                    const full = resolve(dir, entry);
                    const rel = relative(path, full);
                    const stat = statSync(full);
                    entries.push(stat.isDirectory() ? `${rel}/` : rel);
                    if (stat.isDirectory()) walk(full, depth + 1);
                }
            };
            walk(path, 0);
            return entries.join('\n') || '(empty)';
        }
        const entries = readdirSync(path).map((e) => {
            const full = resolve(path, e);
            return statSync(full).isDirectory() ? `${e}/` : e;
        });
        return entries.join('\n') || '(empty)';
    } catch (e) {
        return `Error listing directory: ${e instanceof Error ? e.message : String(e)}`;
    }
}

function toolRunCommand(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
    configPath: string,
): Promise<string> {
    const command = String(args.command ?? '');
    const argsList = Array.isArray(args.args) ? (args.args as string[]) : [];
    let cwd = workspaceDir;
    if (args.cwd) {
        const cwdCheck = safePath(String(args.cwd), workspaceDir, [workspaceDir, frameworkDir]);
        if (!cwdCheck.ok) return Promise.resolve(`Error: ${cwdCheck.error}`);
        cwd = cwdCheck.resolved;
    }
    const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000;

    // Mirror the mock-mode guard from _doSpawn: prepend mock-bin shims to PATH
    // so `git push`, `az`, etc. are blocked when running under mock/test mode.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (isMockExternalMode(configPath)) {
        const mockBin = ensureMockShims(frameworkDir);
        env.PATH = `${mockBin};${env.PATH || ''}`;
        env.SDLC_FRAMEWORK_MOCK_MODE = '1';
    }

    return new Promise((resolvePromise) => {
        execFile(command, argsList, {
            cwd,
            timeout,
            maxBuffer: 2 * 1024 * 1024,
            shell: true,
            windowsHide: true,
            env,
        }, (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').trim();
            if (err && !out) {
                resolvePromise(`Error (exit ${err.code ?? '?'}): ${err.message}`);
            } else if (err) {
                resolvePromise(`Exit ${err.code ?? '?'}:\n${out}`);
            } else {
                resolvePromise(out || '(no output)');
            }
        });
    });
}

async function toolCreateTask(
    args: Record<string, unknown>,
    frameworkDir: string,
    agentId: string,
): Promise<string> {
    const name = String(args.name ?? '').trim();
    if (!name) return 'Error: task name is required';
    const estimate = typeof args.estimate === 'number' ? args.estimate : 2;

    // Read storyNumber from status file
    const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
    let storyNumber = '1';
    try {
        const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        if (typeof s.storyNumber === 'string') storyNumber = s.storyNumber;
    } catch { /* use default */ }

    try {
        const serverBaseUrl = process.env.SDLC_SERVER_URL || 'http://localhost:3001';
        const res = await fetch(`${serverBaseUrl}/api/scheduler/create-task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, storyNumber, name, estimate }),
            signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        // When the story number isn't in VersionOne (plain GitHub issue numbers),
        // fall back to writing the task directly into the status file.
        if (res.status === 404 && text.includes('not found')) {
            return toolCreateTaskLocal(name, estimate, storyNumber, statusFile);
        }
        return `HTTP ${res.status}\n${text.slice(0, 1000)}`;
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

function toolCreateTaskLocal(name: string, estimate: number, storyNumber: string, statusFile: string): string {
    try {
        const s = existsSync(statusFile) ? parseJsonUtf8File(statusFile) as Record<string, unknown> : {};
        const tasks = Array.isArray(s.tasks) ? s.tasks as Array<Record<string, unknown>> : [];
        const taskNumber = `T-${String(tasks.length + 1).padStart(3, '0')}`;
        tasks.push({ id: taskNumber, number: taskNumber, name, status: 'pending', hours: estimate, source: 'local', inherited: false });
        s.tasks = tasks;
        writeFileSync(statusFile, JSON.stringify(s, null, 2));
        return `HTTP 200\n${JSON.stringify({ ok: true, number: taskNumber, name })}`;
    } catch (e) {
        return `Error writing task locally: ${e instanceof Error ? e.message : String(e)}`;
    }
}

async function toolCompletePhase(
    args: Record<string, unknown>,
    frameworkDir: string,
    agentId: string,
): Promise<string> {
    const nextPhase = String(args.next_phase ?? 'analyzing');
    const summary = String(args.summary ?? '');

    const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
    let workflowItemId: number | null = null;
    let storyNumber = '1';
    let tasks: unknown[] = [];
    let currentPhase = 'reading-story';
    try {
        const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        if (typeof s.workflowItemId === 'number') workflowItemId = s.workflowItemId;
        if (typeof s.storyNumber === 'string') storyNumber = s.storyNumber;
        if (Array.isArray(s.tasks)) tasks = s.tasks;
        if (typeof s.currentPhase === 'string' && s.currentPhase) currentPhase = s.currentPhase;
    } catch { /* use defaults */ }

    if (!workflowItemId) return 'Error: workflowItemId not found in status file. The workflow must be registered before completing a phase.';

    const taskIds = tasks.map((t: unknown) => (t as Record<string, unknown>)?.id ?? '').filter(Boolean);

    const outputs: Record<string, unknown> = {
        tasks,
        taskIds,
        auditEvent: {
            action: `${currentPhase}-complete`,
            storyNumber,
            agentId,
            nextPhase,
            timestamp: new Date().toISOString(),
        },
    };
    const putIfProvided = (key: string, value: unknown) => {
        if (value !== undefined && value !== null) outputs[key] = value;
    };
    const stringArg = (key: string) => args[key] === undefined || args[key] === null ? undefined : String(args[key]);
    putIfProvided('branchPlan', stringArg('branch_plan'));
    putIfProvided('risks', stringArg('risks'));
    putIfProvided('openQuestions', stringArg('open_questions'));
    if (args.test_matrix !== undefined && args.test_matrix !== null) {
        outputs.testMatrix = Array.isArray(args.test_matrix) ? args.test_matrix : [String(args.test_matrix)];
    }
    putIfProvided('codeChanges', stringArg('code_changes'));
    putIfProvided('classification', stringArg('classification'));
    putIfProvided('affectedRepo', stringArg('affected_repo'));
    putIfProvided('handoff', args.handoff);
    putIfProvided('designSpec', stringArg('design_spec'));
    putIfProvided('validationResults', stringArg('validation_results'));
    putIfProvided('reviewVerdict', stringArg('review_verdict'));
    if (Array.isArray(args.review_threads)) outputs.reviewThreads = args.review_threads;
    putIfProvided('testResults', stringArg('test_results'));
    putIfProvided('staticAnalysis', stringArg('static_analysis'));
    putIfProvided('build', stringArg('build'));
    putIfProvided('pr', args.pr);
    putIfProvided('mockPr', args.mock_pr);

    const serverBaseUrl = process.env.SDLC_SERVER_URL || 'http://localhost:3001';
    const payload = { workflowItemId, agentId, phase: currentPhase, nextPhase, outputs, message: summary };

    try {
        const res = await fetch(`${serverBaseUrl}/api/workflows/complete-phase`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        if (res.ok) {
            try {
                const status = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                status.currentPhase = nextPhase;
                writeFileSync(statusFile, JSON.stringify(status, null, 2));
                emitStatusChange(agentId, buildStatusBroadcast(status, agentId, true, frameworkDir));
            } catch { /* workflow completion succeeded; do not mask the server response */ }
            // Sentinel prefix tells AgentRunner to stop the loop immediately so
            // the next phase starts with a fresh conversation context.
            return `PHASE_COMPLETE::${nextPhase}\nHTTP ${res.status}\n${text.slice(0, 500)}`;
        }
        return `HTTP ${res.status}\n${text.slice(0, 1000)}`;
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

async function toolHttpRequest(args: Record<string, unknown>): Promise<string> {
    const method = String(args.method ?? 'GET').toUpperCase();
    const url = String(args.url ?? '');
    if (!url) return 'Error: url is required';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (args.headers && typeof args.headers === 'object') {
        for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
            headers[k] = String(v);
        }
    }

    const init: RequestInit = { method, headers };
    if (args.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    }

    try {
        const res = await fetch(url, init);
        const text = await res.text();
        return `HTTP ${res.status} ${res.statusText}\n${text.slice(0, 4000)}`;
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

function toolSearchInFiles(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
    const pattern = String(args.pattern ?? '').toLowerCase();
    let dir = workspaceDir;
    if (args.directory) {
        const dirCheck = safePath(String(args.directory), workspaceDir, [workspaceDir, frameworkDir]);
        if (!dirCheck.ok) return `Error: ${dirCheck.error}`;
        dir = dirCheck.resolved;
    }
    const exts = Array.isArray(args.extensions)
        ? (args.extensions as string[]).map((e) => (e.startsWith('.') ? e : `.${e}`))
        : null;
    const maxResults = typeof args.max_results === 'number' ? args.max_results : 50;

    const results: string[] = [];

    const walk = (d: string, depth: number) => {
        if (depth > 8 || results.length >= maxResults) return;
        let entries: string[];
        try { entries = readdirSync(d); } catch { return; }
        for (const entry of entries) {
            if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'bin' || entry === 'obj') continue;
            const full = resolve(d, entry);
            let stat;
            try { stat = statSync(full); } catch { continue; }
            if (stat.isDirectory()) {
                walk(full, depth + 1);
            } else if (!exts || exts.some((ext) => entry.endsWith(ext))) {
                try {
                    const lines = readFileSync(full, 'utf-8').split('\n');
                    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                        if (lines[i].toLowerCase().includes(pattern)) {
                            results.push(`${relative(workspaceDir, full)}:${i + 1}: ${lines[i].trim()}`);
                        }
                    }
                } catch { /* skip unreadable */ }
            }
        }
    };

    if (!existsSync(dir)) return `Error: directory not found: ${dir}`;
    walk(dir, 0);
    return results.length > 0
        ? results.join('\n')
        : `No matches found for "${args.pattern}"`;
}

function toolUpdateStatus(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
): string {
    const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
    try {
        const existing = existsSync(statusFile)
            ? parseJsonUtf8File(statusFile) as Record<string, unknown>
            : {};

        const updated: Record<string, unknown> = {
            ...existing,
            currentPhase: args.phase,
            updatedAt: new Date().toISOString(),
        };
        if (args.storyNumber !== undefined) updated.storyNumber = args.storyNumber;
        if (args.currentTask !== undefined) updated.currentTask = args.currentTask;
        if (args.tasks !== undefined) updated.tasks = args.tasks;

        if (!Array.isArray(updated.events)) updated.events = [];
        (updated.events as unknown[]).push({
            timestamp: new Date().toISOString(),
            type: 'phase',
            message: args.message ?? `Phase: ${args.phase}`,
        });

        writeFileSync(statusFile, JSON.stringify(updated, null, 2));
        emitStatusChange(agentId, buildStatusBroadcast(updated, agentId, true, frameworkDir));
        return `Status updated: phase=${args.phase}`;
    } catch (e) {
        return `Error updating status: ${e instanceof Error ? e.message : String(e)}`;
    }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function executeToolCall(
    name: string,
    args: unknown,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
    configPath: string,
): Promise<string> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;

    switch (name) {
        case 'read_file':       return toolReadFile(a, workspaceDir, frameworkDir);
        case 'write_file':      return toolWriteFile(a, workspaceDir, frameworkDir);
        case 'list_directory':  return toolListDirectory(a, workspaceDir, frameworkDir);
        case 'run_command':     return toolRunCommand(a, workspaceDir, frameworkDir, configPath);
        case 'http_request':    return toolHttpRequest(a);
        case 'create_task':     return toolCreateTask(a, frameworkDir, agentId);
        case 'complete_phase':  return toolCompletePhase(a, frameworkDir, agentId);
        case 'search_in_files': return toolSearchInFiles(a, workspaceDir, frameworkDir);
        case 'update_status':   return toolUpdateStatus(a, workspaceDir, frameworkDir, agentId);
        default: {
            // Local 14B models often emit the task *description* as the tool name
            // (e.g. {"name":"Add validation to POST /api/tasks","arguments":{...}}).
            // If the name contains spaces it's almost certainly a task title — route it.
            if (name.includes(' ') || name.length > 40) {
                return toolCreateTask({ ...a, name }, frameworkDir, agentId);
            }
            return `Unknown tool: ${name}`;
        }
    }
}
