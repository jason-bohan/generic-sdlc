import {
    existsSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    mkdirSync,
    statSync,
} from 'fs';
import { resolve, dirname, relative, sep, basename } from 'path';
import { execFile, execFileSync } from 'child_process';
import { isMockExternalMode } from '../external-mode';
import { isGlobalStepMode, isAgentStepMode } from '../stepMode';
import { ensureMockShims } from '../mock-mode-guard';
import { emitStatusChange } from '../status-events';
import { buildStatusBroadcast } from '../status-broadcast';
import { normalizeReviewerVerdict, reviewerPhaseForVerdict } from '../reviewer-verdict';
import { getSdlcPhaseContract, type SdlcPhaseId } from '../../shared/sdlcContracts';
import type { ToolDefinition } from './types';
import { parseJsonUtf8File } from '../json-file';
import { createWorkerPool } from '../workerPool';

// ---------------------------------------------------------------------------
// Tool definitions (sent to the LLM)
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file. Path may be absolute or relative to the workspace root. In the early understanding phases, large files come back as a concise summary to save context; pass full:true (or read again once you are editing) to get exact contents.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read' },
                    full: { type: 'boolean', description: 'Return the exact full file contents even in an understanding phase (needed before editing). Default false = may be summarized for large files.' },
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
            name: 'edit_file',
            description: 'Make a targeted edit to an existing file by replacing one exact snippet with another. PREFER THIS over write_file for changing existing files — you only send the small piece that changes, not the whole file. old_string must appear EXACTLY once in the file (include enough surrounding context to be unique).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to edit' },
                    old_string: { type: 'string', description: 'Exact text to find (must be unique in the file)' },
                    new_string: { type: 'string', description: 'Text to replace it with' },
                },
                required: ['path', 'old_string', 'new_string'],
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
            name: 'run_validation',
            description: 'Validating phase only: run the project\'s type-check, build, and tests for the current story and return a structured pass/fail report. The framework runs the commands for you — do NOT run npm/tsc/git yourself. After calling this, pass its results straight into complete_phase.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Worktree path to validate. Optional — auto-detected from the story worktree if omitted.',
                    },
                },
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
            name: 'grep',
            description: 'Search files using a regular expression. Like the CLI grep command. Returns matching lines with file paths.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Regex pattern to search for (case-insensitive by default)' },
                    directory: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
                    include: { type: 'string', description: 'Glob pattern for file names to include, e.g. "*.ts", "*.{ts,tsx}" (defaults to all)' },
                    max_results: { type: 'number', description: 'Maximum results to return (default 50)' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read',
            description: 'Read the contents of a file. Like the CLI cat/less command. Returns the full file contents.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read' },
                    offset: { type: 'number', description: 'Starting line number (1-indexed, default 1)' },
                    limit: { type: 'number', description: 'Max lines to return (default all)' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'glob',
            description: 'Find files matching a glob pattern. Like the CLI find/ls command with wildcards.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts", "src/**/*.test.*"' },
                    directory: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'summarize_file',
            description: 'Read a file and return a concise summary using a cheap 1-bit worker model. Use this instead of read_file when you only need to know what a file does, not its full contents — saves context for the main model.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to summarize' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'summarize_search',
            description: 'Search for a pattern across the codebase and return a grouped summary using a cheap 1-bit worker model. Use this instead of search_in_files or grep when you have a broad pattern and want a concise per-file summary rather than raw line matches.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Text pattern or regex to search for' },
                    directory: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
                    include: { type: 'string', description: 'Glob pattern for file names to include, e.g. "*.ts", "*.{ts,tsx}"' },
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
                    verdict: { type: 'string', description: 'Review verdict (reviewer only): "approved" or "changes-requested". Set this on your FINAL review update — it routes the PR (approved → devops; changes-requested → back to the author) and the phase is set to match automatically. Non-blocking nits do NOT block: nits-only → "approved".' },
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

// Phases where the agent is UNDERSTANDING the codebase (not yet editing). Here a large
// read_file is auto-routed through the cheap worker as a summary to save the main model's
// context — adoption of the parallel reader isn't left to the 8B's discretion (it reflexively
// uses read_file and ignores summarize_file). In editing phases read_file stays full-content
// so edit_file gets the exact text it needs.
const UNDERSTANDING_PHASES = new Set(['reading-story', 'analyzing']);
const READ_SUMMARIZE_MIN_CHARS = 1500;

function readAgentPhase(frameworkDir: string, agentId: string): string {
    try {
        const s = parseJsonUtf8File(resolve(frameworkDir, `.${agentId}-status.json`)) as { currentPhase?: string };
        return String(s.currentPhase ?? '');
    } catch { return ''; }
}

async function toolReadFile(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string, agentId: string, configPath: string): Promise<string> {
    const check = safePath(String(args.path ?? ''), workspaceDir, [workspaceDir, frameworkDir]);
    if (!check.ok) return `Error: ${check.error}`;
    if (!existsSync(check.resolved)) return `Error: file not found: ${check.resolved}`;
    try {
        const content = readFileSync(check.resolved, 'utf-8');
        // Understanding phase + large file → return a worker summary (context-saving),
        // unless the model explicitly asked for the full file (args.full === true).
        if (args.full !== true && content.length >= READ_SUMMARIZE_MIN_CHARS && UNDERSTANDING_PHASES.has(readAgentPhase(frameworkDir, agentId))) {
            try {
                const summary = await getOrCreateWorkerPool(configPath).summarizeFile(check.resolved, content);
                if (summary && summary.trim()) {
                    return `[worker summary of ${String(args.path)} — ${content.length} bytes condensed by a cheap reader to save context. Re-read with {"full": true} (or read_file in a later phase) for exact contents before editing.]\n\n${summary}`;
                }
            } catch { /* worker unavailable — fall through to full content */ }
        }
        return content.length > 200_000
            ? content.slice(0, 200_000) + `\n\n[... truncated at 200KB, total ${content.length} bytes]`
            : content;
    } catch (e) {
        return `Error reading file: ${e instanceof Error ? e.message : String(e)}`;
    }
}

/**
 * Resolve a path for WRITING with plumbing protection: agents may READ the framework
 * (skills, configs) but may not WRITE into it while working on a different target
 * project — they don't get to modify their own tooling (yet). When the framework IS
 * the active workspace (self-development), workspaceDir === frameworkDir and writes
 * are allowed normally.
 */
function resolveWritablePath(
    inputPath: string,
    workspaceDir: string,
    frameworkDir: string,
): { ok: true; resolved: string } | { ok: false; error: string } {
    const check = safePath(inputPath, workspaceDir, [workspaceDir]);
    if (check.ok) return check;
    const intoFramework = safePath(inputPath, workspaceDir, [frameworkDir]);
    if (intoFramework.ok && resolve(frameworkDir) !== resolve(workspaceDir)) {
        return { ok: false, error: `writing into the SDLC framework (${frameworkDir}) is not allowed — agents may not modify their own tooling. Write only inside the target workspace: ${workspaceDir}` };
    }
    return check;
}

function toolWriteFile(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
): string {
    const check = resolveWritablePath(String(args.path ?? ''), workspaceDir, frameworkDir);
    if (!check.ok) return `Error: ${check.error}`;
    const resolved = maybeRedirectToWorktree(check.resolved, workspaceDir, frameworkDir, agentId);
    const content = String(args.content ?? '');
    try {
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, content, 'utf-8');
        return `Written ${content.length} bytes to ${resolved}`;
    } catch (e) {
        return `Error writing file: ${e instanceof Error ? e.message : String(e)}`;
    }
}

/**
 * Targeted edit: replace one exact, unique snippet in an existing file. This is the
 * preferred mutation for small local models — instead of re-serializing a whole file
 * as escaped JSON (which a 4-bit 14B routinely mangles, so the write never lands),
 * the model emits only the few changed bytes.
 */
