import {
    existsSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    mkdirSync,
    statSync,
} from 'fs';
import { resolve, relative, sep } from 'path';
import { execFile, execFileSync } from 'child_process';
import { parseJsonUtf8File } from '../json-file';

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

/** Read the agent's current storyNumber from its status file (null if unknown). */
export function readAgentStoryNumber(frameworkDir: string, agentId: string): string | null {
    try {
        const status = parseJsonUtf8File(resolve(frameworkDir, `.${agentId}-status.json`)) as Record<string, unknown>;
        return typeof status.storyNumber === 'string' && status.storyNumber ? status.storyNumber : null;
    } catch { return null; }
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

/**
 * Deterministically ensure the story's isolated worktree exists, creating it (with a
 * fresh `fix/<story>` branch off HEAD) if missing.
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
    if (!git(['rev-parse', '--is-inside-work-tree']).ok) return null;
    mkdirSync(resolve(workspaceDir, '.claude', 'worktrees'), { recursive: true });
    git(['worktree', 'prune']);
    git(['fetch', 'origin', branch]);
    const hasLocal = git(['rev-parse', '--verify', `refs/heads/${branch}`]).ok;
    const hasRemote = git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`]).ok;
    let r: { ok: boolean; out: string };
    if (hasLocal) {
        r = git(['worktree', 'add', wtPath, branch]);
    } else if (hasRemote) {
        r = git(['worktree', 'add', '-b', branch, wtPath, `origin/${branch}`]);
    } else {
        r = git(['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
    }
    return r.ok && existsSync(wtPath) ? wtPath : null;
}

/**
 * Locate the story's worktree (exact `<agent>-<story>` match only).
 */
export function findActiveWorktree(workspaceDir: string, frameworkDir: string, agentId: string): string | null {
    const storyNumber = readAgentStoryNumber(frameworkDir, agentId);
    return storyNumber ? findStoryWorktree(workspaceDir, agentId, storyNumber) : null;
}

/**
 * Worktree that writes/commands should target.
 */
export function activeOrCreatedWorktree(workspaceDir: string, frameworkDir: string, agentId: string): string | null {
    if (workspaceDir !== frameworkDir) {
        const storyNumber = readAgentStoryNumber(frameworkDir, agentId);
        if (storyNumber) return ensureStoryWorktree(workspaceDir, agentId, storyNumber);
    }
    return findActiveWorktree(workspaceDir, frameworkDir, agentId);
}

/**
 * When an active git worktree exists for this agent, redirect file writes
 * from the main repository into the worktree.
 */
export function maybeRedirectToWorktree(
    resolvedPath: string,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
): string {
    const rel = relative(workspaceDir, resolvedPath);
    if (rel.startsWith('..')) return resolvedPath;
    const wt = activeOrCreatedWorktree(workspaceDir, frameworkDir, agentId);
    if (!wt) return resolvedPath;
    if (resolvedPath.startsWith(wt + '/') || resolvedPath === wt) return resolvedPath;
    const wtPath = resolve(wt, rel);
    return wtPath;
}

export function parseWorktreeCommandCwd(command: string, fallbackCwd: string): string {
    const cd = command.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&/);
    if (cd) return resolveMaybeWindowsPath(fallbackCwd, cd[1] ?? cd[2] ?? cd[3]);
    const gitC = command.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+worktree\s+add\b/);
    if (gitC) return resolveMaybeWindowsPath(fallbackCwd, gitC[1] ?? gitC[2] ?? gitC[3]);
    return fallbackCwd;
}
