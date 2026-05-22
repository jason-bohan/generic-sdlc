import { writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { getActiveProject, getActiveProjectName, getProjectProfile, listProjectNames } from '../project-config';
import { getExecMode, isValidMode } from '../modes';
import { getSchedulerWorkflowMode, isValidSchedulerWorkflowMode } from '../schedulerMode';
import { getExternalMode, isMockExternalMode } from '../external-mode';
import { isCursorAiEnabled, setCursorAiEnabled, isClaudeEnabled, setClaudeEnabled } from '../cursor-ai-policy';
import { bustModelCache } from './agents-models';
import { hasLiveAdoCredentialsInMockMode } from '../test-safety';
import { getUserProfileRecord, mergeUserProfileRecord, type UserProfileRecord } from '../user-profile-store';
import { readBody, json, cors } from '../router';
import { getSchedulerConfig } from '../route-shared';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';
import { getWorktreeInfo } from '../worktree-port';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/worktree-info ───────────────────────────────────────────────────
    use('/api/worktree-info', (_req, res) => {
        json(res, getWorktreeInfo(rootDir));
    });
    // ── /api/user-profile (demo REST layer for DS-99001 profile UI)
    use('/api/user-profile', async (req, res) => {
        cors(res, 'GET, PUT, PATCH, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

        if (req.method === 'GET') {
            json(res, getUserProfileRecord());
            return;
        }

        if (req.method !== 'PUT' && req.method !== 'PATCH') {
            res.statusCode = 405;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end('Method not allowed');
            return;
        }

        try {
            const raw = await readBody(req);
            const body = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
            const partial: Partial<UserProfileRecord> = {};
            if (typeof body.displayName === 'string') partial.displayName = body.displayName;
            if (typeof body.email === 'string') partial.email = body.email;
            if (typeof body.bio === 'string') partial.bio = body.bio;
            if ('avatarUrl' in body) {
                if (body.avatarUrl === null) partial.avatarUrl = null;
                else if (typeof body.avatarUrl === 'string') partial.avatarUrl = body.avatarUrl;
            }
            json(res, mergeUserProfileRecord(partial));
        } catch {
            json(res, { error: 'Invalid JSON body' }, 400);
        }
    });

    // ── /api/open-assistant ──────────────────────────────────────────────────
    use('/api/open-assistant', (req, res) => {
        if (req.method === 'OPTIONS') { cors(res); res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const assistantDir = resolve(process.env.USERPROFILE || process.env.HOME || '', 'Assistant');
        if (!existsSync(assistantDir)) { json(res, { error: `Assistant not found at ${assistantDir}` }, 404); return; }
        const { exec } = require('child_process');
        exec('npm start', { cwd: assistantDir, detached: true, stdio: 'ignore' });
        json(res, { ok: true });
    });

    // ── /api/active-project ──────────────────────────────────────────────────
    use('/api/active-project', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'GET') {
            json(res, { active: getActiveProjectName(configFile), available: listProjectNames(configFile), profile: getActiveProject(configFile) });
            return;
        }
        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const { project } = JSON.parse(body);
                if (!project || typeof project !== 'string') { json(res, { error: 'project name is required' }, 400); return; }
                const cfgRaw = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
                const available = cfgRaw.projects ? Object.keys(cfgRaw.projects) : [];
                if (available.length > 0 && !available.includes(project)) { json(res, { error: `Unknown project: ${project}. Available: ${available.join(', ')}` }, 400); return; }
                cfgRaw.activeProject = project;
                writeFileSync(configFile, JSON.stringify(cfgRaw, null, 2));
                json(res, { active: project, profile: getActiveProject(configFile) });
            } catch (e: any) { json(res, { error: e.message }, 500); }
            return;
        }
        json(res, { error: 'Method not allowed' }, 405);
    });

    // ── /api/external-mode ───────────────────────────────────────────────────
    use('/api/external-mode', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const { mode } = JSON.parse(body);
                if (mode !== 'mock' && mode !== 'live') { json(res, { error: 'mode must be "mock" or "live"' }, 400); return; }
                const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
                cfg.externalMode = mode;
                writeFileSync(configFile, JSON.stringify(cfg, null, 4));
                console.log(`[external-mode] Switched to ${mode}`);
                json(res, { ok: true, mode });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
            return;
        }
        json(res, {
            mode: getExternalMode(configFile),
            liveAdoCredentialsPresent: hasLiveAdoCredentialsInMockMode(configFile) });
    });

    // ── /api/execution-mode ──────────────────────────────────────────────────
    use('/api/execution-mode', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'GET') { json(res, { mode: getExecMode(configFile) }); return; }
        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const { mode } = JSON.parse(body);
                if (!isValidMode(mode)) { json(res, { error: 'mode must be local, balanced, or speed' }, 400); return; }
                const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
                cfg.executionMode = mode;
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                json(res, { mode });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
            return;
        }
        res.statusCode = 405; res.end('Method not allowed');
    });

    // ── /api/cursor-ai ──────────────────────────────────────────────────────
    use('/api/cursor-ai', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'GET') {
            json(res, { enabled: isCursorAiEnabled(configFile) });
            return;
        }
        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const parsed = body.trim() ? JSON.parse(body) : {};
                if (typeof parsed.enabled !== 'boolean') {
                    json(res, { error: 'enabled must be boolean' }, 400);
                    return;
                }
                const result = setCursorAiEnabled(configFile, parsed.enabled);
                bustModelCache();
                json(res, result);
            } catch (e: unknown) {
                json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
            }
            return;
        }
        res.statusCode = 405; res.end('Method not allowed');
    });

    // ── /api/claude-ai ──────────────────────────────────────────────────────
    use('/api/claude-ai', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'GET') {
            json(res, { enabled: isClaudeEnabled(configFile) });
            return;
        }
        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const parsed = body.trim() ? JSON.parse(body) : {};
                if (typeof parsed.enabled !== 'boolean') {
                    json(res, { error: 'enabled must be boolean' }, 400);
                    return;
                }
                const result = setClaudeEnabled(configFile, parsed.enabled);
                bustModelCache();
                json(res, result);
            } catch (e: unknown) {
                json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
            }
            return;
        }
        res.statusCode = 405; res.end('Method not allowed');
    });

    // ── /api/loop-provider ─────────────────────────────────────────────────
    use('/api/loop-provider/models', async (req, res) => {
        cors(res, 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const { readLoopProviderConfig: readLp } = await import('../agent-runner/provider');
        const lp = readLp(configFile);
        const { baseUrl, apiKey } = lp;
        if (!baseUrl) { json(res, { models: [] }); return; }
        try {
            const headers: Record<string, string> = {};
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            const r = await fetch(`${baseUrl}/models`, {
                headers,
                signal: AbortSignal.timeout(10_000),
            });
            if (!r.ok) { json(res, { models: [], error: `Provider ${r.status}` }); return; }
            const data = await r.json() as { data?: Array<{ id: string; name?: string }>; models?: Array<{ id: string; name?: string }> };
            const list = data.data ?? data.models ?? [];
            const models = list.map((m: { id: string; name?: string }) => ({ id: m.id, label: m.name ?? m.id }));
            json(res, { models });
        } catch (e: unknown) {
            json(res, { models: [], error: e instanceof Error ? e.message : String(e) });
        }
    });

    use('/api/loop-provider', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'GET') {
            const { readLoopProviderConfig: readLp } = await import('../agent-runner/provider');
            const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
            const lp = (cfg as any)?.scheduler?.loopProvider ?? {};
            const rawKey: string | undefined = lp.apiKey;
            const envKey = process.env.LOOP_PROVIDER_API_KEY || process.env.OPENROUTER_API_KEY;
            const resolved = readLp(configFile);
            const effectiveKey = resolved.apiKey;
            const provider = resolved.baseUrl.includes('openrouter.ai')
                ? 'openrouter'
                : resolved.baseUrl.includes('localhost:9337')
                    ? 'meshllm'
                    : 'custom';
            json(res, {
                baseUrl: resolved.baseUrl ?? null,
                model: resolved.model ?? null,
                apiKey: effectiveKey ? `${effectiveKey.slice(0, 8)}...${effectiveKey.slice(-4)}` : null,
                configured: !!effectiveKey,
                provider,
                source: rawKey ? 'config' : envKey ? 'env' : null,
            });
            return;
        }
        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const parsed = body.trim() ? JSON.parse(body) : {};
                const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) as Record<string, any> : {};
                if (!cfg.scheduler) cfg.scheduler = {};
                if (!cfg.scheduler.loopProvider) cfg.scheduler.loopProvider = {};
                const lp = cfg.scheduler.loopProvider;
                if (typeof parsed.apiKey === 'string') lp.apiKey = parsed.apiKey.trim() || undefined;
                if (typeof parsed.model === 'string') lp.model = parsed.model.trim() || undefined;
                if (typeof parsed.baseUrl === 'string') lp.baseUrl = parsed.baseUrl.trim() || undefined;
                if (lp.apiKey === undefined) delete lp.apiKey;
                if (lp.model === undefined) delete lp.model;
                if (lp.baseUrl === undefined) delete lp.baseUrl;
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                bustModelCache();
                json(res, { ok: true });
            } catch (e: unknown) {
                json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
            }
            return;
        }
        res.statusCode = 405; res.end('Method not allowed');
    });

    // ── /api/scheduler-mode ──────────────────────────────────────────────────
    use('/api/scheduler-mode', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'GET') { json(res, { mode: getSchedulerWorkflowMode(getSchedulerConfig(rootDir)) }); return; }
        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const { mode } = JSON.parse(body);
                if (!isValidSchedulerWorkflowMode(mode)) { json(res, { error: 'mode must be notify or autonomous' }, 400); return; }
                const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
                if (!cfg.scheduler) cfg.scheduler = { agents: {} };
                cfg.scheduler.mode = mode;
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                json(res, { mode });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
            return;
        }
        res.statusCode = 405; res.end('Method not allowed');
    });

    // ── /api/project/standards — discover standards, skills, and key paths ─────
    use('/api/project/standards', async (req, res) => {
        cors(res, 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }

        const url = new URL(req.url!, `http://${req.headers.host}`);
        const projectName = url.searchParams.get('project') || getActiveProjectName(rootDir);
        const profile = getProjectProfile(rootDir, projectName);
        const wsPath = profile?.workspacePath;

        if (!wsPath || !existsSync(wsPath)) {
            json(res, { error: `Workspace path not found for project "${projectName}"`, workspacePath: wsPath });
            return;
        }

        function globMdc(base: string): string[] {
            const results: string[] = [];
            const rulesDir = resolve(base, '.cursor', 'rules');
            if (existsSync(rulesDir)) {
                try {
                    for (const f of readdirSync(rulesDir)) {
                        if (f.endsWith('.mdc') || f.endsWith('.md')) results.push(resolve(rulesDir, f));
                    }
                } catch { /* skip */ }
            }
            return results;
        }

        function globSkills(base: string): Array<{ name: string; path: string }> {
            const results: Array<{ name: string; path: string }> = [];
            const skillsDir = resolve(base, '.cursor', 'skills');
            if (existsSync(skillsDir)) {
                try {
                    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
                        if (d.isDirectory()) {
                            const skillFile = resolve(skillsDir, d.name, 'SKILL.md');
                            if (existsSync(skillFile)) results.push({ name: d.name, path: skillFile });
                        }
                    }
                } catch { /* skip */ }
            }
            return results;
        }

        // Scan workspace root and common subdirectories for rules/skills
        const searchPaths = [wsPath];
        for (const sub of ['src', 'src/YourProject.Web', 'integration_test', 'frontend', 'backend']) {
            const full = resolve(wsPath, sub);
            if (existsSync(full)) searchPaths.push(full);
        }

        const rules: Array<{ name: string; path: string }> = [];
        const skills: Array<{ name: string; path: string }> = [];
        const seen = new Set<string>();

        for (const base of searchPaths) {
            for (const r of globMdc(base)) {
                if (!seen.has(r)) { seen.add(r); rules.push({ name: r.split(/[\\/]/).pop()!, path: r }); }
            }
            for (const s of globSkills(base)) {
                if (!seen.has(s.path)) { seen.add(s.path); skills.push(s); }
            }
        }

        // Key paths
        const keyPaths: Record<string, string | null> = {};
        for (const [label, rel] of Object.entries({
            'workspace': '',
            'agents_md': 'src/YourProject.Web/AGENTS.md',
            'angular_frontend': 'src/YourProject.Web',
            'dotnet_backend': 'src',
            'cypress_tests': 'integration_test',
            'cypress_support': 'integration_test/cypress/support',
            'cypress_config': 'integration_test/cypress.config.ts',
            'package_json': 'integration_test/package.json' })) {
            const full = resolve(wsPath, rel);
            keyPaths[label] = existsSync(full) ? full : null;
        }

        json(res, {
            project: projectName,
            workspacePath: wsPath,
            rules,
            skills,
            keyPaths,
            discoveredAt: new Date().toISOString() });
    });
}