function toolEditFile(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
): string {
    const check = resolveWritablePath(String(args.path ?? ''), workspaceDir, frameworkDir);
    if (!check.ok) return `Error: ${check.error}`;
    const resolved = maybeRedirectToWorktree(check.resolved, workspaceDir, frameworkDir, agentId);
    if (!existsSync(resolved)) return `Error: file not found: ${resolved}. Use write_file to create a new file.`;
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    if (!oldStr) return 'Error: old_string is required and must be non-empty. Provide the exact text to replace.';
    if (oldStr === newStr) return 'Error: old_string and new_string are identical — nothing to change.';
    try {
        const content = readFileSync(resolved, 'utf-8');
        const idx = content.indexOf(oldStr);
        if (idx === -1) return `Error: old_string not found in ${resolved}. It must match the file exactly (whitespace included). Re-read the file and copy the snippet precisely.`;
        if (content.indexOf(oldStr, idx + oldStr.length) !== -1) {
            return `Error: old_string appears multiple times in ${resolved}. Add more surrounding context so it matches exactly once.`;
        }
        writeFileSync(resolved, content.slice(0, idx) + newStr + content.slice(idx + oldStr.length), 'utf-8');
        return `Edited ${resolved} (1 replacement: -${oldStr.length} +${newStr.length} chars)`;
    } catch (e) {
        return `Error editing file: ${e instanceof Error ? e.message : String(e)}`;
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

type ExecResult = { err: (Error & { code?: number | string }) | null; out: string };

/** Extract the `.claude/worktrees/<name>` target path from a `git worktree add` command. */
export function parseWorktreeAddPath(command: string): string | null {
    if (!/\bworktree\s+add\b/.test(command)) return null;
    const m = command.match(/(?:"([^"]*\.claude[\\/]worktrees[\\/][^"\s]+)"|'([^']*\.claude[\\/]worktrees[\\/][^'\s]+)'|([^\s]*\.claude[\\/]worktrees[\\/][^\s]+))/);
    return (m?.[1] ?? m?.[2] ?? m?.[3] ?? null);
}

/** Extract the branch passed to `git worktree add -b/-B <branch> ...`, if present. */
export function parseWorktreeAddBranch(command: string): string | null {
    if (!/\bworktree\s+add\b/.test(command)) return null;
    const m = command.match(/(?:^|\s)-[bB]\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    return (m?.[1] ?? m?.[2] ?? m?.[3] ?? null);
}

/** Parse `git worktree list --porcelain` output into {path, branch} records. */
export function parseWorktreeList(porcelain: string): Array<{ path: string; branch: string | null }> {
    return porcelain.split(/\n\s*\n/)
        .map((block) => {
            const path = (block.match(/^worktree\s+(.+)$/m) || [])[1];
            if (!path) return null;
            const branch = (block.match(/^branch\s+refs\/heads\/(.+)$/m) || [])[1] || null;
            return { path: path.trim(), branch };
        })
        .filter((x): x is { path: string; branch: string | null } => x !== null);
}

/**
 * Last-resort recovery: the orchestrator suggests a deterministic worktree path
 * (`.claude/worktrees/<name>`). When a leftover *directory* (not a reusable
 * registered worktree) blocks `git worktree add`, rewrite the command to a fresh
 * `<name>-N` path (and a matching `-b <branch>-N`) so setup never hard-fails.
 * Prefer reusing an existing registered worktree (see toolRunCommand) over this —
 * a fresh worktree starts from `main` and loses work from earlier phases.
 * Returns null when the command isn't a recognizable worktree-add we can recover.
 */
export function rewriteWorktreeAddOnCollision(command: string, cwd: string): string | null {
    if (!/\bworktree\s+add\b/.test(command)) return null;
    const match = command.match(/\.claude\/worktrees\/[A-Za-z0-9._\-/]+/);
    if (!match) return null;
    const origPath = match[0];
    let n = 2;
    while (n < 100 && existsSync(resolve(cwd, `${origPath}-${n}`))) n++;
    const suffix = `-${n}`;
    let rewritten = command.split(origPath).join(`${origPath}${suffix}`);
    // Keep the branch name unique too, or the fresh worktree collides on the branch.
    rewritten = rewritten.replace(/(-b\s+|-B\s+)(\S+)/, (_full, flag, branch) => `${flag}${branch}${suffix}`);
    return rewritten === command ? null : rewritten;
}

function resolveMaybeWindowsPath(cwd: string, path: string): string {
    return resolve(cwd, path.replace(/[\\/]+/g, sep));
}

function parseWorktreeCommandCwd(command: string, fallbackCwd: string): string {
    const cd = command.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&/);
    if (cd) return resolveMaybeWindowsPath(fallbackCwd, cd[1] ?? cd[2] ?? cd[3]);
    const gitC = command.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+worktree\s+add\b/);
    if (gitC) return resolveMaybeWindowsPath(fallbackCwd, gitC[1] ?? gitC[2] ?? gitC[3]);
    return fallbackCwd;
}

function toolRunCommand(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
    configPath: string,
    agentId: string,
): Promise<string> {
    const command = String(args.command ?? '');
    const argsList = Array.isArray(args.args) ? (args.args as string[]) : [];
    let cwd = workspaceDir;
    // Auto-redirect to the active worktree so shell commands (mkdir, cat, echo,
    // git add) land in the worktree, not the main repo. The model often uses
    // run_command to write files instead of write_file, bypassing the worktree
    // redirect that write_file/edit_file use. If the model explicitly sets cwd
    // (e.g. to the worktree path already), that explicit value takes priority.
    // EXCEPTION: `git worktree add` must run from the main repo root — running it
    // from inside a worktree interprets the relative path as nested inside the
    // worktree, creating a broken nested structure.
    if (!/\bgit\s+worktree\s+add\b/.test(command)) {
        const activeWt = activeOrCreatedWorktree(workspaceDir, frameworkDir, agentId);
        if (activeWt) cwd = activeWt;
    }
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

    const run = (cmd: string): Promise<ExecResult> =>
        new Promise((resolvePromise) => {
            execFile(cmd, argsList, {
                cwd,
                timeout,
                maxBuffer: 2 * 1024 * 1024,
                shell: true,
                windowsHide: true,
                env,
            }, (err, stdout, stderr) => {
                const out = [stdout, stderr].filter(Boolean).join('\n').trim();
                resolvePromise({ err: (err as (Error & { code?: number | string }) | null) ?? null, out });
            });
        });

    const format = ({ err, out }: ExecResult): string =>
        err && !out ? `Error (exit ${err.code ?? '?'}): ${err.message}`
            : err ? `Exit ${err.code ?? '?'}:\n${out}`
                : (out || '(no output)');

    return (async () => {
        const first = await run(command);
        // Idempotent worktree setup: a leftover worktree from a prior run or an
        // earlier phase must not kill the phase. The story uses one stable worktree
        // (.claude/worktrees/<agent>-<story>) across all phases, so a colliding
        // `git worktree add` means "it's already set up" — REUSE it (it holds the
        // work from generating-code etc.) rather than starting fresh from main.
        if (first.err && /\bworktree\s+add\b/.test(command)) {
            const wtPath = parseWorktreeAddPath(command);
            const branch = parseWorktreeAddBranch(command);
            if (wtPath || branch) {
                const gitCwd = parseWorktreeCommandCwd(command, cwd);
                const resolved = wtPath ? resolveMaybeWindowsPath(gitCwd, wtPath) : null;
                const list = await run(`git -C "${gitCwd}" worktree list --porcelain`);
                const existing = list.err ? undefined
                    : parseWorktreeList(list.out).find((w) =>
                        (resolved && resolveMaybeWindowsPath(gitCwd, w.path) === resolved)
                        || (branch && w.branch === branch));
                if (existing) {
                    // Primary (deterministic) path: the worktree already exists — reuse it.
                    const reusePath = wtPath ?? existing.path;
                    return `[worktree-guard] "${command.trim()}" — worktree already exists at ${reusePath}`
                        + `${existing.branch ? ` on branch ${existing.branch}` : ''}; reusing it `
                        + `(work from earlier phases is preserved). Run git commands with `
                        + `\`git -C ${reusePath} …\` or from inside that directory.`;
                }
                // Fallbacks (nice-to-haves) for an orphaned directory or stale metadata:
                // prune stale registrations and retry, then fall back to a fresh -N path.
                if (/already (exists|used|checked out|registered)/i.test(first.out)) {
                    await run('git worktree prune');
                    const afterPrune = await run(command);
                    if (!afterPrune.err) return afterPrune.out || '(no output)';
                    const retry = rewriteWorktreeAddOnCollision(command, cwd);
                    if (retry) {
                        const second = await run(retry);
                        if (!second.err) {
                            return `[worktree-guard] "${command.trim()}" hit a leftover directory; created a fresh worktree instead.\nRan: ${retry.trim()}\n${second.out || '(no output)'}`;
                        }
                        return format(second);
                    }
                }
            }
        }
        return format(first);
    })();
}

/** Pick the worktree to validate: explicit arg → newest `.claude/worktrees/*` dir → workspace root. */
function resolveValidationCwd(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
    if (args.path) {
        const check = safePath(String(args.path), workspaceDir, [workspaceDir, frameworkDir]);
        if (check.ok && existsSync(check.resolved)) return check.resolved;
    }
    const wtRoot = resolve(workspaceDir, '.claude/worktrees');
    if (existsSync(wtRoot)) {
        const dirs = readdirSync(wtRoot)
            .map((d) => resolve(wtRoot, d))
            .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
        if (dirs.length > 0) {
            return dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
        }
    }
    return workspaceDir;
}

function runOne(cmd: string, cwd: string): Promise<{ ok: boolean; code: number | string; out: string }> {
    return new Promise((res) => {
        execFile(cmd, [], { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, shell: true, windowsHide: true }, (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').trim();
            res({ ok: !err, code: err ? (err.code ?? 1) : 0, out });
        });
    });
}

/**
 * Validating phase helper: run the project's checks (type-check, build, tests) so a
 * small model doesn't have to orchestrate npm/tsc itself and parse the output. Returns
 * a structured, copy-ready report plus the recommended next phase.
 */
/**
 * Persist (or clear) the latest validation failure on the agent's status file so the
 * NEXT generating-code prompt can show the model exactly what failed. Without this, a
 * small model bounces validating→generating-code blind and re-writes the same broken
 * code (e.g. a missing import) indefinitely.
 */
function persistValidationFailure(frameworkDir: string, agentId: string, failure: string | null): void {
    try {
        const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
        if (!existsSync(statusFile)) return;
        const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        if (failure) s.lastValidationFailure = failure;
        else delete s.lastValidationFailure;
        writeFileSync(statusFile, JSON.stringify(s, null, 2));
    } catch { /* non-fatal — feedback is best-effort */ }
}

async function toolRunValidation(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string, agentId: string): Promise<string> {
    const cwd = resolveValidationCwd(args, workspaceDir, frameworkDir);
    let scripts: Record<string, string> = {};
    let hasPackageJson = false;
    try {
        const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
        scripts = pkg.scripts ?? {};
        hasPackageJson = true;
    } catch { /* no package.json — fall through */ }

    if (!hasPackageJson) {
        persistValidationFailure(frameworkDir, agentId, null);
        return `RUN_VALIDATION (worktree: ${cwd})\nNo package.json found — nothing to validate.\nOVERALL: PASSED (no checks configured)\nNext: call complete_phase with next_phase="committing" and note "no automated checks configured" in validation_results.`;
    }

    const checks: Array<{ key: string; label: string; cmd: string }> = [];
    if (existsSync(resolve(cwd, 'tsconfig.json'))) {
        checks.push({ key: 'static_analysis', label: 'tsc --noEmit', cmd: 'npx --no-install tsc --noEmit' });
    } else if (scripts.build) {
        checks.push({ key: 'static_analysis', label: 'npm run build', cmd: 'npm run build' });
    }
    if (scripts.test && !/no test specified/i.test(scripts.test)) {
        checks.push({ key: 'test_results', label: 'npm test', cmd: 'npm test' });
    }

    if (checks.length === 0) {
        persistValidationFailure(frameworkDir, agentId, null);
        return `RUN_VALIDATION (worktree: ${cwd})\nNo test/build/typecheck scripts detected.\nOVERALL: PASSED (no checks configured)\nNext: call complete_phase with next_phase="committing" and note "no automated checks configured" in validation_results.`;
    }

    const lines: string[] = [`RUN_VALIDATION (worktree: ${cwd})`];
    let allPassed = true;
    for (const check of checks) {
        const r = await runOne(check.cmd, cwd);
        if (!r.ok) allPassed = false;
        lines.push(`- ${check.key} (${check.label}): ${r.ok ? 'PASSED' : `FAILED (exit ${r.code})`}`);
        if (!r.ok && r.out) lines.push(`    ${r.out.slice(-400).replace(/\n/g, '\n    ')}`);
    }
    lines.push(`OVERALL: ${allPassed ? 'PASSED' : 'FAILED'}`);
    lines.push(allPassed
        ? 'Next: call complete_phase with next_phase="committing" and put the results above into validation_results / test_results / static_analysis.'
        : 'Next: one or more checks FAILED. Call complete_phase with next_phase="generating-code", put the failures into risks, and the results above into validation_results / test_results / static_analysis. Do NOT fix the code here.');
    const report = lines.join('\n');
    // Persist the failure so the next generating-code prompt can show the model the exact errors.
    persistValidationFailure(frameworkDir, agentId, allPassed ? null : report);
    return report;
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

/**
 * Locate the story's worktree. Prefers the orchestrator's deterministic path
 * (`.claude/worktrees/<agent>-<story>`), but stays tolerant of however the model
 * actually named it: falls back to any `.claude/worktrees/*` dir matching the story
 * number, preferring one that has uncommitted changes. Returns null if none found.
 */
export function findStoryWorktree(workspaceDir: string, agentId: string, storyNumber: string): string | null {
    const exact = resolve(workspaceDir, '.claude', 'worktrees', `${agentId}-${storyNumber}`);
    if (existsSync(exact)) return exact;
    const base = resolve(workspaceDir, '.claude', 'worktrees');
    if (!existsSync(base)) return null;
    const dirs = readdirSync(base)
        .map((d) => resolve(base, d))
        .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
    // Only consider worktrees that actually belong to this story — never fall back to
    // ALL dirs, which would return a sibling story's worktree and misdirect commits.
    const byStory = dirs.filter((d) => d.includes(storyNumber));
    const dirty = (d: string): boolean => {
        try { return execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).trimEnd().length > 0; }
        catch { return false; }
    };
    return byStory.find(dirty) ?? byStory[0] ?? null;
}

/** Read the agent's current storyNumber from its status file (null if unknown). */
function readAgentStoryNumber(frameworkDir: string, agentId: string): string | null {
    try {
        const status = parseJsonUtf8File(resolve(frameworkDir, `.${agentId}-status.json`)) as Record<string, unknown>;
        return typeof status.storyNumber === 'string' && status.storyNumber ? status.storyNumber : null;
    } catch { return null; }
}

/**
 * Deterministically ensure the story's isolated worktree exists, creating it (with a
 * fresh `fix/<story>` branch off HEAD) if missing. The framework — not the model —
 * owns worktree creation so the committing / creating-pr gates always have a worktree
 * to commit into and writes never leak into the main checkout. Idempotent.
 */
export function ensureStoryWorktree(workspaceDir: string, agentId: string, storyNumber: string): string | null {
    const existing = findStoryWorktree(workspaceDir, agentId, storyNumber);
    if (existing) return existing;
    const wtPath = resolve(workspaceDir, '.claude', 'worktrees', `${agentId}-${storyNumber}`);
    const branch = `fix/${storyNumber}`;
    const git = (gargs: string[]): { ok: boolean; out: string } => {
        try { return { ok: true, out: execFileSync('git', ['-C', workspaceDir, ...gargs], { encoding: 'utf8', timeout: 30_000 }).trim() }; }
        catch (e) { const err = e as { stdout?: string; stderr?: string; message?: string }; return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.trim() }; }
    };
    if (!git(['rev-parse', '--is-inside-work-tree']).ok) return null; // not a git repo (e.g. self-dev sandbox)
    mkdirSync(resolve(workspaceDir, '.claude', 'worktrees'), { recursive: true });
    git(['worktree', 'prune']); // drop stale registrations first
    // Base selection matters: if the story branch already exists (a reopened PR being
    // reworked), we must continue THAT branch so new commits stack onto the open PR and
    // the push fast-forwards. Creating it fresh off main would diverge → push rejected →
    // the fix never reaches the PR. Preference: existing local branch → remote branch →
    // fresh off HEAD.
    git(['fetch', 'origin', branch]); // best-effort; populates origin/<branch> if the PR exists
    const hasLocal = git(['rev-parse', '--verify', `refs/heads/${branch}`]).ok;
    const hasRemote = git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`]).ok;
    let r: { ok: boolean; out: string };
    if (hasLocal) {
        r = git(['worktree', 'add', wtPath, branch]);                          // continue existing local branch
    } else if (hasRemote) {
        r = git(['worktree', 'add', '-b', branch, wtPath, `origin/${branch}`]); // continue the open PR's branch
    } else {
        r = git(['worktree', 'add', '-b', branch, wtPath, 'HEAD']);            // brand-new branch off main
    }
    return r.ok && existsSync(wtPath) ? wtPath : null;
}

/**
 * Locate the story's worktree (exact `<agent>-<story>` match only). Does NOT fall back
 * to a sibling story's worktree — that would misdirect writes/commits onto the wrong
 * branch (observed: a fresh story's edits aimed at a stale story's worktree).
 */
function findActiveWorktree(workspaceDir: string, frameworkDir: string, agentId: string): string | null {
    const storyNumber = readAgentStoryNumber(frameworkDir, agentId);
    return storyNumber ? findStoryWorktree(workspaceDir, agentId, storyNumber) : null;
}

/**
 * Worktree that writes/commands should target. For a real target codebase, create the
 * story worktree on demand (deterministic). For framework self-development
 * (workspaceDir === frameworkDir) stay locate-only so the framework's own repo is not
 * carved into worktrees.
 */
function activeOrCreatedWorktree(workspaceDir: string, frameworkDir: string, agentId: string): string | null {
    if (workspaceDir !== frameworkDir) {
        const storyNumber = readAgentStoryNumber(frameworkDir, agentId);
        if (storyNumber) return ensureStoryWorktree(workspaceDir, agentId, storyNumber);
    }
    return findActiveWorktree(workspaceDir, frameworkDir, agentId);
}

/**
 * When an active git worktree exists for this agent, redirect file writes
 * from the main repository into the worktree so that `write_file` / `edit_file`
 * produce changes inside the worktree where git operations (commit, push) expect them.
 * If the resolved path is already outside workspaceDir, or if no worktree is found,
 * the original path is returned unchanged.
 */
function maybeRedirectToWorktree(
    resolvedPath: string,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
): string {
    const rel = relative(workspaceDir, resolvedPath);
    if (rel.startsWith('..')) return resolvedPath;
    const wt = activeOrCreatedWorktree(workspaceDir, frameworkDir, agentId);
    if (!wt) return resolvedPath;
    // If the resolved path is already inside the worktree, don't redirect again.
    if (resolvedPath.startsWith(wt + '/') || resolvedPath === wt) return resolvedPath;
    const wtPath = resolve(wt, rel);
    return wtPath;
}

/**
 * Build/-tooling artifacts that must never be staged into a story commit — staging
 * `git add -A` once committed a vitest cache file as if it were the work. The commit
 * gate stages only source changes and ignores these.
 */
const COMMIT_JUNK_RE = /(^|\/)(node_modules|dist|build|out|coverage|\.vite|\.cache|\.next|\.turbo|\.nyc_output|\.claude)(\/|$)|(^|\/)\.DS_Store$|\.(log|tmp)$/i;

/** Parse `git status --porcelain` into changed paths (handles quoting and renames). */
function parsePorcelainPaths(porcelain: string): string[] {
    return porcelain.split('\n').map((line) => line.trimEnd()).filter(Boolean).map((line) => {
        let p = line.slice(3); // strip "XY " status prefix
        if (p.includes(' -> ')) p = p.slice(p.indexOf(' -> ') + 4); // rename: take the new path
        if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // git quotes paths with specials
        return p;
    }).filter(Boolean);
}

export interface AutoCommitResult { ok: boolean; committed: boolean; note: string; }

/**
 * Deterministically commit the story's worktree so the `committing` phase always
 * produces a real commit. Small local models (14B) reliably call complete_phase but
 * routinely skip or mistype `git commit`, leaving the branch at base with the work
 * uncommitted — nothing ever reaches source control. The framework does the commit
 * for them (the same "framework runs the commands for you" model as run_validation).
 *
 * Stages only real source changes (build/cache junk is excluded) and uses a
 * framework-built message — never the model's free-text summary. If the only
 * changes are junk (no real work), it does NOT make a green commit: it returns
 * ok=false so the caller can fail the phase instead of shipping an empty branch.
 * Local commit only — pushing / PR creation is the creating-pr phase's job.
 */
export function autoCommitWorktree(workspaceDir: string, agentId: string, storyNumber: string, message: string): AutoCommitResult {
    // Require the story's isolated worktree. We deliberately do NOT fall back to
    // workspaceDir: committing in the main checkout (a) defeats worktree isolation
    // and (b) sweeps up unrelated changes (e.g. the .claude/worktrees dir itself).
    // No worktree → no-op failure so the caller routes back to generating-code.
    const wt = findStoryWorktree(workspaceDir, agentId, storyNumber);
    if (!wt) {
        return { ok: false, committed: false, note: `no worktree found for ${agentId}-${storyNumber} — work must happen in .claude/worktrees/${agentId}-${storyNumber}` };
    }
    const git = (cargs: string[]): string => {
        try { return execFileSync('git', ['-C', wt, ...cargs], { encoding: 'utf8', timeout: 30_000 }).trimEnd(); }
        catch (e) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            return `__ERR__${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`;
        }
    };
    const status = git(['status', '--porcelain']);
    if (status.startsWith('__ERR__')) {
        return { ok: false, committed: false, note: `git status failed in worktree ${wt}: ${status.slice(7, 200)}` };
    }
    if (!status) {
        return { ok: true, committed: false, note: `already committed (clean): ${git(['log', '-1', '--oneline']) || '(no log)'}` };
    }
    const realPaths = parsePorcelainPaths(status).filter((p) => !COMMIT_JUNK_RE.test(p));
    if (realPaths.length === 0) {
        return { ok: false, committed: false, note: 'no real work to commit (only build/cache junk changed)' };
    }
    if (git(['add', '--', ...realPaths]).startsWith('__ERR__')) {
        return { ok: false, committed: false, note: `git add failed in worktree ${wt}` };
    }
    const out = git(['commit', '-m', message]);
    if (out.startsWith('__ERR__')) {
        return { ok: false, committed: false, note: `auto-commit failed in worktree ${wt}: ${out.slice(7, 200)}` };
    }
    return { ok: true, committed: true, note: `committed ${realPaths.length} file(s) → ${git(['rev-parse', '--short', 'HEAD'])}: ${message}` };
}

export interface AutoPrResult {
    pr?: Record<string, unknown>;
    mockPr?: Record<string, unknown>;
    handoff: string;
    note: string;
    ok: boolean;
}

/**
 * Deterministically push the story branch and create-or-reuse its PR when the
 * creating-pr phase completes. Same rationale as the commit-gate: the 14B reliably
 * calls complete_phase but fumbles the push + `gh pr create` + capturing the PR
 * metadata, so the framework does it. Idempotent — an existing open PR for the
 * branch is reused (never a duplicate). Mock mode never touches a real remote.
 */
export function autoCreatePr(
    workspaceDir: string,
    agentId: string,
    storyNumber: string,
    title: string,
    body: string,
    configPath: string,
): AutoPrResult {
    const wt = findStoryWorktree(workspaceDir, agentId, storyNumber);
    if (!wt) {
        return { handoff: `${agentId}: no worktree found for ${agentId}-${storyNumber}`, note: `no worktree found for ${agentId}-${storyNumber}`, ok: false };
    }
    const sh = (bin: string, cargs: string[]): { ok: boolean; out: string } => {
        try { return { ok: true, out: execFileSync(bin, cargs, { cwd: wt, encoding: 'utf8', timeout: 60_000 }).trim() }; }
        catch (e) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.trim() };
        }
    };
    const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out || `${agentId}-${storyNumber}`;
    const prTitle = (title.trim().slice(0, 120)) || `${storyNumber}: ${agentId} changes`;

    // Mock mode: synthesize a deterministic mockPr, never touch a real remote.
    if (isMockExternalMode(configPath)) {
        const mockPr = { number: 0, url: `mock://pr/${branch}`, branch, title: prTitle, state: 'open', mock: true };
        return { mockPr, handoff: `${agentId}: opened mock PR for ${branch}`, note: `mock mode — synthesized mockPr for ${branch}`, ok: true };
    }

    // Live mode: push, then reuse an existing open PR or create a new one.
    const push = sh('git', ['-C', wt, 'push', '-u', 'origin', branch]);
    const existing = sh('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1']);
    let prNum: number | null = null;
    let prUrl = '';
    let reused = false;
    if (existing.ok) {
        try {
            const arr = JSON.parse(existing.out) as Array<{ number: number; url: string }>;
            if (arr[0]) { prNum = arr[0].number; prUrl = arr[0].url; reused = true; }
        } catch { /* fall through to create */ }
    }
    if (prNum === null) {
        const created = sh('gh', ['pr', 'create', '--head', branch, '--title', prTitle, '--body', body || prTitle]);
        if (!created.ok) {
            // Push or PR-create genuinely failed — do NOT fabricate PR metadata
            // (that would orphan/duplicate PRs). Surface the error so it's visible.
            const reason = (created.out || push.out || 'unknown error').slice(0, 200);
            return { handoff: `${agentId}: could not open a PR for ${branch}`, note: `PR creation failed for ${branch}: ${reason}`, ok: false };
        }
        const view = sh('gh', ['pr', 'view', branch, '--json', 'number,url']);
        if (view.ok) {
            try { const o = JSON.parse(view.out) as { number: number; url: string }; prNum = o.number; prUrl = o.url; } catch { /* keep url from create output */ }
        }
        if (!prUrl) prUrl = (created.out.match(/https?:\/\/\S+/) || [''])[0];
    }
    const pr = { number: prNum, url: prUrl, branch, title: prTitle, state: 'open' };
    return {
        pr,
        handoff: `${agentId}: ${reused ? 'reusing' : 'opened'} PR${prNum !== null ? ` #${prNum}` : ''} for ${branch} → ${prUrl}`,
        note: `${reused ? 'reused existing' : 'created'} PR${prNum !== null ? ` #${prNum}` : ''} for ${branch}`,
        ok: true,
    };
}

