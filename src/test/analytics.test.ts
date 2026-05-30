import { describe, expect, it } from 'vitest';
import { aggregateAiCost, cloudCost } from '../server/routes/analytics';
import type { TokenLedger } from '../server/ledger';

function ledger(entries: Array<{ agent: string; source: string; input: number; output: number }>): TokenLedger {
    return {
        'S-1': {
            storyName: 'Story 1',
            entries: entries.map(e => ({ ts: new Date().toISOString(), agent: e.agent, source: e.source as any, phase: 'development' as const, input: e.input, output: e.output })),
            totals: { input: 0, output: 0 },
        },
    };
}

describe('aggregateAiCost', () => {
    it('counts only cloud tokens toward spend; local providers are free', () => {
        const summary = aggregateAiCost(ledger([
            { agent: 'backend', source: 'cloud', input: 1_000_000, output: 1_000_000 },
            { agent: 'frontend', source: 'mlx', input: 5_000_000, output: 5_000_000 },
        ]), { budgetUsd: 100 });

        // 1M input @ $3 + 1M output @ $15 = $18
        expect(summary.spend).toBeCloseTo(18, 5);
        expect(summary.tokens.cloudInput).toBe(1_000_000);
        expect(summary.tokens.localInput).toBe(5_000_000);
    });

    it('computes utilization against the budget', () => {
        const summary = aggregateAiCost(ledger([
            { agent: 'backend', source: 'cloud', input: 1_000_000, output: 1_000_000 }, // $18
        ]), { budgetUsd: 36 });
        expect(summary.utilization).toBeCloseTo(0.5, 5);
        expect(summary.budget).toBe(36);
    });

    it('ranks byAgent by cloud cost, descending', () => {
        const summary = aggregateAiCost(ledger([
            { agent: 'frontend', source: 'cloud', input: 100_000, output: 0 },
            { agent: 'backend', source: 'cloud', input: 2_000_000, output: 0 },
            { agent: 'qa', source: 'ollama', input: 9_000_000, output: 0 },
        ]), { budgetUsd: 100 });

        expect(summary.byAgent[0].agent).toBe('backend');
        expect(summary.byAgent[0].cost).toBeGreaterThan(summary.byAgent[1].cost);
        // local-only agent contributes $0
        expect(summary.byAgent.find(a => a.agent === 'qa')?.cost).toBe(0);
    });

    it('never divides by zero — a non-positive budget floors at 1', () => {
        const summary = aggregateAiCost(ledger([]), { budgetUsd: 0 });
        expect(summary.budget).toBe(1);
        expect(summary.spend).toBe(0);
        expect(summary.utilization).toBe(0);
    });

    it('cloudCost matches the documented rates', () => {
        expect(cloudCost(1_000_000, 0)).toBeCloseTo(3, 6);
        expect(cloudCost(0, 1_000_000)).toBeCloseTo(15, 6);
    });
});
