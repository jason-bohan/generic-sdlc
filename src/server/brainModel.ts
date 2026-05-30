import { readLoopProviderConfig, readLoopProviderToggles } from './agent-runner/provider';

/**
 * Model selection for the "smartest in the room" roles — the orchestrator
 * (story triage / routing) and the reviewer. These two roles gate everything
 * downstream, so they get the best brain available: **cloud first, local
 * second**. Worker agents stay on the local model; only the brain roles escalate.
 */
export interface SmartModel {
    source: 'cloud' | 'local';
    baseUrl: string; // includes the /v1 suffix
    model: string;
    apiKey?: string;
}

// OpenRouter id used when a cloud key is present but no explicit BRAIN_MODEL is set.
const DEFAULT_CLOUD_MODEL = 'deepseek/deepseek-v3.2';

/**
 * Resolve the brain model: prefer a configured cloud provider (OpenRouter) when a
 * key is present and cloud is enabled; otherwise fall back to the local loop
 * provider (the MLX 14B), reusing the existing host-adaptation logic.
 */
export function resolveSmartModel(configPath: string): SmartModel {
    const orKey = process.env.OPENROUTER_API_KEY;
    const toggles = readLoopProviderToggles(configPath);
    if (orKey && toggles.openrouter) {
        return {
            source: 'cloud',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: process.env.BRAIN_MODEL || DEFAULT_CLOUD_MODEL,
            apiKey: orKey,
        };
    }
    // Local fallback — readLoopProviderConfig already adapts host.docker.internal
    // → localhost when running natively and resolves the 14B baseUrl/model.
    const local = readLoopProviderConfig(configPath);
    return {
        source: 'local',
        baseUrl: local.baseUrl.replace(/\/$/, ''),
        model: local.model,
        apiKey: local.apiKey,
    };
}

/**
 * Minimal OpenAI-compatible chat completion against the resolved brain model.
 * Used for short, structured calls (e.g. story triage). Returns '' on any error
 * so callers can fall back deterministically.
 */
export async function smartChat(
    prompt: string,
    configPath: string,
    opts?: { maxTokens?: number; timeoutMs?: number },
): Promise<string> {
    const m = resolveSmartModel(configPath);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30_000);
    try {
        const res = await fetch(`${m.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(m.apiKey ? { Authorization: `Bearer ${m.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: m.model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: opts?.maxTokens ?? 16,
                temperature: 0,
            }),
            signal: controller.signal,
        });
        if (!res.ok) return '';
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content ?? '';
    } catch {
        return '';
    } finally {
        clearTimeout(timer);
    }
}