export interface AutoMergeResult { ok: boolean; merged: boolean; note: string; }

/** Devops build-chain phases the framework routes forward deterministically. */
export const DEVOPS_BUILD_CHAIN = new Set<string>(['pending-build', 'monitoring-build', 'build-passed']);

/**
 * The deterministic forward phase for a devops build-chain hop: the first allowedNext that
 * isn't an error/failure branch (pending-build→monitoring-build→build-passed→complete). The
 * real quality gates are the dev's validating phase + GitHub's required checks (which
 * auto-merge respects), so optimistic forward routing here doesn't bypass anything.
 */
export function devopsBuildChainNextPhase(phase: SdlcPhaseId): SdlcPhaseId | undefined {
    return getSdlcPhaseContract(phase).allowedNext.find((p) => p !== 'error' && p !== 'build-failed');
}

/**
 * Deterministic PR merge for the devops build-gate. The small model fumbles `gh pr merge`,
 * and in the local loop there is no CI poller to drive the merge, so the framework does it
 * (squash + delete branch) when devops finishes a passing build. Gated by the caller on
 * step mode — never call this when a manual merge is wanted.
 *
 * Host-agnostic by omission: it acts ONLY when the PR is positively a GitHub PR (the merge
 * verb is `gh`, which is GitHub-specific). Any other host — ADO, mock, etc. — is left to
 * finalize through its own path (e.g. ADO pipeline auto-complete) and `merged:false, ok:true`
 * lets the story still advance to complete.
 */
