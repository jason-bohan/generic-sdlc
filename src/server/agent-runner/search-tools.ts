import {
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
} from 'fs';
import { resolve, relative } from 'path';
import { safePath, globToRegex } from './path-utils';
import { createWorkerPool } from '../workerPool';

let _workerPool: ReturnType<typeof createWorkerPool> | null = null;

function getOrCreateWorkerPool(configPath: string): ReturnType<typeof createWorkerPool> {
  if (!_workerPool) _workerPool = createWorkerPool(configPath);
  return _workerPool;
}

export function toolSearchInFiles(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
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

export function toolGrep(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
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

export function toolRead(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
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

export function toolGlob(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string): string {
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

export async function toolSummarizeFile(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string, configPath: string): Promise<string> {
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

export async function toolSummarizeSearch(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string, configPath: string): Promise<string> {
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
