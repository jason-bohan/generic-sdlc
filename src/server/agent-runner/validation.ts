import {
    existsSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    statSync,
} from 'fs';
import { resolve, relative } from 'path';
import { execFile, spawn } from 'child_process';
import { getActiveProject } from '../project-config';
import { parseJsonUtf8File } from '../json-file';
import { safePath } from './path-utils';

interface BehaviorGateConfig {
    start: string;
    build?: string;
    port?: number;
    healthPath?: string;
}

export function persistValidationFailure(frameworkDir: string, agentId: string, failure: string | null): void {
    try {
        const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
        if (!existsSync(statusFile)) return;
        const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        if (failure) s.lastValidationFailure = failure;
        else delete s.lastValidationFailure;
        s.lastValidationResult = failure ? 'failed' : 'passed';
        s.lastValidationAt = new Date().toISOString();
        writeFileSync(statusFile, JSON.stringify(s, null, 2));
    } catch { /* non-fatal — feedback is best-effort */ }
}

function extractStoryRoutes(text: string): Array<{ method: string; path: string }> {
    const routes: Array<{ method: string; path: string }> = [];
    const seen = new Set<string>();
    const add = (method: string, path: string) => {
        const key = `${method} ${path}`;
        if (!seen.has(key)) { seen.add(key); routes.push({ method, path }); }
    };
    for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9/_:.-]+)/gi)) {
        add(m[1].toUpperCase(), m[2]);
    }
    if (routes.length === 0) {
        for (const m of text.matchAll(/(?:^|\s)(\/api\/[A-Za-z0-9/_:.-]+)/g)) add('GET', m[1]);
    }
    return routes;
}

function httpProbe(url: string, method: string, timeoutMs: number): Promise<number | null> {
    return fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) })
        .then(r => r.status)
        .catch(() => null);
}

async function runBehaviorGate(
    cwd: string,
    configPath: string,
    agentId: string,
    frameworkDir: string,
): Promise<{ ok: boolean; out: string } | null> {
    let gate: BehaviorGateConfig | undefined;
    try { gate = (getActiveProject(configPath) as { behaviorGate?: BehaviorGateConfig }).behaviorGate; }
    catch { return null; }
    if (!gate?.start) return null;

    let storyText = '';
    try {
        const desk = parseJsonUtf8File(resolve(frameworkDir, `.${agentId}-status.json`)) as { storyName?: unknown; storyDescription?: unknown };
        storyText = `${String(desk.storyName ?? '')}\n${String(desk.storyDescription ?? '')}`;
    } catch { /* no desk — skip */ }
    const routes = extractStoryRoutes(storyText);
    if (routes.length === 0) return null;

    if (gate.build) {
        const b = await runOne(gate.build, cwd);
        if (!b.ok) return { ok: false, out: `build for behavior gate failed:\n${b.out.slice(-400)}` };
    }

    const port = gate.port ?? 8099;
    const base = `http://127.0.0.1:${port}`;
    const healthUrl = `${base}${gate.healthPath ?? '/health'}`;
    const child = spawn(gate.start, { cwd, shell: true, detached: true, env: { ...process.env, PORT: String(port) } });
    let serverOut = '';
    child.stdout?.on('data', d => { serverOut += String(d); });
    child.stderr?.on('data', d => { serverOut += String(d); });
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* */ } try { child.kill('SIGKILL'); } catch { /* */ } };
    try {
        const deadline = Date.now() + 25_000;
        let ready = false;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 700));
            if (child.exitCode !== null) return { ok: false, out: `app exited (code ${child.exitCode}) before becoming reachable:\n${serverOut.slice(-500)}` };
            const hs = await httpProbe(healthUrl, 'GET', 2000);
            const rs = hs === null ? await httpProbe(`${base}${routes[0].path}`, routes[0].method, 2000) : hs;
            if (rs !== null) { ready = true; break; }
        }
        if (!ready) return { ok: false, out: `app did not become reachable on :${port} within 25s:\n${serverOut.slice(-500)}` };

        const failures: string[] = [];
        for (const r of routes) {
            const status = await httpProbe(`${base}${r.path}`, r.method, 8000);
            if (status === null) failures.push(`${r.method} ${r.path} — no response from the running app`);
            else if (status === 404) failures.push(`${r.method} ${r.path} — 404: the route is NOT wired into the running app (defined but never registered?)`);
            else if (status >= 500) failures.push(`${r.method} ${r.path} — ${status}: the handler throws at runtime`);
        }
        return failures.length
            ? { ok: false, out: failures.join('\n') }
            : { ok: true, out: `probed ${routes.length} live route(s) — all reachable: ${routes.map(r => `${r.method} ${r.path}`).join(', ')}` };
    } finally {
        kill();
    }
}