export function autoMergePr(frameworkDir: string, configPath: string): AutoMergeResult {
    const devopsFile = resolve(frameworkDir, '.devops-status.json');
    let pr: { id?: number; url?: string } | undefined;
    try {
        const s = parseJsonUtf8File(devopsFile) as { assignedPR?: { id?: number; url?: string } };
        pr = s.assignedPR;
    } catch { /* no desk */ }
    const prId = typeof pr?.id === 'number' ? pr.id : Number(pr?.id);
    if (!Number.isFinite(prId) || prId <= 0) return { ok: false, merged: false, note: 'no assigned PR id on the devops desk — cannot merge' };
    const prUrl = typeof pr?.url === 'string' ? pr.url : '';

    if (isMockExternalMode(configPath)) return { ok: true, merged: false, note: `mock mode — PR #${prId} not merged` };

    // Positively identify a GitHub PR: owner/repo from a github.com PR URL, or — only when
    // there's no URL to read the host from — a configured github.repo. A non-GitHub URL is
    // another host's PR and is intentionally left for that host to finalize.
    let repo = '';
    if (prUrl) {
        const m = prUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/pull\//i);
        if (m) repo = m[1];
        else return { ok: true, merged: false, note: `PR #${prId} is not a GitHub PR — left for its own host to finalize` };
    } else {
        try { repo = (parseJsonUtf8File(configPath) as { github?: { repo?: string } }).github?.repo || ''; } catch { /* */ }
    }
    if (!repo) return { ok: false, merged: false, note: `could not resolve a GitHub repo for PR #${prId}` };

    const gh = (args: string[]): { ok: boolean; out: string } => {
        try { return { ok: true, out: execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000 }).trim() }; }
        catch (e) { const err = e as { stdout?: string; stderr?: string; message?: string }; return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.trim() }; }
    };

    // Protection-aware merge. A protected base (e.g. flowboard's main: strict + required
    // "Tests & type check") refuses a one-shot merge when the branch is BEHIND or checks are
    // pending. So: (1) update the branch if behind, then (2) try an immediate squash; if that's
    // blocked by pending/required checks, (3) arm auto-merge — GitHub merges when checks pass
    // and the branch is current. Arming counts as success: devops's job (land the merge) is done.
    const view = gh(['pr', 'view', String(prId), '-R', repo, '--json', 'mergeStateStatus,state']);
    let mergeState = '';
    try { mergeState = (JSON.parse(view.out) as { mergeStateStatus?: string }).mergeStateStatus ?? ''; } catch { /* */ }
    if (mergeState === 'BEHIND') {
        const upd = gh(['pr', 'update-branch', String(prId), '-R', repo]);
        if (!upd.ok && !/up to date|no new commits/i.test(upd.out)) {
            // couldn't update (e.g. conflict) — fall through; the merge attempt will report why
        }
    }

    const direct = gh(['pr', 'merge', String(prId), '--squash', '--delete-branch', '-R', repo]);
    if (direct.ok) return { ok: true, merged: true, note: `squash-merged PR #${prId} in ${repo}` };

    // Direct merge blocked (pending/required checks, or branch just updated and checks re-running)
    // → arm auto-merge so GitHub merges it when the gates are satisfied.
    const auto = gh(['pr', 'merge', String(prId), '--squash', '--delete-branch', '--auto', '-R', repo]);
    if (auto.ok) return { ok: true, merged: false, note: `auto-merge armed for PR #${prId} in ${repo} — GitHub will squash-merge when required checks pass` };

    return { ok: false, merged: false, note: `merge failed for PR #${prId}: ${(direct.out || auto.out || 'unknown').slice(0, 200)}` };
}

