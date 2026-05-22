import { readBody, json } from '../router';
import { getOllamaHealth, isEmbeddingReady, getActiveModel, startOllamaManager } from '../ollamaManager';
import { buildRagIndex } from '../ragIndex';
import { getExecMode } from '../modes';
import { updateTokens } from '../tokens';
import type { UseFn } from './types';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/ollama/health ───────────────────────────────────────────────────
    use('/api/ollama/health', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try { json(res, await getOllamaHealth()); } catch { json(res, { error: 'health check failed' }, 500); }
    });

    // ── /api/ollama/launch ───────────────────────────────────────────────────
    use('/api/ollama/launch', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        try {
            startOllamaManager(rootDir);
            json(res, { ok: true, message: 'Ollama launch requested — health will confirm when ready.' });
        } catch (e) {
            json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── /api/ollama/reindex ──────────────────────────────────────────────────
    use('/api/ollama/reindex', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        if (!isEmbeddingReady()) { json(res, { error: 'Embedding model not ready' }, 503); return; }
        const body = await readBody(req);
        const { workspaceDir } = body ? JSON.parse(body) : {};
        const dir = workspaceDir || rootDir;
        const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
        try {
            const idx = await buildRagIndex(dir, rootDir, ollamaHost);
            json(res, { ok: true, chunks: idx?.chunks.length ?? 0, workspaceDir: dir });
        } catch (e) { json(res, { error: String(e) }, 500); }
    });

    // ── /api/ollama/generate ─────────────────────────────────────────────────
    use('/api/ollama/generate', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        if (getExecMode(configFile) === 'speed') { json(res, { skipped: true, reason: 'speed mode' }, 503); return; }
        const body = await readBody(req);
        try {
            const { prompt, model, system, agentId } = JSON.parse(body);
            const resolvedAgentId = agentId || 'frontend';
            const ollamaModel = model || getActiveModel();
            const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
            const ollamaRes = await fetch(`${ollamaHost}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: ollamaModel, prompt, system: system || 'You are a senior frontend engineer. Return only code, no explanations unless asked.', stream: false }) });
            if (!ollamaRes.ok) { json(res, { error: `Ollama ${ollamaRes.status}: ${ollamaRes.statusText}` }, 502); return; }
            const data = await ollamaRes.json();
            const inputTokens = data.prompt_eval_count || 0;
            const outputTokens = data.eval_count || 0;
            const tokenResult = updateTokens(rootDir, { agentId: resolvedAgentId, source: 'ollama', input: inputTokens, output: outputTokens });
            if (!tokenResult.ok) console.warn(`[ollama/generate] Token tracking failed for ${resolvedAgentId}: ${tokenResult.error}`);
            json(res, { response: data.response, model: ollamaModel, tokens: { input: inputTokens, output: outputTokens } });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
