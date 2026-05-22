import { readBody, json } from '../router';
import { meshllmLog } from '../logger';
import {
    getMeshllmHealth,
    meshllmGenerate,
    listMeshllmModels,
    isMeshllmAvailable,
    listMeshllmNodes,
    selectMeshllmNode,
} from '../meshllmProvider';
import { resolveMeshllmLaunch, startMeshllm } from '../meshllmLauncher';
import { getExecMode } from '../modes';
import { updateTokens } from '../tokens';
import type { UseFn } from './types';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/meshllm/health ──────────────────────────────────────────────────
    use('/api/meshllm/health', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
            const health = await getMeshllmHealth();
            json(res, {
                ...health,
                launch: resolveMeshllmLaunch(),
            });
        }
        catch { json(res, { error: 'health check failed' }, 500); }
    });

    // ── /api/meshllm/launch ──────────────────────────────────────────────────
    use('/api/meshllm/launch', async (req, res) => {
        if (req.method === 'GET') {
            json(res, resolveMeshllmLaunch());
            return;
        }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        try {
            const health = await getMeshllmHealth();
            if (health.available) {
                json(res, { ok: true, alreadyRunning: true, message: 'MeshLLM is already available.', health });
                return;
            }
            json(res, await startMeshllm(rootDir));
        } catch (e: unknown) {
            json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── /api/meshllm/models ──────────────────────────────────────────────────
    use('/api/meshllm/models', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
            const models = await listMeshllmModels();
            json(res, { models, available: isMeshllmAvailable() });
        } catch { json(res, { error: 'failed to list models' }, 500); }
    });

    // ── /api/meshllm/nodes/select ────────────────────────────────────────────
    use('/api/meshllm/nodes/select', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        try {
            const { nodeId } = JSON.parse(await readBody(req));
            if (typeof nodeId !== 'string' || !nodeId) {
                json(res, { error: 'nodeId is required' }, 400);
                return;
            }
            json(res, { ok: await selectMeshllmNode(nodeId) });
        } catch (e: unknown) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── /api/meshllm/nodes ───────────────────────────────────────────────────
    use('/api/meshllm/nodes', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try { json(res, await listMeshllmNodes()); }
        catch { json(res, { error: 'failed to list nodes' }, 500); }
    });

    // ── /api/meshllm/generate ────────────────────────────────────────────────
    use('/api/meshllm/generate', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        if (getExecMode(configFile) === 'speed' && !isMeshllmAvailable()) {
            json(res, { skipped: true, reason: 'speed mode and MeshLLM unavailable' }, 503);
            return;
        }
        const body = await readBody(req);
        try {
            const { prompt, model, system, agentId, maxTokens, temperature } = JSON.parse(body);
            const result = await meshllmGenerate({
                prompt,
                model,
                system,
                maxTokens,
                temperature,
            });
            const resolvedAgentId = agentId || 'devops';
            const source = result.provider === 'meshllm' ? 'meshllm' : 'ollama';
            const tokenResult = updateTokens(rootDir, {
                agentId: resolvedAgentId,
                source,
                input: result.tokens.input,
                output: result.tokens.output,
            });
            if (!tokenResult.ok) {
                meshllmLog.warn(`token tracking failed: ${tokenResult.error}`);
            }
            json(res, result);
        } catch (e: unknown) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });
}