async function toolCompletePhase(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
    configPath: string,
): Promise<string> {
    let nextPhase = String(args.next_phase ?? 'analyzing');
    const summary = String(args.summary ?? '');

    const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
    let workflowItemId: number | null = null;
    let storyNumber = '1';
    let storyName = '';
    let tasks: unknown[] = [];
    let currentPhase = 'reading-story';
    try {
        const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        if (typeof s.workflowItemId === 'number') workflowItemId = s.workflowItemId;
        if (typeof s.storyNumber === 'string') storyNumber = s.storyNumber;
        if (typeof s.storyName === 'string') storyName = s.storyName;
        if (Array.isArray(s.tasks)) tasks = s.tasks;
        if (typeof s.currentPhase === 'string' && s.currentPhase) currentPhase = s.currentPhase;
    } catch { /* use defaults */ }

    if (!workflowItemId) return 'Error: workflowItemId not found in status file. The workflow must be registered before completing a phase.';

    const taskIds = tasks.map((t: unknown) => (t as Record<string, unknown>)?.id ?? '').filter(Boolean);

    // Framework-built commit/PR title — never the model's free-text summary, which
    // can be an error confession that then becomes the commit message / PR title.
    const changeTitle = `${storyNumber}: ${storyName || 'changes'}`.slice(0, 120);
    const prBody = `Story ${storyNumber}${storyName ? `: ${storyName}` : ''}\n\nOpened automatically by the ${agentId} agent.`;

    // Commit-gate: the committing phase must produce a real commit. The framework
    // stages only real source changes (build/cache junk excluded) and commits with a
    // structured message. If there is no real work, it fails the phase rather than
    // committing junk and shipping an empty branch.
    let autoCommit: AutoCommitResult | undefined;
    if (currentPhase === 'committing') {
        autoCommit = autoCommitWorktree(workspaceDir, agentId, storyNumber, changeTitle);
        if (!autoCommit.ok) {
            return `Cannot complete committing: ${autoCommit.note}. This phase requires real source changes to commit. If generating-code produced no changes, set next_phase to "generating-code" and implement the story — do not complete committing with an empty/junk commit.`;
        }
    }

    // PR-gate: the creating-pr phase pushes the branch and creates-or-reuses the PR
    // deterministically, then supplies the pr/mockPr/handoff outputs itself — the 14B
    // fumbles the push + gh sequence. Idempotent: an existing open PR is reused.
    let autoPr: AutoPrResult | undefined;
    if (currentPhase === 'creating-pr') {
        autoPr = autoCreatePr(workspaceDir, agentId, storyNumber, changeTitle, prBody, configPath);
        // Dev→reviewer handoff: put the PR on the reviewer's desk (which also spawns the
        // reviewer). The framework does this deterministically — the model used to be
        // relied on to call /api/pr/created itself and routinely skipped it, so the PR
        // sat unreviewed. Non-blocking; failure is logged but does not fail the phase.
        const prMeta = (autoPr.ok ? (autoPr.pr ?? autoPr.mockPr) : undefined) as { number?: number; url?: string; title?: string; branch?: string } | undefined;
        if (prMeta && typeof prMeta.number === 'number' && prMeta.number > 0) {
            const serverUrl = process.env.SDLC_SERVER_URL || 'http://localhost:3001';
            try {
                await fetch(`${serverUrl}/api/pr/created`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentId, prId: prMeta.number, prTitle: prMeta.title || changeTitle, prUrl: prMeta.url, storyNumber, branch: prMeta.branch }),
                    signal: AbortSignal.timeout(20_000),
                });
            } catch (e) {
                console.warn('[creating-pr] reviewer handoff (/api/pr/created) failed:', e instanceof Error ? e.message : String(e));
            }
        }
    }

    // Build-gate: the whole devops build chain is mechanical (in the local loop there's no
    // ADO-style pipeline poller, and the 8B fumbles these hops — it defaults next_phase to
    // 'analyzing', which is invalid, → rejected → stalls at the auto-resume cap). So route the
    // chain forward deterministically: pending-build → monitoring-build → build-passed →
    // complete. At the final hop, merge the PR (the small model also fumbles `gh pr merge`).
    // Merging is irreversible, so step mode pauses it for a manual merge, mirroring the
    // build-complete wrap-up gating.
    let autoMerge: AutoMergeResult | undefined;
    if (agentId === 'devops' && DEVOPS_BUILD_CHAIN.has(currentPhase)) {
        const forward = devopsBuildChainNextPhase(currentPhase as SdlcPhaseId);
        if (forward) nextPhase = forward;

        if (currentPhase === 'build-passed') {
            const stepModeOn = isGlobalStepMode(configPath) || isAgentStepMode('devops', configPath);
            if (stepModeOn) {
                return `[build-gate] Step mode is on — PR not auto-merged. Merge it manually, then advance the story to complete. (devops desk left at build-passed.)`;
            }
            autoMerge = autoMergePr(frameworkDir, configPath);
            // A failed merge must NOT mark the story complete with an unmerged PR — hold at
            // build-passed so it can be retried or merged by hand. (Auto-merge armed = ok.)
            if (!autoMerge.ok) {
                return `[build-gate] Could not merge the PR: ${autoMerge.note}. Story NOT marked complete — resolve the merge, then re-run. (devops desk left at build-passed.)`;
            }
        }
    }

    const outputs: Record<string, unknown> = {
        tasks,
        taskIds,
        auditEvent: {
            action: `${currentPhase}-complete`,
            storyNumber,
            agentId,
            nextPhase,
            timestamp: new Date().toISOString(),
            ...(autoCommit ? { autoCommit: autoCommit.note } : {}),
            ...(autoPr ? { autoPr: autoPr.note } : {}),
        },
    };
    const stringArg = (key: string) => args[key] === undefined || args[key] === null ? undefined : String(args[key]);
    // Text-summary outputs: provide sensible defaults so the phase contract is satisfied
    // even when the model doesn't explicitly supply every field.
    outputs.branchPlan = stringArg('branch_plan') ?? `fix/${storyNumber}-fix`;
    outputs.risks = stringArg('risks') ?? 'None identified';
    outputs.openQuestions = stringArg('open_questions') ?? 'None';
    outputs.testMatrix = args.test_matrix !== undefined && args.test_matrix !== null
        ? (Array.isArray(args.test_matrix) ? args.test_matrix : [String(args.test_matrix)])
        : ['Unit tests for changed logic'];
    outputs.codeChanges = stringArg('code_changes') ?? summary;
    outputs.classification = stringArg('classification') ?? 'feature';
    outputs.affectedRepo = stringArg('affected_repo') ?? '';

    // Persist the analyzing-phase PLAN (the file→change list) onto the desk so the next
    // generating-code prompt can surface it and the dev executes it (edits every affected
    // file) instead of re-researching from scratch. See orchestrator buildPhaseRunPrompt.
    if (currentPhase === 'analyzing') {
        const plan = String(outputs.codeChanges ?? '').trim();
        try {
            const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
            s.analysisPlan = plan || null;
            writeFileSync(statusFile, JSON.stringify(s, null, 2));
        } catch { /* non-fatal */ }
    }
    outputs.handoff = args.handoff ?? `${agentId} completed ${currentPhase}`;
    outputs.designSpec = stringArg('design_spec') ?? '';

    // Evidence-based outputs: only include when the model explicitly provides them —
    // do not fabricate test results, review verdicts, or build outcomes.
    const putIfProvided = (key: string, value: unknown) => {
        if (value !== undefined && value !== null) outputs[key] = value;
    };
    putIfProvided('validationResults', stringArg('validation_results'));
    putIfProvided('reviewVerdict', stringArg('review_verdict'));
    if (Array.isArray(args.review_threads)) outputs.reviewThreads = args.review_threads;
    putIfProvided('testResults', stringArg('test_results'));
    putIfProvided('staticAnalysis', stringArg('static_analysis'));
    putIfProvided('build', stringArg('build'));
    putIfProvided('pr', args.pr);
    putIfProvided('mockPr', args.mock_pr);

    // Framework-driven creating-pr wins over model-supplied values: the deterministic
    // push + create-or-reuse is authoritative, so its pr/mockPr/handoff override.
    if (autoPr?.ok) {
        if (autoPr.pr) outputs.pr = autoPr.pr;
        if (autoPr.mockPr) outputs.mockPr = autoPr.mockPr;
        outputs.handoff = autoPr.handoff;
    }

    const serverBaseUrl = process.env.SDLC_SERVER_URL || 'http://localhost:3001';
    const payload = { workflowItemId, agentId, phase: currentPhase, nextPhase, outputs, message: summary };

    // Retry only on transient connection failures (server restarting, brief blip).
    // A real HTTP response — even an error status — is returned immediately and never
    // retried. Without this, a momentary "fetch failed" makes models escalate the
    // phase to next_phase="error", permanently failing work that actually succeeded.
    const MAX_ATTEMPTS = 4;
    let lastErr = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(`${serverBaseUrl}/api/workflows/complete-phase`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(15_000),
            });
            const text = await res.text();
            if (res.ok) {
                // The server is authoritative for the resulting phase — it may coerce
                // the requested next_phase (e.g. the forward-progress guard turns a
                // PASSED validating -> generating-code bounce into -> committing). Use
                // the phase the server actually recorded so the status file (which
                // drives auto-resume) and the sentinel stay consistent with the DB.
                let recordedPhase = nextPhase;
                try {
                    const parsed = JSON.parse(text) as { workflow?: { active_phase?: string } };
                    if (parsed?.workflow?.active_phase) recordedPhase = parsed.workflow.active_phase;
                } catch { /* non-JSON body — fall back to the requested next_phase */ }
                try {
                    const status = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                    status.currentPhase = recordedPhase;
                    writeFileSync(statusFile, JSON.stringify(status, null, 2));
                    emitStatusChange(agentId, buildStatusBroadcast(status, agentId, true, frameworkDir));
                } catch { /* workflow completion succeeded; do not mask the server response */ }
                // Sentinel prefix tells AgentRunner to stop the loop immediately so
                // the next phase starts with a fresh conversation context.
                const commitLine = autoCommit ? `\n[commit-gate] ${autoCommit.note}` : '';
                const prLine = autoPr ? `\n[pr-gate] ${autoPr.note}` : '';
                const mergeLine = autoMerge ? `\n[build-gate] ${autoMerge.note}` : '';
                return `PHASE_COMPLETE::${recordedPhase}\nHTTP ${res.status}${commitLine}${prLine}${mergeLine}\n${text.slice(0, 500)}`;
            }
            return `HTTP ${res.status}\n${text.slice(0, 1000)}`;
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
            if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1000));
        }
    }
    // All attempts hit a connection error — the phase was NOT recorded. Tell the model
    // to retry rather than giving up (do NOT escalate to error over a transient blip).
    return `Could not reach the server after ${MAX_ATTEMPTS} attempts (${lastErr}). The server may be restarting; the phase was NOT recorded. Wait and call complete_phase again with the same outputs — do not set next_phase to "error".`;
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

        // Reviewer verdict (bug #10): when the reviewer supplies a recognizable verdict,
        // store it canonically and force the phase to match — the model otherwise lands on
        // a phase (e.g. waiting-for-fixes) that contradicts an approve-with-nits verdict and
        // the handoff bounces an approved PR back to the author. Phase follows verdict so
        // the two can never disagree. Unrecognized verdicts from other agents pass through.
        const canonicalVerdict = agentId === 'reviewer' ? normalizeReviewerVerdict(args.verdict) : null;
        if (canonicalVerdict) {
            updated.verdict = canonicalVerdict;
            updated.currentPhase = reviewerPhaseForVerdict(canonicalVerdict);
        } else if (args.verdict !== undefined) {
            updated.verdict = args.verdict;
        }

        const resolvedPhase = updated.currentPhase;
        if (!Array.isArray(updated.events)) updated.events = [];
        (updated.events as unknown[]).push({
            timestamp: new Date().toISOString(),
            type: 'phase',
            message: args.message ?? `Phase: ${resolvedPhase}`,
        });

        writeFileSync(statusFile, JSON.stringify(updated, null, 2));
        emitStatusChange(agentId, buildStatusBroadcast(updated, agentId, true, frameworkDir));
        const v = canonicalVerdict ? ` verdict=${canonicalVerdict}` : (args.verdict ? ` verdict=${args.verdict}` : '');
        const coerced = canonicalVerdict && resolvedPhase !== args.phase ? ` (phase set from verdict; requested ${args.phase})` : '';
        return `Status updated: phase=${resolvedPhase}${v}${coerced}`;
    } catch (e) {
        return `Error updating status: ${e instanceof Error ? e.message : String(e)}`;
    }
}

