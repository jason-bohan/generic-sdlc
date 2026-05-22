/**
 * Git worktree cleanup for agent sandboxes under .claude/worktrees/<agentId>-<storyNumber>.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { execFileSync as nodeExecFileSync } from 'child_process';
import { join, resolve } from 'path';
import { platform } from 'os';
import { getActiveProject } from './project-config';
import { serverLog } from './logger';

/** Indirection so Vitest can mock git without stubbing the whole `child_process` module. */
export const gitExec = { execFileSync: nodeExecFileSync };

function pathsEqual(a: string, b: string): boolean {
    const ra = resolve(a);
    const rb = resolve(b);
    if (platform() === 'win32') return ra.toLowerCase() === rb.toLowerCase();
    return ra === rb;
}

function gitOk(args: string[], cwd: string): boolean {
    try {
        gitExec.execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
    } catch {
        return false;
    }
}

function gitOut(args: string[], cwd: string): string {
    return gitExec.execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** SDLC Framework workspace and optional target codebase (see project profile workspacePath). */
export function resolveWorktreeRepoRoots(frameworkRoot: string, configPath: string): string[] {
    const roots = new Set<string>();
    const main = resolve(frameworkRoot);
    roots.add(main);
    try {
        const profile = getActiveProject(configPath);
        const wp = typeof profile.workspacePath === 'string' ? profile.workspacePath.trim() : '';
        if (wp) {
            const abs = resolve(wp);
            if (!pathsEqual(abs, main)) roots.add(abs);
        }
    } catch { /* ignore */ }
    return [...roots];
}

export function getDefaultRemoteBranchName(repoRoot: string): string {
    const root = resolve(repoRoot);
    try {
        const sym = gitOut(['symbolic-ref', 'refs/remotes/origin/HEAD'], root);
        const m = sym.match(/refs\/remotes\/origin\/(.+)$/);
        if (m?.[1]) return m[1];
    } catch { /* fall through */ }
    for (const b of ['main', 'master']) {
        if (gitOk(['rev-parse', '--verify', `refs/remotes/origin/${b}`], root)) return b;
    }
    return 'main';
}

function parseGitWorktreePorcelain(output: string): Array<{ path: string; branch: string | null }> {
    const entries: Array<{ path: string; branch: string | null }> = [];
    let path: string | null = null;
    let branch: string | null = null;
    const flush = () => {
        if (path) {
            entries.push({ path, branch });
            path = null;
            branch = null;
        }
    };
    for (const line of output.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
            flush();
            path = line.slice('worktree '.length);
        } else if (line.startsWith('branch ')) {
            const ref = line.slice('branch '.length).trim();
            const m = ref.match(/refs\/heads\/(.+)$/);
            branch = m ? m[1]! : ref;
        } else if (line === 'detached') {
            branch = null;
        }
    }
    flush();
    return entries;
}

function isBranchMergedIntoDefault(repoRoot: string, branch: string, defaultBranchShort: string): boolean {
    const root = resolve(repoRoot);
    return gitOk(['merge-base', '--is-ancestor', branch, `origin/${defaultBranchShort}`], root);
}

export interface SkippedWorktree {
    path: string;
    branch: string | null;
    reason: string;
}

export interface SweepWorktreesResult {
    removed: string[];
    skipped: SkippedWorktree[];
    pruned: boolean;
}

/**
 * Remove auxiliary worktrees whose branches are merged into origin/<default>, optionally force-remove others.
 */
