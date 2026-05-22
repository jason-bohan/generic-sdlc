import { readBody, json, cors } from '../router';
import type { UseFn } from './types';

const CODING_KEYWORDS = ['code', 'coder', 'devstral', 'starcoder', 'qwen', 'deepseek', 'codex', 'gemma', 'llama', 'mistral', 'phi'];

function isCodingModel(id: string, name: string, description = ''): boolean {
    const text = `${id} ${name} ${description}`.toLowerCase();
    return CODING_KEYWORDS.some(kw => text.includes(kw));
}

interface ORModel {
    id: string;
    name: string;
    description?: string;
    pricing: { prompt: string; completion: string };
    context_length?: number;
}

export function mount(use: UseFn): void {
    // GET /api/openrouter/models — returns all free models, coding ones first
    use('/api/openrouter/models', async (req, res) => {
        cors(res);
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
            const r = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { 'HTTP-Referer': 'https://github.com/jason-bohan/generic-sdlc' },
                signal: AbortSignal.timeout(12000),
            });
            if (!r.ok) { json(res, { error: `OpenRouter ${r.status}: ${await r.text().then(t => t.slice(0, 200))}` }, 502); return; }
            const data = await r.json() as { data: ORModel[] };
            const free = (data.data ?? [])
                .filter(m => m.pricing.prompt === '0' && m.pricing.completion === '0')
                .map(m => ({
                    id: m.id,
                    name: m.name,
                    description: m.description?.slice(0, 120),
                    contextLength: m.context_length,
                    coding: isCodingModel(m.id, m.name, m.description),
                }))
                .sort((a, b) => Number(b.coding) - Number(a.coding));
            json(res, { models: free, total: free.length });
        } catch (e: unknown) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // POST /api/openrouter/test — fire a tiny completion and measure latency
    use('/api/openrouter/test', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        try {
            const body = JSON.parse(await readBody(req)) as { model: string; apiKey?: string; baseUrl?: string };
            const { model, baseUrl = 'https://openrouter.ai/api/v1' } = body;
            const apiKey = body.apiKey || process.env.OPENROUTER_API_KEY;
            if (!model?.trim()) { json(res, { error: 'model required' }, 400); return; }
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/jason-bohan/generic-sdlc',
            };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            const start = Date.now();
            const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: 'Reply with one word: ok' }],
                    max_tokens: 8,
                }),
                signal: AbortSignal.timeout(20000),
            });
            const latencyMs = Date.now() - start;
            if (!r.ok) {
                const text = await r.text();
                json(res, { ok: false, latencyMs, error: text.slice(0, 400) });
                return;
            }
            json(res, { ok: true, latencyMs });
        } catch (e: unknown) {
            json(res, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
}
