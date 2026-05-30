import { afterEach, describe, expect, it } from 'vitest';
import {
    parseOpenRouterCredits,
    sumOpenAiCosts,
    sumAnthropicCosts,
    openrouterConnector,
    fetchAllProviderUsage,
} from '../server/providerUsage';

const ENV_KEYS = ['OPENROUTER_API_KEY', 'OPENAI_ADMIN_KEY', 'ANTHROPIC_ADMIN_KEY'] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe('provider usage parsers', () => {
    it('parses OpenRouter credits into spend + remaining', () => {
        expect(parseOpenRouterCredits({ data: { total_credits: 50, total_usage: 12.5 } }))
            .toEqual({ spend: 12.5, remaining: 37.5 });
    });

    it('returns null for malformed OpenRouter payloads', () => {
        expect(parseOpenRouterCredits({})).toBeNull();
        expect(parseOpenRouterCredits({ data: {} })).toBeNull();
    });

    it('sums OpenAI cost buckets', () => {
        const payload = { data: [
            { results: [{ amount: { value: 0.12 } }, { amount: { value: 0.03 } }] },
            { results: [{ amount: { value: 1.5 } }] },
        ] };
        expect(sumOpenAiCosts(payload)).toBeCloseTo(1.65, 5);
    });

    it('sums Anthropic cost buckets (string or number amounts)', () => {
        const payload = { data: [
            { results: [{ amount: '1.23' }, { amount: 0.77 }] },
            { results: [{ amount: 'not-a-number' }] },
        ] };
        expect(sumAnthropicCosts(payload)).toBeCloseTo(2.0, 5);
    });

    it('returns null when the cost payload shape is wrong', () => {
        expect(sumOpenAiCosts({})).toBeNull();
        expect(sumAnthropicCosts({ data: 'nope' })).toBeNull();
    });
});

describe('connector configuration + graceful degradation', () => {
    it('reports unconfigured when the key is absent (no network call)', async () => {
        delete process.env.OPENROUTER_API_KEY;
        const fetchSpy = (() => { throw new Error('should not be called'); }) as unknown as typeof fetch;
        const usage = await openrouterConnector.fetchUsage(fetchSpy);
        expect(usage).toMatchObject({ provider: 'openrouter', configured: false, ok: false });
    });

    it('fetchAllProviderUsage never throws and sums only ok providers', async () => {
        process.env.OPENROUTER_API_KEY = 'sk-or-test';
        delete process.env.OPENAI_ADMIN_KEY;
        delete process.env.ANTHROPIC_ADMIN_KEY;
        const fakeFetch = (async () => ({
            ok: true,
            json: async () => ({ data: { total_credits: 20, total_usage: 5 } }),
        })) as unknown as typeof fetch;

        const report = await fetchAllProviderUsage(fakeFetch);
        expect(report.totalSpend).toBeCloseTo(5, 5);          // only OpenRouter configured
        expect(report.configuredCount).toBe(1);
        expect(report.providers).toHaveLength(3);             // all three reported
        expect(report.providers.find(p => p.provider === 'openai')?.configured).toBe(false);
    });
});
