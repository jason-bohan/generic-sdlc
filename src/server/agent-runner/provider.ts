import { existsSync } from 'node:fs';
import type { Message, ToolDefinition, CompletionResponse, ProviderConfig } from './types';
import { parseJsonUtf8File } from '../json-file';

export type LoopProviderName = 'meshllm' | 'ollama' | 'openrouter' | 'mlx' | 'custom';
export type LoopProviderToggles = Record<'meshllm' | 'ollama' | 'openrouter' | 'mlx', boolean>;

export const DEFAULT_LOOP_PROVIDER_TOGGLES: LoopProviderToggles = {
    meshllm: true,
    ollama: true,
    openrouter: true,
    mlx: true,
};

export function detectLoopProvider(baseUrl: string): LoopProviderName {
    const base = baseUrl.toLowerCase();
    if (base.includes('openrouter.ai')) return 'openrouter';
    if (base.includes(':9337') || base.includes('meshllm')) return 'meshllm';
    if (base.includes(':11434') || base.includes('ollama')) return 'ollama';
    if (base.includes(':8082') || base.includes(':8083') || base.includes('mlx')) return 'mlx';
    return 'custom';
}

export function readLoopProviderToggles(configPath: string): LoopProviderToggles {
    if (!existsSync(configPath)) return { ...DEFAULT_LOOP_PROVIDER_TOGGLES };
    try {
        const cfg = parseJsonUtf8File(configPath) as Record<string, unknown>;
        const scheduler = cfg.scheduler as Record<string, unknown> | undefined;
        const lp = scheduler?.loopProvider as Record<string, unknown> | undefined;
        const providerEnabled = lp?.providerEnabled as Partial<LoopProviderToggles> | undefined;
        return {
            meshllm: providerEnabled?.meshllm ?? DEFAULT_LOOP_PROVIDER_TOGGLES.meshllm,
            ollama: providerEnabled?.ollama ?? DEFAULT_LOOP_PROVIDER_TOGGLES.ollama,
            openrouter: providerEnabled?.openrouter ?? DEFAULT_LOOP_PROVIDER_TOGGLES.openrouter,
            mlx: providerEnabled?.mlx ?? DEFAULT_LOOP_PROVIDER_TOGGLES.mlx,
        };
    } catch {
        return { ...DEFAULT_LOOP_PROVIDER_TOGGLES };
    }
}

export class OpenAICompatibleProvider {
    private modelResolved = false;

    constructor(private readonly config: ProviderConfig) {}

    private async resolveModel(): Promise<void> {
        if (this.modelResolved) return;
        this.modelResolved = true;
        const { baseUrl, apiKey, model } = this.config;
        if (!model || model === 'auto') return;
        try {
            const headers: Record<string, string> = {};
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            const r = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(5_000) });
            if (!r.ok) return;
            const data = await r.json() as { data?: Array<{ id: string }> };
            const available = data.data?.map(m => m.id) ?? [];
            if (available.length > 0 && !available.includes(model)) {
                console.warn(`[provider] model "${model}" not found — using "${available[0]}" instead`);
                this.config.model = available[0];
            }
        } catch { /* provider unreachable — let complete() surface the error */ }
    }

    async complete(messages: Message[], tools: ToolDefinition[]): Promise<CompletionResponse> {
        await this.resolveModel();
        const { baseUrl, apiKey, model, maxTokens = 1500, temperature = 0.2 } = this.config;

        const body: Record<string, unknown> = {
            model,
            messages,
            temperature,
            max_tokens: maxTokens };

        if (tools.length > 0) {
            body.tools = tools;
            body.tool_choice = 'auto';
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(600_000) });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
        }

        const data = await res.json() as {
            choices: Array<{ message: Message; finish_reason: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        const choice = data.choices?.[0];
        if (!choice) throw new Error('Empty choices from LLM');

        return {
            message: choice.message,
            finish_reason: choice.finish_reason as CompletionResponse['finish_reason'],
            usage: data.usage
                ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
                : undefined };
    }
}

/**
 * `host.docker.internal` only resolves inside a Docker container (it points at the
 * host). When the server runs natively (no `/.dockerenv`), rewrite it to `localhost`
 * so a single Docker-canonical config works in both environments — in a container we
 * leave it untouched so the server can still reach host services like the MLX server.
 */
export function adaptHostForRuntime(baseUrl: string): string {
    if (existsSync('/.dockerenv')) return baseUrl;
    return baseUrl.replace(/host\.docker\.internal/gi, 'localhost');
}

export function readLoopProviderConfig(configPath: string, modelOverride?: string): ProviderConfig {
    const config = resolveLoopProviderConfigRaw(configPath, modelOverride);
    return { ...config, baseUrl: adaptHostForRuntime(config.baseUrl) };
}