export function sweepWorktrees(
    repoRoot: string,
    options?: { dryRun?: boolean; force?: boolean },
): SweepWorktreesResult {
    const root = resolve(repoRoot);
    const dryRun = options?.dryRun === true;
    const force = options?.force === true;
    const removed: string[] = [];
    const skipped: SkippedWorktree[] = [];
    let pruned = false;

    let defaultBranch: string;
    try {
        defaultBranch = getDefaultRemoteBranchName(root);
    } catch (e) {
        serverLog.warn(`[worktree-cleanup] sweep: could not resolve default branch in ${root}: ${e instanceof Error ? e.message : String(e)}`);
        return { removed, skipped: [{ path: root, branch: null, reason: 'not a git repo or no origin' }], pruned: false };
    }

    let porcelain: string;
    try {
        porcelain = gitOut(['worktree', 'list', '--porcelain'], root);
    } catch (e) {
        serverLog.warn(`[worktree-cleanup] sweep: worktree list failed in ${root}: ${e instanceof Error ? e.message : String(e)}`);
        return { removed, skipped: [{ path: root, branch: null, reason: 'git worktree list failed' }], pruned: false };
    }

    const entries = parseGitWorktreePorcelain(porcelain);

    for (const { path: wtPath, branch } of entries) {
        if (pathsEqual(wtPath, root)) continue;

        const merged = branch ? isBranchMergedIntoDefault(root, branch, defaultBranch) : false;
        const shouldRemove = !branch ? force : merged || force;

        if (!shouldRemove) {
            if (!branch) {
                skipped.push({ path: wtPath, branch: null, reason: 'detached HEAD (use -Force on CLI or force in JSON to remove)' });
            } else {
                skipped.push({ path: wtPath, branch, reason: `branch not merged into origin/${defaultBranch}` });
            }
            continue;
        }

        if (branch && !merged && force) {
            serverLog.warn(`[worktree-cleanup] sweep: force-removing unmerged worktree ${wtPath} (branch ${branch})`);
        }

        if (dryRun) {
            removed.push(wtPath);
            continue;
        }

        try {
            gitExec.execFileSync('git', ['worktree', 'remove', wtPath, '--force'], {
                cwd: root,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            serverLog.info(`[worktree-cleanup] sweep: removed worktree ${wtPath}`);
            removed.push(wtPath);
        } catch (e: any) {
            const msg = e?.stderr?.toString() || e?.message || String(e);
            serverLog.warn(`[worktree-cleanup] sweep: worktree remove failed for ${wtPath}: ${msg}`);
            skipped.push({ path: wtPath, branch, reason: `remove failed: ${msg.trim()}` });
            continue;
        }

        if (branch && !dryRun) {
            if (merged) {
                if (gitOk(['branch', '-d', branch], root)) {
                    serverLog.info(`[worktree-cleanup] sweep: deleted branch ${branch}`);
                } else if (gitOk(['branch', '-D', branch], root)) {
                    serverLog.warn(`[worktree-cleanup] sweep: force-deleted branch ${branch} after -d failed`);
                } else {
                    serverLog.warn(`[worktree-cleanup] sweep: could not delete branch ${branch}`);
                }
            } else if (force) {
                if (gitOk(['branch', '-D', branch], root)) {
                    serverLog.warn(`[worktree-cleanup] sweep: force-deleted branch ${branch}`);
                } else {
                    serverLog.warn(`[worktree-cleanup] sweep: could not force-delete branch ${branch}`);
                }
            }
        }
    }

    if (!dryRun) {
        try {
            gitExec.execFileSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
            pruned = true;
            serverLog.info(`[worktree-cleanup] sweep: git worktree prune in ${root}`);
        } catch (e: any) {
            const msg = e?.stderr?.toString() || e?.message || String(e);
            serverLog.warn(`[worktree-cleanup] sweep: prune failed: ${msg}`);
            pruned = false;
        }
    } else {
        pruned = false;
    }

    return { removed, skipped, pruned };
}

/**
 * Remove a single agent worktree and delete its checked-out branch when possible.
 */
export function cleanupWorktree(agentId: string, storyNumber: string, repoRoot: string): void {
    const root = resolve(repoRoot);
    const sn = storyNumber.trim();
    if (!sn) return;
    const wtPath = join(root, '.claude', 'worktrees', `${agentId.trim()}-${sn}`);

    if (!existsSync(wtPath)) {
        serverLog.info(`[worktree-cleanup] skip missing worktree ${wtPath}`);
        return;
    }

    let branch: string | null = null;
    try {
        const b = gitOut(['branch', '--show-current'], wtPath);
        branch = b || null;
    } catch {
        serverLog.warn(`[worktree-cleanup] could not read branch for ${wtPath}`);
    }

    try {
        gitExec.execFileSync('git', ['worktree', 'remove', wtPath, '--force'], {
            cwd: root,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        serverLog.info(`[worktree-cleanup] removed worktree ${wtPath}`);
    } catch (e: any) {
        const msg = e?.stderr?.toString() || e?.message || String(e);
        serverLog.warn(`[worktree-cleanup] worktree remove failed for ${wtPath}: ${msg}`);
        return;
    }

    if (!branch) return;

    if (gitOk(['branch', '-d', branch], root)) {
        serverLog.info(`[worktree-cleanup] deleted branch ${branch}`);
        return;
    }
    if (gitOk(['branch', '-D', branch], root)) {
        serverLog.warn(`[worktree-cleanup] force-deleted branch ${branch} (was not fully merged locally)`);
        return;
    }
    serverLog.warn(`[worktree-cleanup] could not delete branch ${branch}`);
}

/** Scan .claude/worktrees for directories named *-<storyNumber> and clean each. */
export function cleanupStoryWorktrees(repoRoot: string, storyNumber: string): void {
    const root = resolve(repoRoot);
    const sn = storyNumber.trim();
    if (!sn) return;
    const base = join(root, '.claude', 'worktrees');
    if (!existsSync(base)) return;
    const suffix = `-${sn}`;
    for (const name of readdirSync(base)) {
        if (!name.endsWith(suffix)) continue;
        const full = join(base, name);
        try {
            if (!statSync(full).isDirectory()) continue;
        } catch {
            continue;
        }
        const agentId = name.slice(0, -suffix.length);
        if (!agentId) continue;
        cleanupWorktree(agentId, sn, root);
    }
}
