import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import {
    MockModeViolation,
    isMockBlockedCommand,
    assertNotBlockedCommand,
    ensureMockShims,
} from '../server/mock-mode-guard';

function makeTmpDir(label: string): string {
    const dir = join(tmpdir(), `sdlc-framework-mock-guard-test-${label}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function writeMockConfig(dir: string) {
    writeFileSync(join(dir, '.sdlc-framework.config.json'), JSON.stringify({ externalMode: 'mock' }));
}

function writeLiveConfig(dir: string) {
    writeFileSync(join(dir, '.sdlc-framework.config.json'), JSON.stringify({ externalMode: 'live' }));
}

const tmpDirs: string[] = [];
afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
});

describe('isMockBlockedCommand', () => {
    it('blocks az with any args', () => {
        expect(isMockBlockedCommand('az', ['pipelines', 'runs', 'queue'])).toBe(true);
    });

    it('blocks az.cmd', () => {
        expect(isMockBlockedCommand('az.cmd', [])).toBe(true);
    });

    it('blocks az.exe', () => {
        expect(isMockBlockedCommand('az.exe', [])).toBe(true);
    });

    it('blocks git push', () => {
        expect(isMockBlockedCommand('git', ['push', 'origin', 'main'])).toBe(true);
    });

    it('blocks git push with full path', () => {
        expect(isMockBlockedCommand('C:\\Program Files\\Git\\bin\\git.exe', ['push'])).toBe(true);
    });

    it('does NOT block git clone', () => {
        expect(isMockBlockedCommand('git', ['clone', 'https://...'])).toBe(false);
    });

    it('does NOT block git commit', () => {
        expect(isMockBlockedCommand('git', ['commit', '-m', 'msg'])).toBe(false);
    });

    it('does NOT block npm', () => {
        expect(isMockBlockedCommand('npm', ['install'])).toBe(false);
    });
});

describe('assertNotBlockedCommand', () => {
    it('does not throw in live mode even for blocked commands', () => {
        const dir = makeTmpDir('live'); tmpDirs.push(dir);
        writeLiveConfig(dir);
        const configPath = join(dir, '.sdlc-framework.config.json');
        expect(() => assertNotBlockedCommand(configPath, 'git', ['push'])).not.toThrow();
        expect(() => assertNotBlockedCommand(configPath, 'az', [])).not.toThrow();
    });

    it('throws MockModeViolation for git push in mock mode', () => {
        const dir = makeTmpDir('mock-git'); tmpDirs.push(dir);
        writeMockConfig(dir);
        const configPath = join(dir, '.sdlc-framework.config.json');
        expect(() => assertNotBlockedCommand(configPath, 'git', ['push', 'origin', 'main']))
            .toThrow(MockModeViolation);
    });

    it('throws MockModeViolation for az in mock mode', () => {
        const dir = makeTmpDir('mock-az'); tmpDirs.push(dir);
        writeMockConfig(dir);
        const configPath = join(dir, '.sdlc-framework.config.json');
        expect(() => assertNotBlockedCommand(configPath, 'az', ['pipelines', 'runs', 'queue']))
            .toThrow(MockModeViolation);
    });

    it('does not throw for git clone in mock mode', () => {
        const dir = makeTmpDir('mock-safe'); tmpDirs.push(dir);
        writeMockConfig(dir);
        const configPath = join(dir, '.sdlc-framework.config.json');
        expect(() => assertNotBlockedCommand(configPath, 'git', ['clone', 'https://...'])).not.toThrow();
    });

    it('includes the blocked operation in the error message', () => {
        const dir = makeTmpDir('mock-msg'); tmpDirs.push(dir);
        writeMockConfig(dir);
        const configPath = join(dir, '.sdlc-framework.config.json');
        let err: MockModeViolation | undefined;
        try { assertNotBlockedCommand(configPath, 'git', ['push']); } catch (e) { err = e as MockModeViolation; }
        expect(err).toBeInstanceOf(MockModeViolation);
        expect(err?.message).toContain('git push');
        expect(err?.message).toContain('mock');
    });
});

describe('ensureMockShims', () => {
    it('creates git.cmd that blocks push', () => {
        const dir = makeTmpDir('shims-git'); tmpDirs.push(dir);
        const mockBin = ensureMockShims(dir);
        const gitShim = join(mockBin, 'git.cmd');
        expect(existsSync(gitShim)).toBe(true);
        const content = readFileSync(gitShim, 'ascii');
        expect(content).toContain('push');
        expect(content).toContain('exit /b 88');
        expect(content).toContain('blocked');
    });

    it('creates az.cmd that always blocks', () => {
        const dir = makeTmpDir('shims-az'); tmpDirs.push(dir);
        const mockBin = ensureMockShims(dir);
        const azShim = join(mockBin, 'az.cmd');
        expect(existsSync(azShim)).toBe(true);
        const content = readFileSync(azShim, 'ascii');
        expect(content).toContain('exit /b 88');
        expect(content).toContain('blocked');
    });

    it('returns the mock-bin directory path', () => {
        const dir = makeTmpDir('shims-path'); tmpDirs.push(dir);
        const mockBin = ensureMockShims(dir);
        expect(mockBin).toBe(resolve(dir, '.sdlc-framework', 'mock-bin'));
    });

    it('is idempotent — calling twice does not throw', () => {
        const dir = makeTmpDir('shims-idem'); tmpDirs.push(dir);
        expect(() => { ensureMockShims(dir); ensureMockShims(dir); }).not.toThrow();
    });

    it('git.cmd forward path never references mock-bin (no self-recursion)', () => {
        const dir = makeTmpDir('shims-noself'); tmpDirs.push(dir);
        const mockBin = ensureMockShims(dir);
        const content = readFileSync(join(mockBin, 'git.cmd'), 'ascii');
        const lines = content.split(/\r?\n/).filter(l => !l.startsWith('if') && !l.startsWith('echo') && !l.startsWith('exit') && !l.startsWith('@') && !l.startsWith(')') && !l.startsWith(' ') && l.trim());
        for (const line of lines) {
            expect(line).not.toContain('mock-bin');
        }
    });

    it('git.cmd forward path survives when mock-bin is already in PATH', () => {
        const dir = makeTmpDir('shims-path-poison'); tmpDirs.push(dir);
        const mockBin = ensureMockShims(dir);
        const origPath = process.env.PATH;
        try {
            process.env.PATH = `${mockBin};${origPath}`;
            rmSync(join(mockBin, 'git.cmd'), { force: true });
            ensureMockShims(dir);
            const content = readFileSync(join(mockBin, 'git.cmd'), 'ascii');
            const lines = content.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('@') && !l.startsWith('if') && !l.startsWith(' ') && !l.startsWith(')'));
            for (const line of lines) {
                expect(line).not.toContain('mock-bin');
            }
        } finally {
            process.env.PATH = origPath;
        }
    });
});
