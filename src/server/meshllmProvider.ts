/**
 * MeshLLM integration — wraps the OpenAI-compatible API at localhost:9337/v1.
 * Falls back gracefully when MeshLLM is not running.
 */

import { ollamaHost, getActiveModel } from './ollamaManager';
import { meshllmLog as log } from './logger';

const MESHLLM_DEFAULT_HOST = 'http://localhost:9337';
const PROBE_TIMEOUT_MS = 3_000;
const GENERATE_TIMEOUT_MS = 180_000;

let _meshllmAvailable = false;
let _lastProbe = 0;
const PROBE_COOLDOWN_MS = 30_000;

export function meshllmHost(): string {
    return process.env.MESHLLM_HOST || MESHLLM_DEFAULT_HOST;
}

export function isMeshllmAvailable(): boolean {
    return _meshllmAvailable;
}

/** Probe MeshLLM's /v1/models endpoint to check availability. */
export async function probeMeshllm(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && now - _lastProbe < PROBE_COOLDOWN_MS) return _meshllmAvailable;
    _lastProbe = now;

    try {
        const res = await fetch(`${meshllmHost()}/v1/models`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        _meshllmAvailable = res.ok;
        if (_meshllmAvailable) log.success('detected at ' + meshllmHost());
    } catch {
        _meshllmAvailable = false;
    }
    return _meshllmAvailable;
}

export interface MeshllmModel {
    id: string;
    object: string;
    owned_by?: string;
}

export interface MeshllmNode {
    id: string;
    name: string;
    models: string[];
    latency?: number;
}

interface MeshllmModelsResponse {
    data?: MeshllmModel[];
    peers?: number;
}

