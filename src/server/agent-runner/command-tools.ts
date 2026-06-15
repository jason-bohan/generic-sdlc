import { execFile } from 'child_process';
import { isMockExternalMode } from '../external-mode';
import { ensureMockShims } from '../mock-mode-guard';
import { safePath } from './path-utils';
import { activeOrCreatedWorktree, parseWorktreeAddPath, parseWorktreeAddBranch, parseWorktreeList, rewriteWorktreeAddOnCollision, parseWorktreeCommandCwd } from './worktree';

type ExecResult = { err: (Error & { code?: number | string }) | null; out: string };

export function toolRunCommand(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
    configPath: string,
    agentId: string,
): Promise<string> {
    const command = String(args.command ?? '');
    const argsList = Array.isArray(args.args) ? (args.args as string[]) : [];
    let cwd = workspaceDir;
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
                    const reusePath = wtPath ?? existing.path;
                    return `[worktree-guard] "${command.trim()}" — worktree already exists at ${reusePath}`
                        + `${existing.branch ? ` on branch ${existing.branch}` : ''}; reusing it `
                        + `(work from earlier phases is preserved). Run git commands with `
                        + `\`git -C ${reusePath} …\` or from inside that directory.`;
                }
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

function resolveMaybeWindowsPath(cwd: string, path: string): string {
    const { resolve, sep } = require('path');
    return resolve(cwd, path.replace(/[\\/]+/g, sep));
}
