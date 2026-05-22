import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, resolve, isAbsolute } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('../server/logger', () => ({
    serverLog: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

import { execFileSync as baselineExecFileSync } from 'child_process';

import {
    cleanupWorktree,
    cleanupStoryWorktrees,
    sweepWorktrees,
    getDefaultRemoteBranchName,
    gitExec,
} from '../server/worktree-cleanup';

function expectGitCall(mock: typeof execFileSyncMock, partial: string[]) {
    const hit = mock.mock.calls.find((c) => {
        const args = c[1] as string[] | undefined;
        if (!args) return false;
        if (partial.length > args.length) return false;
        return partial.every((v, i) => {
            if (
                typeof args[i] === 'string' &&
                typeof partial[i] === 'string' &&
                (isAbsolute(args[i] as string) || isAbsolute(partial[i] as string))
            ) {
                return resolve(String(args[i])) === resolve(String(partial[i]));
            }
            return args[i] === partial[i];
        });
    });
    expect(hit, `expected git args to contain ${partial.join(' ')}`).toBeTruthy();
}

beforeEach(() => {
    execFileSyncMock.mockClear();
    gitExec.execFileSync = execFileSyncMock as typeof baselineExecFileSync;
});

afterEach(() => {
    gitExec.execFileSync = baselineExecFileSync;
});

describe('cleanupWorktree', () => {
    let repo = '';
    let wtPath = '';

    beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), 'sdlc-framework-wt-clean-'));
        wtPath = join(repo, '.claude', 'worktrees', 'agent-B-99');
        mkdirSync(wtPath, { recursive: true });
    });

    afterEach(() => {
        rmSync(repo, { recursive: true, force: true });
    });

    it('removes worktree and deletes branch when worktree remove and branch -d succeed', () => {
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            expect(cmd).toBe('git');
            if (args[0] === 'branch' && args[1] === '--show-current' && args.length === 2) {
                expect(args).toEqual(['branch', '--show-current']);
                return 'feature/cleanup-ok\n';
            }
            if (args[0] === 'worktree' && args[1] === 'remove') {
                expect(resolve(String(args[2]))).toBe(resolve(wtPath));
                expect(args[3]).toBe('--force');
                return '';
            }
            if (args[0] === 'branch' && args[1] === '-d') {
                expect(args).toEqual(['branch', '-d', 'feature/cleanup-ok']);
                return '';
            }
            throw new Error(`unexpected git call: ${args.join(' ')}`);
        });

        cleanupWorktree('agent', 'B-99', repo);

        expectGitCall(execFileSyncMock, ['worktree', 'remove', wtPath]);
        expectGitCall(execFileSyncMock, ['branch', '-d', 'feature/cleanup-ok']);
        expect(execFileSyncMock.mock.calls.filter((c) => (c[1] as string[])[1] === '-D')).toHaveLength(0);
    });

    it('skips when worktree path does not exist (no error)', () => {
        rmSync(wtPath, { recursive: true, force: true });

        cleanupWorktree('agent', 'B-99', repo);

        expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('handles git worktree remove failure gracefully', () => {
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'branch' && args[1] === '--show-current') return 'feature/x\n';
            if (args[0] === 'worktree' && args[1] === 'remove') {
                const err = new Error('remove failed') as Error & { stderr: Buffer };
                err.stderr = Buffer.from('git worktree remove error');
                throw err;
            }
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        cleanupWorktree('agent', 'B-99', repo);

        expectGitCall(execFileSyncMock, ['worktree', 'remove', wtPath]);
        expect(execFileSyncMock.mock.calls.filter((c) => (c[1] as string[])[1] === '-d')).toHaveLength(0);
    });

    it('falls back to git branch -D when -d fails (unmerged branch)', () => {
        let dCalls = 0;
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'branch' && args[1] === '--show-current') return 'unmerged\n';
            if (args[0] === 'worktree' && args[1] === 'remove') return '';
            if (args[0] === 'branch' && args[1] === '-d') {
                dCalls += 1;
                throw Object.assign(new Error('not merged'), { stderr: Buffer.from('') });
            }
            if (args[0] === 'branch' && args[1] === '-D') {
                expect(args).toEqual(['branch', '-D', 'unmerged']);
                return '';
            }
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        cleanupWorktree('agent', 'B-99', repo);

        expect(dCalls).toBe(1);
        expectGitCall(execFileSyncMock, ['branch', '-D', 'unmerged']);
    });

    it('does not throw when branch delete fails after worktree remove', () => {
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'branch' && args[1] === '--show-current') return 'gone\n';
            if (args[0] === 'worktree' && args[1] === 'remove') return '';
            if (args[0] === 'branch' && args[1] === '-d') throw Object.assign(new Error('fail d'), { stderr: Buffer.from('') });
            if (args[0] === 'branch' && args[1] === '-D') throw Object.assign(new Error('fail D'), { stderr: Buffer.from('') });
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        expect(() => cleanupWorktree('agent', 'B-99', repo)).not.toThrow();
        expectGitCall(execFileSyncMock, ['branch', '-d', 'gone']);
        expectGitCall(execFileSyncMock, ['branch', '-D', 'gone']);
    });
});

