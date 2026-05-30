import { readBody, json, cors } from '../router';
import { getLedger, getStoryTokens } from '../ledger';
import { updateTokens } from '../tokens';
import { getActiveProjectName } from '../project-config';
import type { UseFn } from './types';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // Resolve the project to attribute token usage to: an explicit value from the
    // caller (e.g. an agent that knows its worktree's repo) wins; otherwise default
    // to the active project so single-project setups are correctly tagged.
    const resolveProject = (explicit?: unknown): string | null => {
        if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
        try { return getActiveProjectName(configFile) || null; } catch { return null; }
    };
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
            const parsed = JSON.parse(body);
            const result = updateTokens(rootDir, { ...parsed, project: resolveProject(parsed.project), team: parsed.team ?? null });
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
            const { agentId, input, output, project, team } = JSON.parse(body);
            const result = updateTokens(rootDir, { agentId: agentId || 'frontend', source: 'cloud', input: input || 0, output: output || 0, project: resolveProject(project), team: team ?? null });
            if (!result.ok) { json(res, { error: result.error }, 400); return; }
            json(res, { ok: true, tokens: result.tokens });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
