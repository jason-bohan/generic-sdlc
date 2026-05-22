import { resolve } from 'path';
import { resolveWorktreeRepoRoots, sweepWorktrees } from '../worktree-cleanup';
import { sendTeamsNotification } from '../teams-notify';
import { openApiSpec } from '../openapi';
import { readBody, json, cors } from '../router';
import type { UseFn } from './types';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/worktrees/sweep ───────────────────────────────────────────────
    use('/api/worktrees/sweep', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const rawBody = await readBody(req);
        try {
            let dryRun = false;
            let force = false;
            let singleRepo: string | undefined;
            if (rawBody && rawBody.trim()) {
                let p: Record<string, unknown>;
                try { p = JSON.parse(rawBody) as Record<string, unknown>; }
                catch { json(res, { error: 'Invalid JSON body' }, 400); return; }
                dryRun = p.dryRun === true;
                force = p.force === true;
                if (typeof p.repoRoot === 'string' && p.repoRoot.trim()) singleRepo = p.repoRoot.trim();
            }
            const roots = singleRepo ? [resolve(singleRepo)] : resolveWorktreeRepoRoots(rootDir, configFile);
            const removed: string[] = [];
            const skipped: Array<{ path: string; branch: string | null; reason: string }> = [];
            let pruned = true;
            for (const r of roots) {
                const out = sweepWorktrees(r, { dryRun, force });
                removed.push(...out.removed);
                skipped.push(...out.skipped);
                pruned = pruned && out.pruned;
            }
            json(res, { removed, skipped, pruned });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/notify ──────────────────────────────────────────────────────────
    use('/api/notify', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { title, message, color } = JSON.parse(body);
            await sendTeamsNotification(rootDir, title || 'SDLC Framework', message || '', color);
            json(res, { ok: true });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/openapi.json ─────────────────────────────────────────────────────
    use('/api/openapi.json', (_req, res) => {
        cors(res);
        json(res, openApiSpec);
    });

    // ── / (Scalar API Reference) ───────────────────────────────────────────
    use('/', (req, res) => {
        const urlPath = (req.url ?? '/').split('?')[0];
        if (urlPath !== '/') { json(res, { error: 'Not found' }, 404); return; }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html>
<html>
<head>
  <title>SDLC Framework API Reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/api/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`);
    });
}
