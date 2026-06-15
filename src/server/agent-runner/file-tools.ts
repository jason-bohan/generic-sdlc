import {
    existsSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    mkdirSync,
    statSync,
} from 'fs';
import { resolve, dirname, relative } from 'path';
import { safePath, resolveWritablePath, readAgentPhase } from './path-utils';
import { maybeRedirectToWorktree, activeOrCreatedWorktree } from './worktree';
import { parseJsonUtf8File } from '../json-file';
import { createWorkerPool } from '../workerPool';

const UNDERSTANDING_PHASES = new Set(['reading-story', 'analyzing']);
const READ_SUMMARIZE_MIN_CHARS = 1500;

let _workerPool: ReturnType<typeof createWorkerPool> | null = null;
function getOrCreateWorkerPool(configPath: string): ReturnType<typeof createWorkerPool> {
  if (!_workerPool) _workerPool = createWorkerPool(configPath);
  return _workerPool;
}

export async function toolReadFile(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string, agentId: string, configPath: string): Promise<string> {
    const rawPath = String(args.path ?? '');
    const check = safePath(rawPath, workspaceDir, [workspaceDir, frameworkDir]);
    if (!check.ok) return `Error: ${check.error}`;
    let resolvedPath = check.resolved;
    if (!existsSync(resolvedPath) && resolve(frameworkDir) !== resolve(workspaceDir)) {
        const relToWs = relative(resolve(workspaceDir), resolvedPath);
        if (relToWs && !relToWs.startsWith('..')) {
            const fwCheck = safePath(resolve(frameworkDir, relToWs), frameworkDir, [frameworkDir]);
            if (fwCheck.ok && existsSync(fwCheck.resolved)) resolvedPath = fwCheck.resolved;
        }
    }
    if (!existsSync(resolvedPath)) return `Error: file not found: ${resolvedPath}`;
    try {
        const content = readFileSync(resolvedPath, 'utf-8');
        if (args.full !== true && content.length >= READ_SUMMARIZE_MIN_CHARS && UNDERSTANDING_PHASES.has(readAgentPhase(frameworkDir, agentId))) {
            try {
                const summary = await getOrCreateWorkerPool(configPath).summarizeFile(resolvedPath, content);
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

export function toolWriteFile(
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

export function toolEditFile(
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

export function toolListDirectory(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
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
