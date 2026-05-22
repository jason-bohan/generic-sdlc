import http from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { json, cors } from '../router';
import type { UseFn } from './types';

const MAX_TAIL = 64 * 1024;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b[^[\w]|[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function latestLogForAgent(outputDir: string, agentId: string): string | null {
    if (!existsSync(outputDir)) return null;
    const prefix = `${agentId}-`;
    const files = readdirSync(outputDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.log') && /\d{4}-\d{2}-\d{2}T/.test(f))
        .map(f => ({ f, mtime: statSync(resolve(outputDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return files.length ? resolve(outputDir, files[0].f) : null;
}

function streamLog(res: http.ServerResponse, logPath: string) {
    try {
        const stat = statSync(logPath);
        const content = readFileSync(logPath, 'utf-8');
        const raw = stat.size <= MAX_TAIL ? content : `...(truncated)\n${content.slice(-MAX_TAIL)}`;
        const body = stripAnsi(raw);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(body);
    } catch (e: unknown) {
        json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
}

export function mount(use: UseFn, rootDir: string): void {
    const outputDir = resolve(rootDir, '.agent-output');

    // GET /api/agent-output?agentId=frontend
    // Returns the latest timestamped run log for that agent (last 64 KB).
    use('/api/agent-output', (req, res) => {
        cors(res);
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const agentId = url.searchParams.get('agentId');
        if (!agentId) { json(res, { error: 'agentId required' }, 400); return; }
        const logPath = latestLogForAgent(outputDir, agentId);
        if (!logPath) { json(res, { error: 'No log found' }, 404); return; }
        streamLog(res, logPath);
    });

    // GET /api/agent-output/list — returns { agentId, file, mtimeMs } for all agents
    use('/api/agent-output/list', (req, res) => {
        cors(res);
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        if (!existsSync(outputDir)) { json(res, []); return; }
        const seen = new Map<string, { agentId: string; file: string; mtimeMs: number }>();
        readdirSync(outputDir)
            .filter(f => f.endsWith('.log') && /\d{4}-\d{2}-\d{2}T/.test(f))
            .forEach(f => {
                const match = f.match(/^([a-z][a-z0-9-]*)-\d{4}-\d{2}-\d{2}T/);
                if (!match) return;
                const agentId = match[1];
                const mtime = statSync(resolve(outputDir, f)).mtimeMs;
                const existing = seen.get(agentId);
                if (!existing || mtime > existing.mtimeMs) {
                    seen.set(agentId, { agentId, file: f, mtimeMs: mtime });
                }
            });
        json(res, [...seen.values()].sort((a, b) => b.mtimeMs - a.mtimeMs));
    });
}
