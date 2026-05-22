import { readBody, json, cors } from '../router';
import { getLedger, getStoryTokens } from '../ledger';
import { updateTokens } from '../tokens';
import type { UseFn } from './types';

export function mount(use: UseFn, rootDir: string, _configFile: string): void {
    // ── /api/tokens/ledger ───────────────────────────────────────────────────
    use('/api/tokens/ledger', (req, res) => {
        try {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            const storyParam = url.searchParams.get('story');
            json(res, storyParam ? (getStoryTokens(rootDir, storyParam) ?? { storyName: null, entries: [], totals: { input: 0, output: 0 } }) : getLedger(rootDir));
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/tokens/update ───────────────────────────────────────────────────
    use('/api/tokens/update', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { json(res, { error: 'Method not allowed' }, 405); return; }
        const body = await readBody(req);
        try {
            const result = updateTokens(rootDir, JSON.parse(body));
            if (!result.ok) { json(res, { error: result.error }, 400); return; }
            json(res, { ok: true, tokens: result.tokens });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/tokens/cloud ────────────────────────────────────────────────────
    use('/api/tokens/cloud', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { json(res, { error: 'Method not allowed' }, 405); return; }
        const body = await readBody(req);
        try {
            const { agentId, input, output } = JSON.parse(body);
            const result = updateTokens(rootDir, { agentId: agentId || 'frontend', source: 'cloud', input: input || 0, output: output || 0 });
            if (!result.ok) { json(res, { error: result.error }, 400); return; }
            json(res, { ok: true, tokens: result.tokens });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