describe('cleanupStoryWorktrees', () => {
    let repo = '';

    beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), 'sdlc-framework-wt-story-'));
    });

    afterEach(() => {
        rmSync(repo, { recursive: true, force: true });
    });

    it('cleans multiple agent worktrees for the same story', () => {
        const base = join(repo, '.claude', 'worktrees');
        const wtFe = join(base, 'frontend-B-17004');
        const wtBe = join(base, 'backend-B-17004');
        mkdirSync(wtFe, { recursive: true });
        mkdirSync(wtBe, { recursive: true });
        execFileSyncMock.mockImplementation((cmd: string, args: string[], opts?: { cwd?: string }) => {
            if (args[0] === 'branch' && args[1] === '--show-current') {
                const cwd = opts?.cwd;
                if (resolve(String(cwd)) === resolve(wtFe)) return 'fe-branch\n';
                if (resolve(String(cwd)) === resolve(wtBe)) return 'be-branch\n';
            }
            if (args[0] === 'worktree' && args[1] === 'remove') return '';
            if (args[0] === 'branch' && (args[1] === '-d' || args[1] === '-D')) return '';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        cleanupStoryWorktrees(repo, 'B-17004');

        expectGitCall(execFileSyncMock, ['worktree', 'remove', wtFe]);
        expectGitCall(execFileSyncMock, ['worktree', 'remove', wtBe]);
        expect(
            execFileSyncMock.mock.calls.filter((c) => (c[1] as string[])[0] === 'worktree' && (c[1] as string[])[1] === 'remove'),
        ).toHaveLength(2);
    });

    it('ignores directory names that do not match the story suffix', () => {
        const base = join(repo, '.claude', 'worktrees');
        mkdirSync(join(base, 'frontend-B-17005'), { recursive: true });
        mkdirSync(join(base, 'random-dir'), { recursive: true });
        writeFileSync(join(base, 'readme.txt'), 'x');

        cleanupStoryWorktrees(repo, 'B-17004');

        expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('returns early when .claude/worktrees exists but is empty', () => {
        const base = join(repo, '.claude', 'worktrees');
        mkdirSync(base, { recursive: true });

        cleanupStoryWorktrees(repo, 'B-17004');

        expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('returns early when .claude/worktrees is missing', () => {
        mkdirSync(join(repo, '.claude'), { recursive: true });

        cleanupStoryWorktrees(repo, 'B-17004');

        expect(execFileSyncMock).not.toHaveBeenCalled();
    });
});

describe('sweepWorktrees', () => {
    const repo = resolve(join(tmpdir(), 'sdlc-framework-sweep-repo'));

    function porcelain(mainPath: string, extras: Array<{ path: string; branch: string | 'detached' }>): string {
        const blocks: string[] = [];
        blocks.push(`worktree ${mainPath}`);
        blocks.push('HEAD 1111111111111111111111111111111111111111');
        blocks.push('branch refs/heads/main');
        blocks.push('');
        for (const e of extras) {
            blocks.push(`worktree ${e.path}`);
            blocks.push('HEAD 2222222222222222222222222222222222222222');
            if (e.branch === 'detached') blocks.push('detached');
            else blocks.push(`branch refs/heads/${e.branch}`);
            blocks.push('');
        }
        return blocks.join('\n');
    }

    it('removes worktrees whose branches are merged into default', () => {
        const aux = join(repo, 'wt-merged');
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
            if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
                return porcelain(repo, [{ path: aux, branch: 'merged-feat' }]);
            }
            if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return '';
            if (args[0] === 'worktree' && args[1] === 'remove') return '';
            if (args[0] === 'branch' && args[1] === '-d') return '';
            if (args[0] === 'worktree' && args[1] === 'prune') return '';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        const result = sweepWorktrees(repo);

        expect(result.removed).toEqual([aux]);
        expect(result.skipped).toEqual([]);
        expect(result.pruned).toBe(true);
        expectGitCall(execFileSyncMock, ['worktree', 'remove', aux, '--force']);
        expectGitCall(execFileSyncMock, ['branch', '-d', 'merged-feat']);
        expectGitCall(execFileSyncMock, ['worktree', 'prune']);
    });

    it('skips worktrees with unmerged branches when not forcing', () => {
        const aux = join(repo, 'wt-open');
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
            if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
                return porcelain(repo, [{ path: aux, branch: 'open-feat' }]);
            }
            if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
                throw Object.assign(new Error('not ancestor'), { stderr: Buffer.from('') });
            }
            if (args[0] === 'worktree' && args[1] === 'prune') return '';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        const result = sweepWorktrees(repo);

        expect(result.removed).toEqual([]);
        expect(result.skipped).toMatchObject([
            { path: aux, branch: 'open-feat', reason: 'branch not merged into origin/main' },
        ]);
        expect(result.pruned).toBe(true);
        expect(execFileSyncMock.mock.calls.filter((c) => (c[1] as string[])[1] === 'remove')).toHaveLength(0);
    });

    it('dryRun records removals but does not remove or prune', () => {
        const aux = join(repo, 'wt-dry');
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
            if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
                return porcelain(repo, [{ path: aux, branch: 'z' }]);
            }
            if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return '';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        const result = sweepWorktrees(repo, { dryRun: true });

        expect(result.removed).toEqual([aux]);
        expect(result.skipped).toEqual([]);
        expect(result.pruned).toBe(false);
        expect(execFileSyncMock.mock.calls.filter((c) => (c[1] as string[])[1] === 'remove')).toHaveLength(0);
        expect(execFileSyncMock.mock.calls.some((c) => (c[1] as string[])[1] === 'prune')).toBe(false);
    });

    it('force removes unmerged worktrees and deletes branch with -D', () => {
        const aux = join(repo, 'wt-force');
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
            if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
                return porcelain(repo, [{ path: aux, branch: 'hotfix' }]);
            }
            if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
                throw Object.assign(new Error('no'), { stderr: Buffer.from('') });
            }
            if (args[0] === 'worktree' && args[1] === 'remove') return '';
            if (args[0] === 'branch' && args[1] === '-D' && args[2] === 'hotfix') return '';
            if (args[0] === 'worktree' && args[1] === 'prune') return '';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        const result = sweepWorktrees(repo, { force: true });

        expect(result.removed).toEqual([aux]);
        expect(result.skipped).toEqual([]);
        expectGitCall(execFileSyncMock, ['worktree', 'remove', aux, '--force']);
        expectGitCall(execFileSyncMock, ['branch', '-D', 'hotfix']);
    });

    it('does not remove the main repository worktree entry', () => {
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
            if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
                return porcelain(repo, []);
            }
            if (args[0] === 'worktree' && args[1] === 'prune') return '';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        const result = sweepWorktrees(repo);

        expect(result.removed).toEqual([]);
        expect(result.skipped).toEqual([]);
        expect(execFileSyncMock.mock.calls.filter((c) => (c[1] as string[])[1] === 'remove')).toHaveLength(0);
        expect(result.pruned).toBe(true);
    });

    it('runs git worktree prune at end when not dry-run', () => {
        const aux = join(repo, 'wt-p');
        let pruneCalls = 0;
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
            if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
                return porcelain(repo, [{ path: aux, branch: 'm' }]);
            }
            if (args[0] === 'merge-base') return '';
            if (args[0] === 'worktree' && args[1] === 'remove') return '';
            if (args[0] === 'branch' && args[1] === '-d') return '';
            if (args[0] === 'worktree' && args[1] === 'prune') {
                pruneCalls += 1;
                return '';
            }
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        sweepWorktrees(repo);
        expect(pruneCalls).toBe(1);
    });

    it('skips detached HEAD worktrees unless force', () => {
        const auxDetached = join(repo, 'wt-det');
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
            if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
                return porcelain(repo, [{ path: auxDetached, branch: 'detached' }]);
            }
            if (args[0] === 'worktree' && args[1] === 'prune') return '';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        const skip = sweepWorktrees(repo);
        expect(skip.skipped[0].reason).toContain('detached');
        expect(skip.removed).toEqual([]);

        execFileSyncMock.mockClear();
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
            if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
                return porcelain(repo, [{ path: auxDetached, branch: 'detached' }]);
            }
            if (args[0] === 'worktree' && args[1] === 'remove') return '';
            if (args[0] === 'worktree' && args[1] === 'prune') return '';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });

        const forced = sweepWorktrees(repo, { force: true });
        expect(forced.removed).toEqual([auxDetached]);
    });
});

describe('getDefaultRemoteBranchName', () => {
    const repo = resolve('/tmp/sdlc-framework-default-branch');

    it('detects main from symbolic ref', () => {
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
                return 'refs/remotes/origin/main\n';
            }
            throw new Error(`unexpected: ${args.join(' ')}`);
        });
        expect(getDefaultRemoteBranchName(repo)).toBe('main');
    });

    it('detects master from symbolic ref', () => {
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/master\n';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });
        expect(getDefaultRemoteBranchName(repo)).toBe('master');
    });

    it('falls back when symbolic ref fails', () => {
        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
            if (args[0] === 'symbolic-ref') throw Object.assign(new Error('no symref'), { stderr: Buffer.from('') });
            if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main') {
                throw Object.assign(new Error('unknown ref'), { stderr: Buffer.from('') });
            }
            if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/master') return 'abc\n';
            throw new Error(`unexpected: ${args.join(' ')}`);
        });
        expect(getDefaultRemoteBranchName(repo)).toBe('master');
    });
});
