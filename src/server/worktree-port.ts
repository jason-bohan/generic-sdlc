import { statSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

function djb2(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffff;
    return Math.abs(h);
}

export function isMainWorktree(rootDir: string): boolean {
    try { return statSync(resolve(rootDir, '.git')).isDirectory(); } catch { return false; }
}

const ACCENT_HUES = [330, 200, 160, 30, 270, 50, 10, 180];

export interface WorktreeInfo {
    isWorktree: boolean;
    branch: string;
    dirName: string;
    accentHue: number;
}

export function getWorktreeInfo(rootDir: string): WorktreeInfo {
    const isWt = !isMainWorktree(rootDir);
    const dirName = rootDir.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
    let branch = '';
    try {
        branch = execSync('git branch --show-current', { cwd: rootDir, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* fallback */ }
    if (!branch && isWt) {
        try {
            const gitFile = readFileSync(resolve(rootDir, '.git'), 'utf-8').trim();
            const match = gitFile.match(/worktrees\/([^\s/]+)/);
            if (match) branch = match[1];
        } catch { /* fallback */ }
    }
    const hue = ACCENT_HUES[djb2(dirName) % ACCENT_HUES.length];
    return { isWorktree: isWt, branch: branch || dirName, dirName, accentHue: hue };
}

/**
 * Derives a stable API port for this worktree.
 * Main repo (.git is a directory) → 3001.
 * Any git worktree (.git is a file) → deterministic hash of the directory name → 3100-3999.
 * Explicit SDLC_API_PORT env var always wins.
 */
export function deriveApiPort(rootDir: string): number {
    if (process.env.SDLC_API_PORT) return Number(process.env.SDLC_API_PORT);
    if (isMainWorktree(rootDir)) return 3001;
    const name = rootDir.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
    return 3100 + (djb2(name) % 900);
}

/**
 * Derives a stable Vite dev-server port.
 * Main repo → 3847 (historical default).
 * Any git worktree → API port + 1000 (range 4100-4999).
 * Explicit SDLC_VITE_PORT env var always wins.
 */
export function deriveVitePort(rootDir: string): number {
    if (process.env.SDLC_VITE_PORT) return Number(process.env.SDLC_VITE_PORT);
    const api = deriveApiPort(rootDir);
    return api === 3001 ? 3847 : api + 1000;
}

/** Writes the assigned API port to .sdlc-framework/.dev-port so hooks and vite can read it. */
export function persistDevPort(rootDir: string, port: number): void {
    try {
        mkdirSync(resolve(rootDir, '.sdlc-framework'), { recursive: true });
        writeFileSync(resolve(rootDir, '.sdlc-framework/.dev-port'), String(port), 'utf-8');
    } catch { /* non-fatal */ }
}
