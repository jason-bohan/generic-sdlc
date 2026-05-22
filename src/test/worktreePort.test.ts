import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveApiPort, deriveVitePort, getWorktreeInfo, isMainWorktree, persistDevPort } from '../server/worktree-port';

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempRoots.push(dir);
    return dir;
}

afterEach(() => {
    delete process.env.SDLC_API_PORT;
    delete process.env.SDLC_VITE_PORT;
    for (const dir of tempRoots.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('worktree-port helpers', () => {
    it('treats a .git directory as the main checkout', () => {
        const root = tempDir('sdlc-framework-main-');
        mkdirSync(join(root, '.git'));

        expect(isMainWorktree(root)).toBe(true);
        expect(getWorktreeInfo(root)).toMatchObject({
            isWorktree: false,
            branch: root.replace(/\\/g, '/').split('/').pop(),
        });
        expect(deriveApiPort(root)).toBe(3001);
        expect(deriveVitePort(root)).toBe(3847);
    });

    it('treats a .git file as a linked worktree and falls back to the gitdir name', () => {
        const root = tempDir('sdlc-framework-worktree-');
        writeFileSync(join(root, '.git'), 'gitdir: C:/not-real/.git/worktrees/test-regression-hardening\n');

        const info = getWorktreeInfo(root);

        expect(info.isWorktree).toBe(true);
        expect(info.branch).toBe('test-regression-hardening');
        expect(deriveApiPort(root)).toBeGreaterThanOrEqual(3100);
        expect(deriveApiPort(root)).toBeLessThan(4000);
        expect(deriveVitePort(root)).toBe(deriveApiPort(root) + 1000);
    });

    it('lets explicit port environment variables win', () => {
        const root = tempDir('sdlc-framework-env-port-');
        writeFileSync(join(root, '.git'), 'gitdir: C:/repos/SDLC Framework/.git/worktrees/env-port\n');
        process.env.SDLC_API_PORT = '3999';
        process.env.SDLC_VITE_PORT = '4999';

        expect(deriveApiPort(root)).toBe(3999);
        expect(deriveVitePort(root)).toBe(4999);
    });

    it('persists the derived dev port for hooks and scripts', () => {
        const root = tempDir('sdlc-framework-dev-port-');

        persistDevPort(root, 3666);

        expect(readFileSync(join(root, '.sdlc-framework', '.dev-port'), 'utf-8')).toBe('3666');
    });
});
