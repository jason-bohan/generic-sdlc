/**
 * Provider billing connectors — the "authoritative spend" plane.
 *
 * The token ledger (see routes/analytics.ts) attributes the *framework's own*
 * agent spend per repo/team. This module instead pulls **org-level spend from the
 * vendors' billing/usage APIs**, which is the only way to see AI spend across all
 * machines and human users — not just this install's agents.
 *
 * Each connector normalizes to {@link ProviderUsage}. Parsing is split into pure
 * functions so it can be unit-tested without network access; `fetch` is injectable
 * for the same reason. Connectors degrade gracefully: unconfigured or failing
 * providers return `ok: false` rather than throwing, so one bad key never breaks
 * the combined view.
 */

export type ProviderId = 'openrouter' | 'anthropic' | 'openai';

export interface ProviderUsage {
    provider: ProviderId;
    configured: boolean;       // is the relevant key present?
    ok: boolean;               // did we successfully read spend?
    currency: string;
    spend: number | null;      // total spend in `currency`, or null if unavailable
    remaining: number | null;  // remaining prepaid credit, if the provider exposes it
    detail?: string;           // error/info for the UI
}

type FetchFn = typeof fetch;

export interface ProviderConnector {
    provider: ProviderId;
    isConfigured(): boolean;
    fetchUsage(fetchImpl: FetchFn, signal?: AbortSignal): Promise<ProviderUsage>;
}

function unconfigured(provider: ProviderId): ProviderUsage {
    return { provider, configured: false, ok: false, currency: 'USD', spend: null, remaining: null, detail: 'No API key configured' };
}

function failed(provider: ProviderId, detail: string): ProviderUsage {
    return { provider, configured: true, ok: false, currency: 'USD', spend: null, remaining: null, detail };
}

// ── OpenRouter ───────────────────────────────────────────────────────────────
// GET /api/v1/credits → { data: { total_credits, total_usage } }. total_usage is
// cumulative $ spent; remaining = credits - usage. This is the confident path —
// the framework already uses OPENROUTER_API_KEY.

export function parseOpenRouterCredits(json: unknown): { spend: number; remaining: number } | null {
    const data = (json as { data?: { total_credits?: number; total_usage?: number } })?.data;
    if (!data || typeof data.total_usage !== 'number') return null;
    const spend = data.total_usage;
    const remaining = typeof data.total_credits === 'number' ? data.total_credits - spend : 0;
    return { spend, remaining };
}

export const openrouterConnector: ProviderConnector = {
    provider: 'openrouter',
    isConfigured: () => !!process.env.OPENROUTER_API_KEY,
    async fetchUsage(fetchImpl, signal) {
        if (!this.isConfigured()) return unconfigured('openrouter');
        try {
            const res = await fetchImpl('https://openrouter.ai/api/v1/credits', {
                headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
                signal,
            });
            if (!res.ok) return failed('openrouter', `HTTP ${res.status}`);
            const parsed = parseOpenRouterCredits(await res.json());
            if (!parsed) return failed('openrouter', 'Unexpected response shape');
            return { provider: 'openrouter', configured: true, ok: true, currency: 'USD', spend: parsed.spend, remaining: parsed.remaining };
        } catch (e) {
            return failed('openrouter', e instanceof Error ? e.message : String(e));
        }
    },
};

// ── OpenAI ───────────────────────────────────────────────────────────────────
// GET /v1/organization/costs → pages of buckets, each with results[].amount.value.
// Needs an *admin* key (sk-admin…), distinct from an inference key.

export function sumOpenAiCosts(json: unknown): number | null {
    const data = (json as { data?: Array<{ results?: Array<{ amount?: { value?: number } }> }> })?.data;
    if (!Array.isArray(data)) return null;
    let total = 0;
    for (const bucket of data) {
        for (const r of bucket.results ?? []) {
            if (typeof r.amount?.value === 'number') total += r.amount.value;
        }
    }
    return total;
}

export const openaiConnector: ProviderConnector = {
    provider: 'openai',
    isConfigured: () => !!process.env.OPENAI_ADMIN_KEY,
    async fetchUsage(fetchImpl, signal) {
        if (!this.isConfigured()) return unconfigured('openai');
        try {
            // Costs since the start of the current UTC day.
            const startOfDay = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
            const res = await fetchImpl(`https://api.openai.com/v1/organization/costs?start_time=${startOfDay}`, {
                headers: { Authorization: `Bearer ${process.env.OPENAI_ADMIN_KEY}` },
                signal,
            });
            if (!res.ok) return failed('openai', `HTTP ${res.status}`);
            const spend = sumOpenAiCosts(await res.json());
            if (spend === null) return failed('openai', 'Unexpected response shape');
            return { provider: 'openai', configured: true, ok: true, currency: 'USD', spend, remaining: null };
        } catch (e) {
            return failed('openai', e instanceof Error ? e.message : String(e));
        }
    },
};

// ── Anthropic ────────────────────────────────────────────────────────────────
// GET /v1/organizations/cost_report → time buckets with results[].amount (string
// or number). Needs an *admin* key (sk-ant-admin…) and the anthropic-version header.

export function sumAnthropicCosts(json: unknown): number | null {
    const data = (json as { data?: Array<{ results?: Array<{ amount?: number | string }> }> })?.data;
    if (!Array.isArray(data)) return null;
    let total = 0;
    for (const bucket of data) {
        for (const r of bucket.results ?? []) {
            const v = typeof r.amount === 'string' ? Number(r.amount) : r.amount;
            if (typeof v === 'number' && Number.isFinite(v)) total += v;
        }
    }
    return total;
}

export const anthropicConnector: ProviderConnector = {
    provider: 'anthropic',
    isConfigured: () => !!process.env.ANTHROPIC_ADMIN_KEY,
    async fetchUsage(fetchImpl, signal) {
        if (!this.isConfigured()) return unconfigured('anthropic');
        try {
            const startOfDay = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
            const res = await fetchImpl(`https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(startOfDay)}`, {
                headers: {
                    'x-api-key': process.env.ANTHROPIC_ADMIN_KEY as string,
                    'anthropic-version': '2023-06-01',
                },
                signal,
            });
            if (!res.ok) return failed('anthropic', `HTTP ${res.status}`);
            const spend = sumAnthropicCosts(await res.json());
            if (spend === null) return failed('anthropic', 'Unexpected response shape');
            return { provider: 'anthropic', configured: true, ok: true, currency: 'USD', spend, remaining: null };
        } catch (e) {
            return failed('anthropic', e instanceof Error ? e.message : String(e));
        }
    },
};

export const PROVIDER_CONNECTORS: ProviderConnector[] = [openrouterConnector, anthropicConnector, openaiConnector];

export interface ProviderUsageReport {
    providers: ProviderUsage[];
    totalSpend: number;          // sum of `ok` providers' spend
    configuredCount: number;
}

/** Query every connector in parallel; degrade gracefully on any failure. */
export async function fetchAllProviderUsage(fetchImpl: FetchFn = fetch, timeoutMs = 8000): Promise<ProviderUsageReport> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const providers = await Promise.all(
            PROVIDER_CONNECTORS.map(c => c.fetchUsage(fetchImpl, controller.signal).catch(e =>
                failed(c.provider, e instanceof Error ? e.message : String(e)))),
        );
        return {
            providers,
            totalSpend: providers.reduce((sum, p) => sum + (p.ok && p.spend ? p.spend : 0), 0),
            configuredCount: providers.filter(p => p.configured).length,
        };
    } finally {
        clearTimeout(timer);
    }
}
