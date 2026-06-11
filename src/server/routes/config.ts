import { writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { getActiveProject, getActiveProjectName, getProjectProfile, listProjectNames } from '../project-config';
import { getExecMode, isValidMode } from '../modes';
import { getSchedulerWorkflowMode, isValidSchedulerWorkflowMode } from '../schedulerMode';
import { getExternalMode, isMockExternalMode } from '../external-mode';
import { isCursorAiEnabled, setCursorAiEnabled, isClaudeEnabled, setClaudeEnabled, isOpenCodeEnabled, setOpenCodeEnabled } from '../cursor-ai-policy';
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

    // ── /api/opencode-ai ─────────────────────────────────────────────────────
    use('/api/opencode-ai', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method === 'GET') {
            json(res, { enabled: isOpenCodeEnabled(configFile) });
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
                const result = setOpenCodeEnabled(configFile, parsed.enabled);
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
            const { readLoopProviderConfig: readLp, detectLoopProvider, readLoopProviderToggles } = await import('../agent-runner/provider');
            const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
            const lp = (cfg as any)?.scheduler?.loopProvider ?? {};
            const rawKey: string | undefined = lp.apiKey;
            const envKey = process.env.LOOP_PROVIDER_API_KEY || process.env.OPENROUTER_API_KEY;
            const resolved = readLp(configFile);
            const effectiveKey = resolved.apiKey;
            const provider = detectLoopProvider(resolved.baseUrl);
            json(res, {
                baseUrl: resolved.baseUrl ?? null,
                model: resolved.model ?? null,
                apiKey: effectiveKey ? `${effectiveKey.slice(0, 8)}...${effectiveKey.slice(-4)}` : null,
                configured: !!effectiveKey,
                provider,
                providerEnabled: readLoopProviderToggles(configFile),
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
                if (parsed.providerEnabled && typeof parsed.providerEnabled === 'object') {
                    const allowed = ['meshllm', 'ollama', 'openrouter', 'mlx'] as const;
                    const next = { ...(lp.providerEnabled ?? {}) } as Record<string, boolean>;
                    for (const key of allowed) {
                        if (typeof parsed.providerEnabled[key] === 'boolean') next[key] = parsed.providerEnabled[key];
                    }
                    lp.providerEnabled = next;
                }
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

    // ── /api/providers ─────────────────────────────────────────────────────
    use('/api/providers', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        
        const { readLoopProviderConfig: readLp, readLoopProviderToggles, detectLoopProvider, DEFAULT_LOOP_PROVIDER_TOGGLES } = await import('../agent-runner/provider');
        const providerToggles = readLoopProviderToggles(configFile);
        const lp = readLp(configFile);
        
        // ── helpers ──────────────────────────────────────────
        async function probeProvider(def: {
            id: string; name: string; baseUrl: string; enabled: boolean;
            apiKey?: string; envHost?: string; defaultPort?: string; isCustom?: boolean;
        }) {
            const usedKey = def.apiKey;
            if (!def.enabled) {
                return { id: def.id, name: def.name, enabled: false, healthy: false,
                    error: 'Disabled in config', models: [], baseUrl: def.baseUrl,
                    modelCount: 0, selectedModel: null, envHost: def.envHost ?? null,
                    defaultPort: def.defaultPort ?? null, isCustom: def.isCustom ?? false };
            }
            let healthy = false, error: string | null = null, models: Array<{ id: string; label: string }> = [];
            try {
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (usedKey) headers['Authorization'] = `Bearer ${usedKey}`;
                const modelRes = await fetch(`${def.baseUrl}/models`, { headers, signal: AbortSignal.timeout(5_000) });
                if (modelRes.ok) {
                    healthy = true;
                    const data = await modelRes.json() as { data?: Array<{ id: string; name?: string }>; models?: Array<{ id: string; name?: string }> };
                    const list = data.data ?? data.models ?? [];
                    models = list.slice(0, 100).map((m: { id: string; name?: string }) => ({ id: m.id, label: m.name ?? m.id }));
                } else error = `HTTP ${modelRes.status}: ${modelRes.statusText}`;
            } catch (e: unknown) { error = e instanceof Error ? e.message : String(e); }
            const currentProvider = detectLoopProvider(lp.baseUrl);
            const isActive = currentProvider === def.id || (!['mlx','ollama','meshllm','openrouter'].includes(def.id) && lp.baseUrl === def.baseUrl);
            const selectedModel = isActive ? lp.model : null;
            return { id: def.id, name: def.name, enabled: def.enabled, healthy, error, models,
                baseUrl: def.baseUrl, modelCount: models.length, selectedModel, isActive,
                envHost: def.envHost ?? null, defaultPort: def.defaultPort ?? null, isCustom: def.isCustom ?? false };
        }

        function readCustomProviders(cfg: Record<string, unknown>): Array<{
            id: string; name: string; baseUrl: string; apiKey?: string; model?: string;
        }> {
            const scheduler = cfg.scheduler as Record<string, unknown> | undefined;
            const custom = scheduler?.customProviders as Array<Record<string, unknown>> | undefined;
            return (custom ?? []).map((c, i) => ({
                id: `custom-${i}`,
                name: (c.name as string) ?? `Custom ${i + 1}`,
                baseUrl: (c.baseUrl as string) ?? '',
                apiKey: c.apiKey as string | undefined,
                model: c.model as string | undefined,
            }));
        }

        // ── PUT: switch/connect/toggle/remove ─────────────────────
        if (req.method === 'PUT') {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body) as Record<string, unknown>;
                const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
                if (!cfg.scheduler) cfg.scheduler = { agents: {} };
                if (!cfg.scheduler.loopProvider) cfg.scheduler.loopProvider = {};
                const lpCfg = cfg.scheduler.loopProvider as Record<string, unknown>;

                // Handle toggle updates
                const toggle = parsed.toggle as Record<string, boolean> | undefined;
                if (toggle) {
                    if (!lpCfg.providerEnabled) lpCfg.providerEnabled = { ...DEFAULT_LOOP_PROVIDER_TOGGLES };
                    const pe = lpCfg.providerEnabled as Record<string, unknown>;
                    for (const [id, enabled] of Object.entries(toggle)) pe[id] = enabled;
                }

                // Handle addProvider
                const addProvider = parsed.addProvider as Record<string, unknown> | undefined;
                if (addProvider) {
                    if (!cfg.scheduler.customProviders) cfg.scheduler.customProviders = [];
                    const arr = cfg.scheduler.customProviders as Array<Record<string, unknown>>;
                    const entry: Record<string, unknown> = {
                        name: addProvider.name ?? 'Custom',
                        baseUrl: (addProvider.baseUrl as string ?? '').replace(/\/$/, ''),
                    };
                    if (addProvider.apiKey) entry.apiKey = addProvider.apiKey;
                    if (addProvider.model) entry.model = addProvider.model;
                    arr.push(entry);
                }

                // Handle removeProvider
                const removeProvider = parsed.removeProvider as string | undefined;
                if (removeProvider && cfg.scheduler.customProviders) {
                    const arr = cfg.scheduler.customProviders as Array<Record<string, unknown>>;
                    cfg.scheduler.customProviders = arr.filter((c) => (c.name as string) !== removeProvider);
                }

                // Handle provider switch
                const provider = parsed.provider as string | undefined;
                if (provider) {
                    const apiKey = parsed.apiKey as string | undefined | null;
                    const model = parsed.model as string | undefined | null;
                    switch (provider) {
                        case 'mlx': {
                            const mlxHost = process.env.MLX_HOST || 'http://localhost:8082';
                            lpCfg.baseUrl = `${mlxHost.replace(/\/$/, '')}/v1`;
                            if (apiKey !== undefined) lpCfg.apiKey = apiKey || undefined;
                            if (model !== undefined) lpCfg.model = model || undefined;
                            else if (!lpCfg.model) lpCfg.model = 'auto';
                            break;
                        }
                        case 'ollama': {
                            const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
                            lpCfg.baseUrl = `${ollamaHost.replace(/\/$/, '')}/v1`;
                            if (apiKey !== undefined) lpCfg.apiKey = apiKey || undefined;
                            if (model !== undefined) lpCfg.model = model || undefined;
                            else if (!lpCfg.model) lpCfg.model = 'auto';
                            break;
                        }
                        case 'meshllm': {
                            const meshHost = process.env.MESHLLM_HOST || 'http://localhost:9337';
                            lpCfg.baseUrl = `${meshHost.replace(/\/$/, '')}/v1`;
                            if (apiKey !== undefined) lpCfg.apiKey = apiKey || undefined;
                            if (model !== undefined) lpCfg.model = model || undefined;
                            else if (!lpCfg.model) lpCfg.model = 'auto';
                            break;
                        }
                        case 'openrouter': {
                            lpCfg.baseUrl = 'https://openrouter.ai/api/v1';
                            if (apiKey !== undefined) lpCfg.apiKey = apiKey || undefined;
                            if (model !== undefined) lpCfg.model = model || undefined;
                            else if (!lpCfg.model) lpCfg.model = 'deepseek/deepseek-v3.2';
                            break;
                        }
                        default: {
                            const customProv = readCustomProviders(cfg).find(c => c.id === provider || c.name === provider);
                            if (customProv) {
                                lpCfg.baseUrl = customProv.baseUrl;
                                if (apiKey !== undefined) lpCfg.apiKey = apiKey || customProv.apiKey || undefined;
                                else if (customProv.apiKey) lpCfg.apiKey = customProv.apiKey;
                                if (model !== undefined) lpCfg.model = model || customProv.model || undefined;
                                else if (customProv.model) lpCfg.model = customProv.model;
                                else if (!lpCfg.model) lpCfg.model = 'auto';
                            } else {
                                json(res, { error: `Unknown provider: ${provider}` }, 400);
                                return;
                            }
                        }
                    }
                    if (apiKey === null) delete lpCfg.apiKey;
                    if (model === null) delete lpCfg.model;
                }

                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                bustModelCache();
                json(res, { ok: true });
            } catch (e: unknown) {
                json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
            }
            return;
        }

        // ── GET: probe all providers ────────────────────────────────────
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }

        const builtInDefs = [
            { id: 'mlx', name: 'MLX', baseUrl: process.env.MLX_HOST ? `${process.env.MLX_HOST.replace(/\/$/, '')}/v1` : 'http://localhost:8082/v1', enabled: providerToggles.mlx, envHost: 'MLX_HOST', defaultPort: '8082' },
            { id: 'ollama', name: 'Ollama', baseUrl: process.env.OLLAMA_HOST ? `${process.env.OLLAMA_HOST.replace(/\/$/, '')}/v1` : 'http://localhost:11434/v1', enabled: providerToggles.ollama, envHost: 'OLLAMA_HOST', defaultPort: '11434' },
            { id: 'meshllm', name: 'MeshLLM', baseUrl: process.env.MESHLLM_HOST ? `${process.env.MESHLLM_HOST.replace(/\/$/, '')}/v1` : 'http://localhost:9337/v1', enabled: providerToggles.meshllm, envHost: 'MESHLLM_HOST', defaultPort: '9337' },
            { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: providerToggles.openrouter },
        ];

        const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
        const customDefs = readCustomProviders(cfg).map(c => ({
            id: c.id, name: c.name, baseUrl: c.baseUrl,
            enabled: true, apiKey: c.apiKey, isCustom: true,
        }));

        const results = await Promise.all(
            [...builtInDefs.map(d => probeProvider({ ...d, apiKey: d.id === 'openrouter' ? (process.env.OPENROUTER_API_KEY || lp.apiKey) : undefined })),
             ...customDefs.map(d => probeProvider(d))]
        );
        
        const { resolveSmartModel } = await import('../brainModel');
        const brainModel = (() => { try { return resolveSmartModel(configFile); } catch { return null; } })();
        
        json(res, {
            providers: results,
            activeProvider: detectLoopProvider(lp.baseUrl),
            activeModel: lp.model,
            brainModel: brainModel ? { source: (brainModel as any).source ?? 'unknown', model: (brainModel as any).model ?? null, baseUrl: (brainModel as any).baseUrl ?? null } : null,
        });
    });

    // ── /api/providers/github-device-flow ─────────────────────────────────────
    use('/api/providers/github-device-flow', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }

        const body = await readBody(req);
        try {
            const parsed = JSON.parse(body);
            const { action } = parsed;
            const { initiateDeviceCode, pollForToken, validateAccessToken } = await import('../agent-runner/github-device-flow');

            if (action === 'initiate') {
                const deviceCodeResponse = await initiateDeviceCode('gist');
                json(res, {
                    deviceCode: deviceCodeResponse.device_code,
                    userCode: deviceCodeResponse.user_code,
                    verificationUri: deviceCodeResponse.verification_uri,
                    expiresIn: deviceCodeResponse.expires_in,
                    interval: deviceCodeResponse.interval,
                });
                return;
            }

            if (action === 'poll') {
                const { deviceCode, interval, expiresIn } = parsed;
                if (!deviceCode || !interval || !expiresIn) {
                    json(res, { error: 'Missing deviceCode, interval, or expiresIn' }, 400);
                    return;
                }
                const tokenResponse = await pollForToken(deviceCode, interval, expiresIn);
                const userInfo = await validateAccessToken(tokenResponse.access_token);
                if (!userInfo) {
                    json(res, { error: 'Failed to validate access token' }, 400);
                    return;
                }
                const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) as Record<string, any> : {};
                if (!cfg.scheduler) cfg.scheduler = {};
                if (!cfg.scheduler.customProviders) cfg.scheduler.customProviders = [];
                const copilotIndex = cfg.scheduler.customProviders.findIndex((p: any) => p.name === 'GitHub Copilot');
                const copilotProvider = {
                    name: 'GitHub Copilot',
                    baseUrl: 'https://api.github.com/copilot_internal/v2/token',
                    apiKey: tokenResponse.access_token,
                    model: 'github-copilot/claude-haiku-4.5',
                    githubLogin: userInfo.login,
                };
                if (copilotIndex >= 0) {
                    cfg.scheduler.customProviders[copilotIndex] = copilotProvider;
                } else {
                    cfg.scheduler.customProviders.push(copilotProvider);
                }
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                bustModelCache();
                json(res, {
                    ok: true,
                    provider: {
                        name: copilotProvider.name,
                        model: copilotProvider.model,
                        login: userInfo.login,
                    },
                });
                return;
            }

            json(res, { error: 'Invalid action' }, 400);
        } catch (e: unknown) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
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
