import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, join } from 'path';
import { isMockExternalMode } from './external-mode';

export class MockModeViolation extends Error {
    constructor(operation: string) {
        super(`[mock-mode] '${operation}' is blocked — externalMode is 'mock'`);
        this.name = 'MockModeViolation';
    }
}

/** Returns true if the cmd+args combination should be blocked in mock mode. */
export function isMockBlockedCommand(cmd: string, args: readonly string[]): boolean {
    const name = cmd.split(/[\\/]/).pop()?.replace(/\.(exe|cmd)$/i, '').toLowerCase() ?? '';
    if (name === 'az') return true;
    if (name === 'git' && (args[0]?.toLowerCase() ?? '') === 'push') return true;
    return false;
}

/** Throws MockModeViolation if configPath is in mock mode and cmd+args is a blocked operation. */
export function assertNotBlockedCommand(configPath: string, cmd: string, args: readonly string[]): void {
    if (!isMockExternalMode(configPath)) return;
    if (isMockBlockedCommand(cmd, args)) {
        throw new MockModeViolation([cmd, ...args.slice(0, 2)].join(' '));
    }
}

/**
 * Writes git.cmd and az.cmd shims to .sdlc-framework/mock-bin and returns the directory path.
 * Prepend the returned path to a child process PATH to enforce mock mode gates for any driver.
 */
export function ensureMockShims(workspaceDir: string): string {
    const mockBin = resolve(workspaceDir, '.sdlc-framework', 'mock-bin');
    mkdirSync(mockBin, { recursive: true });

    const realGit = _findExecutable('git');
    const gitForward = realGit
        ? `"${realGit.replace(/\\/g, '\\\\')}" %*`
        : 'echo [mock] git not found 1>&2 && exit /b 1';

    const gitShim = join(mockBin, 'git.cmd');
    const gitContent = [
        '@echo off',
        'if /I "%~1"=="push" (',
        '  echo [sdlc-framework mock mode] git push is blocked. Use local commits and mock PR state only. 1>&2',
        '  exit /b 88',
        ')',
        gitForward,
    ].join('\r\n');
    try { writeFileSync(gitShim, gitContent, { encoding: 'ascii', flag: 'w' }); } catch { /* EBUSY - already in use, skip */ }

    const azShim = join(mockBin, 'az.cmd');
    const azContent = [
        '@echo off',
        'echo [sdlc-framework mock mode] Azure CLI is blocked. Use SDLC Framework mock API/state instead. 1>&2',
        'exit /b 88',
    ].join('\r\n');
    try { writeFileSync(azShim, azContent, { encoding: 'ascii', flag: 'w' }); } catch { /* EBUSY - already in use, skip */ }

    return mockBin;
}

function _findExecutable(name: string): string | null {
    try {
        const out = execFileSync('where', [name], { encoding: 'utf-8', timeout: 3000 });
        const candidates = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        return candidates.find(p => !p.includes('mock-bin')) || null;
    } catch {
        return null;
    }
}
