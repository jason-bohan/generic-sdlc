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
        case 'search_in_files': return toolSearchInFiles(a, workspaceDir, frameworkDir);
        case 'update_status':   return toolUpdateStatus(a, workspaceDir, frameworkDir, agentId);
        default:                return `Unknown tool: ${name}`;
    }
}
