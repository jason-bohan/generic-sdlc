import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { execFile } from 'child_process';
import { readDriverConfig, findCursorCli } from '../agent-drivers';
import { isCursorAiEnabled, isClaudeEnabled, isOpenCodeEnabled } from '../cursor-ai-policy';
import { readLoopProviderConfig } from '../agent-runner/provider';
import { readBody, json, cors } from '../router';
import { getSchedulerConfig } from '../route-shared';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';

export let bustModelCache: () => void = () => {};

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/agent/models ────────────────────────────────────────────────────
    type ModelOption = { id: string; label: string; category: 'auto' | 'cloud' | 'local'; tag?: string };
    let cacheTimestamp = 0;
    const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // refresh every 5 min

    function getClaudeCodeModels(): ModelOption[] {
        return [
            { id: 'auto', label: 'Auto (default)', category: 'auto' },
            { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', category: 'cloud', tag: 'MAX' },
            { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', category: 'cloud' },
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', category: 'cloud' },
            { id: 'local', label: 'Local (Ollama)', category: 'local' },
        ];
    }

    async function getNonCursorModels(): Promise<ModelOption[]> {
        const loopProvider = readLoopProviderConfig(configFile);
        const base: ModelOption[] = [
            { id: 'auto', label: 'Auto (strongest available)', category: 'auto' },
        ];
        try {
            const headers: Record<string, string> = {};
            if (loopProvider.apiKey) headers.Authorization = `Bearer ${loopProvider.apiKey}`;
            const r = await fetch(`${loopProvider.baseUrl}/models`, {
                headers,
                signal: AbortSignal.timeout(5_000),
            });
            if (r.ok) {
                const data = await r.json() as { data?: Array<{ id: string; name?: string }>; models?: Array<{ id: string; name?: string }> };
                const list = data.data ?? data.models ?? [];
                for (const m of list) {
                    base.push({ id: m.id, label: m.name ?? m.id, category: 'cloud' });
                }
            }
        } catch { /* provider not running — continue with fallback */ }
        if (base.length === 1) {
            base.push({ id: loopProvider.model, label: `${loopProvider.model} (configured)`, category: 'cloud' });
        }

        // Fetch all local Ollama models
        try {
            const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
            const r = await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(3_000) });
            if (r.ok) {
                const data = await r.json() as { models?: Array<{ name: string; digest?: string; size?: number }> };
                const ollamaModels = data.models ?? [];
                for (const m of ollamaModels) {
                    const id = m.name;
                    if (!base.some(b => b.id === id)) {
                        base.push({ id, label: id, category: 'local' });
                    }
                }
            }
        } catch { /* Ollama not running */ }

        if (!base.some(m => m.id === 'local')) {
            base.push({ id: 'local', label: 'Local (Ollama)', category: 'local' });
        }
        return base;
    }

    function fetchModelsFromCli(): Promise<ModelOption[]> {
        const driver = readDriverConfig(resolve(rootDir, '.sdlc-framework.config.json'));

        if (driver.type === 'cursor' && !isCursorAiEnabled(configFile)) {
            return getNonCursorModels();
        }

        if (driver.type === 'claude-code') {
            if (!isClaudeEnabled(configFile)) return getNonCursorModels();
            return Promise.resolve(getClaudeCodeModels());
        }

        if (driver.type === 'opencode') {
            if (!isOpenCodeEnabled(configFile)) return getNonCursorModels();
            return getNonCursorModels();
        }

        if (driver.type === 'loop') {
            return getNonCursorModels();
        }

        if (driver.type === 'goose' || driver.type === 'generic') {
            return Promise.resolve(getFallbackModels());
        }

        // cursor driver — query the agent CLI for live model list
        return new Promise((resolve) => {
            const cursorCli = findCursorCli();
            if (!cursorCli) {
                console.warn('[models] Cursor CLI not found, using fallback models');
                resolve(getFallbackModels());
                return;
            }
            const needsShell = cursorCli.endsWith('.cmd') || cursorCli.endsWith('.bat');
            execFile(cursorCli, ['--list-models'], {
                timeout: 15_000,
                ...(needsShell ? { shell: true, windowsHide: true } : {}) }, (err, stdout) => {
                if (err || !stdout) {
                    console.warn('[models] Failed to fetch from Cursor CLI, using fallback:', err?.message);
                    resolve(getFallbackModels());
                    return;
                }
                const models: ModelOption[] = [
                    { id: 'auto', label: 'Auto (default)', category: 'auto' },
                ];
                const MAX_PREFIXES = ['gpt-5.5', 'gpt-5.4', 'claude-opus-4-7', 'grok-'];
                const MAX_CONTAINS = ['-max', '-xhigh'];
                for (const line of stdout.split('\n')) {
                    const match = line.match(/^(\S+)\s+-\s+(.+?)(?:\s+\((?:current|default)\))?$/);
                    if (!match || match[1] === 'auto') continue;
                    const id = match[1];
                    const isMax = MAX_PREFIXES.some(p => id.startsWith(p)) || MAX_CONTAINS.some(s => id.includes(s));
                    models.push({ id, label: match[2].trim(), category: 'cloud', ...(isMax ? { tag: 'MAX' } : {}) });
                }
                models.push({ id: 'local', label: 'Local (Ollama)', category: 'local' });
                resolve(models);
            });
        });
    }

    function getFallbackModels(): ModelOption[] {
        return [
            { id: 'auto', label: 'Auto (default)', category: 'auto' },
            { id: 'claude-4.6-opus-high', label: 'Opus 4.6 High', category: 'cloud' },
            { id: 'claude-4.6-sonnet-medium', label: 'Sonnet 4.6 Medium', category: 'cloud' },
            { id: 'gpt-5.5-medium', label: 'GPT-5.5 Medium', category: 'cloud' },
            { id: 'gpt-5.3-codex', label: 'Codex 5.3 Medium', category: 'cloud' },
            { id: 'composer-2-fast', label: 'Composer 2 Fast', category: 'cloud' },
            { id: 'local', label: 'Local (Ollama)', category: 'local' },
        ];
    }

    let cachedCliModels: ModelOption[] | null = null;

    // Called by config route when Cursor AI, Claude AI, or OpenCode toggle changes
    bustModelCache = () => { cachedCliModels = null; cacheTimestamp = 0; };

    async function getAvailableModels(): Promise<ModelOption[]> {
        const now = Date.now();
        if (!cachedCliModels || (now - cacheTimestamp) >= MODEL_CACHE_TTL_MS) {
            cachedCliModels = await fetchModelsFromCli();
            cacheTimestamp = now;
            console.log(`[models] Fetched ${cachedCliModels.length} models from CLI`);
        }

        // Drop noisy variants — keep only meaningful tiers
        const filtered = cachedCliModels.filter(m => {
            if (m.category !== 'cloud') return true;
            if (m.id.endsWith('-fast')) return false;
            if (m.id.endsWith('-none')) return false;
            if (m.id.endsWith('-low')) return false;
            return true;
        });

        // If CLI returned no cloud models, merge the fallback set
        const hasCloud = filtered.some(m => m.category === 'cloud');
        if (!hasCloud) {
            const fallback = getFallbackModels();
            const seen = new Set(filtered.map(m => m.id));
            for (const m of fallback) {
                if (!seen.has(m.id)) { filtered.push(m); seen.add(m.id); }
            }
            console.log('[models] CLI returned no cloud models, merged fallback set');
        }

        return filtered;
    }

    // Warm the cache on startup
    getAvailableModels().catch(() => {});

    use('/api/agent/models', async (_req, res) => {
        cors(res);
        const models = await getAvailableModels();
        json(res, { models });
    });


    // ── /api/agent/model ─────────────────────────────────────────────────
    use('/api/agent/model', async (req, res) => {
        cors(res, 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        const agentId = (req.url || '').replace(/^\/api\/agent\/model\/?/, '').replace(/\?.*$/, '');
        if (req.method === 'GET') {
            const cfg = getSchedulerConfig(rootDir);
            json(res, { agentId, model: cfg.scheduler?.agents?.[agentId]?.model ?? 'auto' });
            return;
        }
        if (req.method === 'POST') {
            const body = await readBody(req);
            try {
                const parsed = body ? JSON.parse(body) : {};
                const id = parsed.agentId || agentId;
                if (!id) { json(res, { error: 'agentId required' }, 400); return; }
                const model = typeof parsed.model === 'string' ? parsed.model.trim() : 'auto';
                const cfg = getSchedulerConfig(rootDir);
                if (!cfg.scheduler) cfg.scheduler = { mode: 'notify', agents: {} };
                if (!cfg.scheduler.agents) cfg.scheduler.agents = {};
                if (!cfg.scheduler.agents[id]) cfg.scheduler.agents[id] = { enabled: true, autoStart: false };
                cfg.scheduler.agents[id].model = model;
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                console.log(`[agent-model] ${id}: ${model}`);
                json(res, { agentId: id, model });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
            return;
        }
        res.statusCode = 405; res.end('Method not allowed');
    });

    // ── /api/agent/display-names ────────────────────────────────────────────
    use('/api/agent/display-names', async (req, res) => {
        cors(res, 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

        if (req.method === 'GET') {
            const cfg = getSchedulerConfig(rootDir);
            const agents = cfg.scheduler?.agents ?? {};
            const names: Record<string, string> = {};
            for (const [id, agentCfg] of Object.entries(agents)) {
                if ((agentCfg as any).displayName) names[id] = (agentCfg as any).displayName;
            }
            json(res, { displayNames: names });
            return;
        }

        if (req.method === 'POST') {
            try {
                const body = await readBody(req);
                const { agentId, displayName } = JSON.parse(body);
                if (!agentId || typeof displayName !== 'string') {
                    json(res, { error: 'agentId and displayName required' }, 400);
                    return;
                }
                const cfg = parseJsonUtf8File(configFile);
                if (!cfg.scheduler) cfg.scheduler = { mode: 'notify', agents: {} };
                if (!cfg.scheduler.agents) cfg.scheduler.agents = {};
                if (!cfg.scheduler.agents[agentId]) cfg.scheduler.agents[agentId] = { enabled: true, autoStart: false };
                const trimmed = displayName.trim();
                if (trimmed) {
                    cfg.scheduler.agents[agentId].displayName = trimmed;
                } else {
                    delete cfg.scheduler.agents[agentId].displayName;
                }
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                console.log(`[display-name] ${agentId}: ${trimmed || '(reset to default)'}`);
                json(res, { agentId, displayName: trimmed || null });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
            return;
        }

        res.statusCode = 405; res.end('Method not allowed');
    });
}
