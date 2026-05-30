import { readLoopProviderConfig, readLoopProviderToggles } from './agent-runner/provider';
import { existsSync } from 'fs';
import { parseJsonUtf8File } from './json-file';

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
 * The brain roles deserve the *largest* local model when running locally — the
 * worker agents stay on the 14B (the loop provider default), but the orchestrator
 * and reviewer escalate to the 32B when one is available. Resolution precedence:
 *   1. `BRAIN_MODEL_LOCAL` / `MLX_MODEL_32B` env (mirrors the existing MLX_MODEL_14B)
 *   2. `scheduler.loopProvider.brainModel` in the config
 *   3. the loop provider's own model (the 14B) as a safe fallback
 * The base URL is unchanged — one MLX server on :8083 serves both the 14B and 32B,
 * so only the `model` string differs.
 */
function resolveLocalBrainModel(configPath: string, fallback: string): string {
    const envModel = process.env.BRAIN_MODEL_LOCAL || process.env.MLX_MODEL_32B;
    if (envModel?.trim()) return envModel.trim();
    if (existsSync(configPath)) {
        try {
            const cfg = parseJsonUtf8File(configPath) as Record<string, unknown>;
            const scheduler = cfg.scheduler as Record<string, unknown> | undefined;
            const lp = scheduler?.loopProvider as Record<string, unknown> | undefined;
            const bm = lp?.brainModel as string | undefined;
            if (bm?.trim()) return bm.trim();
        } catch { /* fall through to the 14B */ }
    }
    return fallback;
}

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
    // → localhost when running natively and resolves the 14B baseUrl/model. Brain
    // roles escalate to the larger local model (32B) on the same server when one
    // is configured; workers keep the 14B.
    const local = readLoopProviderConfig(configPath);
    return {
        source: 'local',
        baseUrl: local.baseUrl.replace(/\/$/, ''),
        model: resolveLocalBrainModel(configPath, local.model),
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