function runOne(cmd: string, cwd: string): Promise<{ ok: boolean; code: number | string; out: string }> {
    return new Promise((res) => {
        execFile(cmd, [], { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, shell: true, windowsHide: true }, (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').trim();
            res({ ok: !err, code: err ? (err.code ?? 1) : 0, out });
        });
    });
}

function resolveValidationCwd(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string, agentId: string): string {
    if (args.path) {
        const check = safePath(String(args.path), workspaceDir, [workspaceDir, frameworkDir]);
        if (check.ok && existsSync(check.resolved)) return check.resolved;
    }
    try {
        const desk = parseJsonUtf8File(resolve(frameworkDir, `.${agentId}-status.json`)) as { storyNumber?: unknown };
        const story = String(desk.storyNumber ?? '').trim();
        if (story) {
            const wt = resolve(workspaceDir, '.claude/worktrees', `${agentId}-${story}`);
            if (existsSync(wt)) return wt;
        }
    } catch { /* fall through to heuristics */ }
    const wtRoot = resolve(workspaceDir, '.claude/worktrees');
    if (existsSync(wtRoot)) {
        const dirs = readdirSync(wtRoot)
            .map((d) => resolve(wtRoot, d))
            .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
        if (dirs.length > 0) {
            return dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
        }
    }
    return workspaceDir;
}

export async function toolRunValidation(args: Record<string, unknown>, workspaceDir: string, frameworkDir: string, agentId: string): Promise<string> {
    const cwd = resolveValidationCwd(args, workspaceDir, frameworkDir, agentId);
    let scripts: Record<string, string> = {};
    let hasPackageJson = false;
    try {
        const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
        scripts = pkg.scripts ?? {};
        hasPackageJson = true;
    } catch { /* no package.json — fall through */ }

    if (!hasPackageJson) {
        persistValidationFailure(frameworkDir, agentId, null);
        return `RUN_VALIDATION (worktree: ${cwd})\nNo package.json found — nothing to validate.\nOVERALL: PASSED (no checks configured)\nNext: call complete_phase with next_phase="committing" and note "no automated checks configured" in validation_results.`;
    }

    const checks: Array<{ key: string; label: string; cmd: string }> = [];
    if (existsSync(resolve(cwd, 'tsconfig.json'))) {
        checks.push({ key: 'static_analysis', label: 'tsc --noEmit', cmd: 'npx --no-install tsc --noEmit' });
    } else if (scripts.build) {
        checks.push({ key: 'static_analysis', label: 'npm run build', cmd: 'npm run build' });
    }
    if (scripts.test && !/no test specified/i.test(scripts.test)) {
        checks.push({ key: 'test_results', label: 'npm test', cmd: 'npm test' });
    }

    if (checks.length === 0) {
        persistValidationFailure(frameworkDir, agentId, null);
        return `RUN_VALIDATION (worktree: ${cwd})\nNo test/build/typecheck scripts detected.\nOVERALL: PASSED (no checks configured)\nNext: call complete_phase with next_phase="committing" and note "no automated checks configured" in validation_results.`;
    }

    const lines: string[] = [`RUN_VALIDATION (worktree: ${cwd})`];
    let allPassed = true;
    for (const check of checks) {
        const r = await runOne(check.cmd, cwd);
        if (!r.ok) allPassed = false;
        lines.push(`- ${check.key} (${check.label}): ${r.ok ? 'PASSED' : `FAILED (exit ${r.code})`}`);
        if (!r.ok && r.out) lines.push(`    ${r.out.slice(-400).replace(/\n/g, '\n    ')}`);
    }
    if (allPassed) {
        try {
            const behavior = await runBehaviorGate(cwd, resolve(frameworkDir, '.sdlc-framework.config.json'), agentId, frameworkDir);
            if (behavior) {
                if (!behavior.ok) allPassed = false;
                lines.push(`- behavior (live endpoint probe): ${behavior.ok ? 'PASSED' : 'FAILED'}`);
                lines.push(`    ${behavior.out.slice(-600).replace(/\n/g, '\n    ')}`);
            }
        } catch (e) {
            lines.push(`- behavior (live endpoint probe): SKIPPED (${e instanceof Error ? e.message : String(e)})`);
        }
    }
    lines.push(`OVERALL: ${allPassed ? 'PASSED' : 'FAILED'}`);
    lines.push(allPassed
        ? 'Next: call complete_phase with next_phase="committing" and put the results above into validation_results / test_results / static_analysis.'
        : 'Next: one or more checks FAILED. Call complete_phase with next_phase="generating-code", put the failures into risks, and the results above into validation_results / test_results / static_analysis. Do NOT fix the code here.');
    const report = lines.join('\n');
    persistValidationFailure(frameworkDir, agentId, allPassed ? null : report);
    return report;
}