async function fetchMeshllmModels(): Promise<MeshllmModelsResponse | null> {
    try {
        const res = await fetch(`${meshllmHost()}/v1/models`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        _meshllmAvailable = res.ok;
        if (!res.ok) return null;
        const text = await res.text();
        if (!text.trim()) return { data: [] };
        return JSON.parse(text) as MeshllmModelsResponse;
    } catch {
        _meshllmAvailable = false;
        return null;
    }
}

/** List models available on the MeshLLM mesh. */
export async function listMeshllmModels(): Promise<MeshllmModel[]> {
    const data = await fetchMeshllmModels();
    return data?.data ?? [];
}

export async function listMeshllmNodes(): Promise<{ nodes: MeshllmNode[]; selectedNode?: string }> {
    try {
        const res = await fetch(`${meshllmHost()}/v1/nodes`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return { nodes: [] };
        const data = (await res.json()) as { nodes?: MeshllmNode[]; selected?: string };
        return {
            nodes: Array.isArray(data.nodes) ? data.nodes : [],
            selectedNode: data.selected,
        };
    } catch {
        return { nodes: [] };
    }
}

export async function selectMeshllmNode(nodeId: string): Promise<boolean> {
    try {
        const res = await fetch(`${meshllmHost()}/v1/nodes/select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return res.ok;
    } catch {
        return false;
    }
}

export interface MeshllmGenerateOpts {
    model?: string;
    prompt: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
}

export interface MeshllmGenerateResult {
    response: string;
    model: string;
    tokens: { input: number; output: number };
    provider: 'meshllm' | 'ollama';
}

/**
 * Generate a completion via MeshLLM's OpenAI-compatible chat endpoint.
 * If MeshLLM is unavailable, falls back to Ollama /api/generate.
 */
export async function meshllmGenerate(opts: MeshllmGenerateOpts): Promise<MeshllmGenerateResult> {
    const available = await probeMeshllm();

    if (available) {
        try {
            return await callMeshllm(opts);
        } catch (e) {
            log.warn(`MeshLLM generate failed, falling back to Ollama: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return callOllamaFallback(opts);
}

async function callMeshllm(opts: MeshllmGenerateOpts): Promise<MeshllmGenerateResult> {
    const model = opts.model || 'Qwen3-8B';
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: opts.prompt });

    const res = await fetch(`${meshllmHost()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: opts.maxTokens ?? 2048,
            temperature: opts.temperature ?? 0.2,
            stream: false,
        }),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`MeshLLM ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const tokens = {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
    };
    log.info(`generate ${model} ${tokens.input}+${tokens.output} tok`);
    return {
        response: content,
        model,
        tokens,
        provider: 'meshllm',
    };
}

async function callOllamaFallback(opts: MeshllmGenerateOpts): Promise<MeshllmGenerateResult> {
    const model = getActiveModel();
    const res = await fetch(`${ollamaHost()}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            prompt: opts.prompt,
            system: opts.system,
            stream: false,
            options: {
                temperature: opts.temperature ?? 0.2,
                num_predict: opts.maxTokens ?? 2048,
            },
        }),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`Ollama fallback ${res.status}`);

    const data = (await res.json()) as {
        response: string;
        prompt_eval_count?: number;
        eval_count?: number;
    };

    const tokens = {
        input: data.prompt_eval_count ?? 0,
        output: data.eval_count ?? 0,
    };
    log.warn(`fallback generate ${model} ${tokens.input}+${tokens.output} tok (Ollama)`);
    return {
        response: data.response ?? '',
        model,
        tokens,
        provider: 'ollama',
    };
}

// ─── Model-class routing ──────────────────────────────────────────────────────

/**
 * Named task classes that map to specific model tiers.
 *   edit   — fine-tuned diff model (sdlc-tuned); best precision
 *   fast   — lightweight base model (Qwen3-8B); low latency inner loops
 *   reason — strongest available model; complex multi-file reasoning
 */
export type ModelClass = 'edit' | 'fast' | 'reason';

/**
 * Preferred model names per class, in priority order.
 * The first name that appears in `availableModels` wins.
 * Falls back to the first available model if none match.
 */
const MODEL_CLASS_CANDIDATES: Record<ModelClass, string[]> = {
    edit:   ['sdlc-tuned', 'sdlc-framework-diff', 'Qwen3-8B', 'qwen3:8b'],
    fast:   ['Qwen3-8B', 'qwen3:8b', 'qwen3:4b', 'phi4'],
    reason: ['Qwen3-14B', 'qwen3:14b', 'Qwen3-32B', 'qwen3:32b', 'sdlc-tuned', 'Qwen3-8B'],
};

/**
 * Resolve a model class to the best available model name.
 * If MeshLLM is not available the environment variable SDLC_FRAMEWORK_DEFAULT_MODEL
 * (or 'Qwen3-8B') is used as an unconditional fallback.
 */
export function resolveModelForClass(cls: ModelClass, availableModels: string[]): string {
    const candidates = MODEL_CLASS_CANDIDATES[cls] ?? MODEL_CLASS_CANDIDATES.fast;
    const availableByLower = new Map(availableModels.map((m) => [m.toLowerCase(), m]));
    for (const candidate of candidates) {
        const available = availableByLower.get(candidate.toLowerCase());
        if (available) return available;
    }
    return availableModels[0] ?? (process.env.SDLC_FRAMEWORK_DEFAULT_MODEL || 'Qwen3-8B');
}

/**
 * Generate a completion using a named task class instead of a raw model name.
 * Probes available models, picks the best match, then delegates to meshllmGenerate.
 */
export async function meshllmGenerateForClass(
    cls: ModelClass,
    opts: Omit<MeshllmGenerateOpts, 'model'>,
): Promise<MeshllmGenerateResult> {
    const models = await listMeshllmModels();
    const modelName = resolveModelForClass(cls, models.map((m) => m.id));
    return meshllmGenerate({ ...opts, model: modelName });
}

/** Health snapshot for the /api/meshllm/health endpoint. */
export async function getMeshllmHealth() {
    const available = await probeMeshllm(true);
    const modelData = available ? await fetchMeshllmModels() : null;
    const models = modelData?.data ?? [];
    const nodes = available ? await listMeshllmNodes() : { nodes: [] };
    const ownedBy = new Set(models.map((m) => m.owned_by).filter(Boolean));
    return {
        available,
        host: meshllmHost(),
        models: models.map((m) => m.id),
        peers: modelData?.peers ?? ownedBy.size,
        nodes: nodes.nodes,
        selectedNode: nodes.selectedNode,
        lastChecked: new Date().toISOString(),
    };
}