function resolveLoopProviderConfigRaw(configPath: string, modelOverride?: string): ProviderConfig {
    const explicitBase = process.env.LOOP_PROVIDER_BASE_URL;
    const explicitKey = process.env.LOOP_PROVIDER_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const meshllmHost = process.env.MESHLLM_HOST;
    const mlxHost = process.env.MLX_HOST;
    const mlx14bHost = process.env.MLX_HOST_14B;

    // Priority for unoverridden defaults:
    // 1. LOOP_PROVIDER_BASE_URL explicitly set → use that
    // 2. MESHLLM_HOST is set → prefer local mesh over cloud free tiers
    // 3. MLX_HOST_14B / MLX_HOST → local Apple Silicon inference
    // 4. OPENROUTER_API_KEY → fall back to OpenRouter
    // 5. Local MeshLLM on default port
    const envApiKey = explicitKey || openrouterKey;
    let defaultBase: string;
    let defaultModel: string;
    let defaultKey: string | undefined;
    if (explicitBase) {
        defaultBase = explicitBase;
        defaultModel = process.env.LOOP_PROVIDER_MODEL || 'auto';
        defaultKey = envApiKey;
    } else if (meshllmHost) {
        defaultBase = `${meshllmHost.replace(/\/$/, '')}/v1`;
        defaultModel = process.env.LOOP_PROVIDER_MODEL || 'auto';
        defaultKey = explicitKey || undefined;
    } else if (mlx14bHost) {
        defaultBase = `${mlx14bHost.replace(/\/$/, '')}/v1`;
        defaultModel = process.env.LOOP_PROVIDER_MODEL || 'auto';
        defaultKey = undefined;
    } else if (mlxHost) {
        defaultBase = `${mlxHost.replace(/\/$/, '')}/v1`;
        defaultModel = process.env.LOOP_PROVIDER_MODEL || 'auto';
        defaultKey = undefined;
    } else if (openrouterKey) {
        defaultBase = 'https://openrouter.ai/api/v1';
        defaultModel = process.env.LOOP_PROVIDER_MODEL || 'deepseek/deepseek-v3.2';
        defaultKey = openrouterKey;
    } else {
        defaultBase = 'http://localhost:9337/v1';
        defaultModel = process.env.LOOP_PROVIDER_MODEL || 'auto';
        defaultKey = undefined;
    }

    const defaults: ProviderConfig = {
        baseUrl: defaultBase.replace(/\/$/, ''),
        model: modelOverride || defaultModel,
        apiKey: defaultKey };

    if (!existsSync(configPath)) return defaults;
    try {
        const cfg = parseJsonUtf8File(configPath) as Record<string, unknown>;
        const scheduler = cfg.scheduler as Record<string, unknown> | undefined;
        const lp = scheduler?.loopProvider as Record<string, unknown> | undefined;
        if (!lp) return defaults;
        const configApiKey = (lp.apiKey as string | undefined) || defaults.apiKey;
        const configBase = lp.baseUrl as string | undefined;
        const configModel = modelOverride || (lp.model as string | undefined);
        const isOrKey = !!(configApiKey?.startsWith('sk-or-'));
        const providerEnabled = readLoopProviderToggles(configPath);
        const resolved: ProviderConfig = {
            baseUrl: (configBase ?? (isOrKey && !meshllmHost ? 'https://openrouter.ai/api/v1' : defaults.baseUrl)).replace(/\/$/, ''),
            model: configModel ?? (isOrKey && !configBase && !meshllmHost ? 'deepseek/deepseek-v3.2' : defaults.model),
            apiKey: configApiKey,
            maxTokens: (lp.maxTokens as number | undefined),
            temperature: (lp.temperature as number | undefined) };
        const resolvedProvider = detectLoopProvider(resolved.baseUrl);
        if (resolvedProvider === 'meshllm' && providerEnabled.meshllm) return resolved;
        if (resolvedProvider === 'ollama' && providerEnabled.ollama) return resolved;
        if (resolvedProvider === 'openrouter' && providerEnabled.openrouter) return resolved;
        if (resolvedProvider === 'mlx' && providerEnabled.mlx) return resolved;
        if (resolvedProvider === 'custom') return resolved;

        if (providerEnabled.meshllm) {
            return { ...resolved, baseUrl: 'http://localhost:9337/v1', model: configModel ?? process.env.LOOP_PROVIDER_MODEL ?? 'auto', apiKey: undefined };
        }
        if (providerEnabled.mlx) {
            const mlxBase = mlx14bHost || mlxHost || 'http://localhost:8082';
            return { ...resolved, baseUrl: `${mlxBase.replace(/\/$/, '')}/v1`, model: configModel ?? process.env.LOOP_PROVIDER_MODEL ?? 'auto', apiKey: undefined };
        }
        if (providerEnabled.openrouter && configApiKey) {
            return { ...resolved, baseUrl: 'https://openrouter.ai/api/v1', model: configModel ?? process.env.LOOP_PROVIDER_MODEL ?? 'deepseek/deepseek-v3.2', apiKey: configApiKey };
        }
        if (providerEnabled.ollama) {
            return { ...resolved, baseUrl: `${(process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '')}/v1`, model: configModel ?? process.env.LOOP_PROVIDER_MODEL ?? 'sdlc-tuned:latest', apiKey: 'ollama' };
        }
        return resolved;
    } catch {
        return defaults;
    }
}