/**
 * Convert a simple glob pattern to a regex.
 * Supports **, *, ?, and {a,b} alternatives.
 */
function globToRegex(pattern: string): RegExp {
    let escaped = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '{') {
            const end = pattern.indexOf('}', i);
            if (end !== -1) {
                const alts = pattern.slice(i + 1, end).split(',').map(a => globToRegex(a.trim()).source);
                escaped += `(?:${alts.join('|')})`;
                i = end + 1;
                continue;
            }
        }
        if (ch === '*' && pattern[i + 1] === '*') {
            // ** matches everything including path separators
            escaped += '.*';
            i += 2;
            // skip trailing slash if present
            if (pattern[i] === '/') i++;
            continue;
        }
        if (ch === '*') { escaped += '[^/]*'; i++; continue; }
        if (ch === '?') { escaped += '[^/]'; i++; continue; }
        if (ch === '.') { escaped += '\\.'; i++; continue; }
        escaped += ch;
        i++;
    }
    return new RegExp(`^${escaped}$`);
}

function toolGrep(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return 'Error: pattern is required';
    let dir = workspaceDir;
    if (args.directory) {
        const dirCheck = safePath(String(args.directory), workspaceDir, [workspaceDir, frameworkDir]);
        if (!dirCheck.ok) return `Error: ${dirCheck.error}`;
        dir = dirCheck.resolved;
    }
    const includeGlob = args.include ? String(args.include) : null;
    const includeRe = includeGlob ? globToRegex(includeGlob) : null;
    const maxResults = typeof args.max_results === 'number' ? args.max_results : 50;
    let re: RegExp;
    try { re = new RegExp(pattern, 'i'); } catch (e) { return `Error: invalid regex "${pattern}": ${e instanceof Error ? e.message : String(e)}`; }

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
            } else if (!includeRe || includeRe.test(entry)) {
                try {
                    const content = readFileSync(full, 'utf-8');
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                        if (re.test(lines[i])) {
                            results.push(`${relative(workspaceDir, full)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
                        }
                    }
                } catch { /* skip unreadable */ }
            }
        }
    };
    if (!existsSync(dir)) return `Error: directory not found: ${dir}`;
    walk(dir, 0);
    return results.length > 0 ? results.join('\n') : `No matches for /${pattern}/`;
}

function toolRead(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
    const check = safePath(String(args.path ?? ''), workspaceDir, [workspaceDir, frameworkDir]);
    if (!check.ok) return `Error: ${check.error}`;
    if (!existsSync(check.resolved)) return `Error: file not found: ${check.resolved}`;
    try {
        const content = readFileSync(check.resolved, 'utf-8');
        const lines = content.split('\n');
        const offset = typeof args.offset === 'number' ? Math.max(1, Math.floor(args.offset)) : 1;
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : lines.length;
        const start = offset - 1;
        const chunk = lines.slice(start, start + limit);
        return chunk.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
    } catch (e) {
        return `Error reading file: ${e instanceof Error ? e.message : String(e)}`;
    }
}

function toolGlob(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return 'Error: pattern is required';
    let dir = workspaceDir;
    if (args.directory) {
        const dirCheck = safePath(String(args.directory), workspaceDir, [workspaceDir, frameworkDir]);
        if (!dirCheck.ok) return `Error: ${dirCheck.error}`;
        dir = dirCheck.resolved;
    }
    let re: RegExp;
    try { re = globToRegex(pattern); } catch (e) { return `Error: invalid glob pattern: ${e instanceof Error ? e.message : String(e)}`; }

    const results: string[] = [];
    const walk = (d: string, depth: number) => {
        if (depth > 8) return;
        let entries: string[];
        try { entries = readdirSync(d); } catch { return; }
        for (const entry of entries) {
            if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'bin' || entry === 'obj') continue;
            const full = resolve(d, entry);
            let stat;
            try { stat = statSync(full); } catch { continue; }
            const rel = relative(dir, full);
            if (re.test(rel)) { results.push(rel); }
            if (stat.isDirectory()) walk(full, depth + 1);
        }
    };
    if (!existsSync(dir)) return `Error: directory not found: ${dir}`;
    walk(dir, 0);
    results.sort();
    return results.length > 0 ? results.join('\n') : `No files matching "${pattern}"`;
}

// ---------------------------------------------------------------------------
// Worker pool tools (delegated to 1-bit model)
// ---------------------------------------------------------------------------

let _workerPool: ReturnType<typeof createWorkerPool> | null = null;

function getOrCreateWorkerPool(configPath: string): ReturnType<typeof createWorkerPool> {
  if (!_workerPool) _workerPool = createWorkerPool(configPath);
  return _workerPool;
}

async function toolSummarizeFile(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string, configPath: string): Promise<string> {
    const check = safePath(String(args.path ?? ''), workspaceDir, [workspaceDir, frameworkDir]);
    if (!check.ok) return `Error: ${check.error}`;
    if (!existsSync(check.resolved)) return `Error: file not found: ${check.resolved}`;
    try {
        const content = readFileSync(check.resolved, 'utf-8');
        const pool = getOrCreateWorkerPool(configPath);
        const summary = await pool.summarizeFile(check.resolved, content);
        return summary || '(worker returned empty summary)';
    } catch (e) {
        return `Error summarizing file: ${e instanceof Error ? e.message : String(e)}`;
    }
}

async function toolSummarizeSearch(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string, configPath: string): Promise<string> {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return 'Error: pattern is required';
    let dir = workspaceDir;
    if (args.directory) {
        const dirCheck = safePath(String(args.directory), workspaceDir, [workspaceDir, frameworkDir]);
        if (!dirCheck.ok) return `Error: ${dirCheck.error}`;
        dir = dirCheck.resolved;
    }
    const includeGlob = args.include ? String(args.include) : null;
    const includeRe = includeGlob ? globToRegex(includeGlob) : null;
    const maxResults = 80;
    let re: RegExp;
    try { re = new RegExp(pattern, 'i'); } catch (e) { return `Error: invalid regex "${pattern}": ${e instanceof Error ? e.message : String(e)}`; }

    const matches: string[] = [];
    const walk = (d: string, depth: number) => {
        if (depth > 8 || matches.length >= maxResults) return;
        let entries: string[];
        try { entries = readdirSync(d); } catch { return; }
        for (const entry of entries) {
            if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'bin' || entry === 'obj') continue;
            const full = resolve(d, entry);
            let stat;
            try { stat = statSync(full); } catch { continue; }
            if (stat.isDirectory()) {
                walk(full, depth + 1);
            } else if (!includeRe || includeRe.test(entry)) {
                try {
                    const content = readFileSync(full, 'utf-8');
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                        if (re.test(lines[i])) {
                            matches.push(`${relative(workspaceDir, full)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
                        }
                    }
                } catch { /* skip unreadable */ }
            }
        }
    };
    if (!existsSync(dir)) return `Error: directory not found: ${dir}`;
    walk(dir, 0);

    try {
        const pool = getOrCreateWorkerPool(configPath);
        const summary = await pool.searchAndSummarize(pattern, matches);
        const raw = matches.length > 0 ? `\n\nRaw matches:\n${matches.join('\n').slice(0, 2000)}` : '';
        return (summary ? `Worker summary:\n${summary}${raw}` : `No matches for "${pattern}"`) || '(no results)';
    } catch (e) {
        return matches.length > 0 ? matches.join('\n') : `No matches for "${pattern}"`;
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
        case 'read_file':       return toolReadFile(a, workspaceDir, frameworkDir, agentId, configPath);
        case 'write_file':      return toolWriteFile(a, workspaceDir, frameworkDir, agentId);
        case 'edit_file':       return toolEditFile(a, workspaceDir, frameworkDir, agentId);
        case 'list_directory':  return toolListDirectory(a, workspaceDir, frameworkDir);
        case 'run_command':     return toolRunCommand(a, workspaceDir, frameworkDir, configPath, agentId);
        case 'run_validation':  return toolRunValidation(a, workspaceDir, frameworkDir, agentId);
        case 'http_request':    return toolHttpRequest(a);
        case 'create_task':     return toolCreateTask(a, frameworkDir, agentId);
        case 'complete_phase':  return toolCompletePhase(a, workspaceDir, frameworkDir, agentId, configPath);
        case 'search_in_files': return toolSearchInFiles(a, workspaceDir, frameworkDir);
        case 'grep':            return toolGrep(a, workspaceDir, frameworkDir);
        case 'read':            return toolRead(a, workspaceDir, frameworkDir);
        case 'glob':            return toolGlob(a, workspaceDir, frameworkDir);
        case 'summarize_file':  return toolSummarizeFile(a, workspaceDir, frameworkDir, configPath);
        case 'summarize_search': return toolSummarizeSearch(a, workspaceDir, frameworkDir, configPath);
        case 'update_status':   return toolUpdateStatus(a, workspaceDir, frameworkDir, agentId);
        default: {
            // Local 14B models often emit the task *description* as the tool name
            // (e.g. {"name":"Add validation to POST /api/tasks","arguments":{...}}).
            // If the name contains spaces it's almost certainly a task title — route it.
            if (name.includes(' ') || name.length > 40) {
                return toolCreateTask({ ...a, name }, frameworkDir, agentId);
            }
            return `Unknown tool: "${name}". Valid tools: read_file, write_file, edit_file, list_directory, search_in_files, grep, read, glob, summarize_file, summarize_search, run_command, create_task, update_status, http_request, complete_phase.`;
        }
    }
}
