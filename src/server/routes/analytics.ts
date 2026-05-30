import { json } from '../router';
import { getLedger } from '../ledger';
import type { TokenLedger } from '../ledger';
import { fetchAllProviderUsage } from '../providerUsage';
import type { UseFn } from './types';

// Cloud pricing ($/1M tokens). Mirrors AgentCostBreakdown.tsx — only `cloud`
// source costs money; local providers (mlx/ollama/meshllm) are free.
const CLOUD_INPUT_RATE = 3.00;
const CLOUD_OUTPUT_RATE = 15.00;

export function cloudCost(input: number, output: number): number {
    return (input * CLOUD_INPUT_RATE + output * CLOUD_OUTPUT_RATE) / 1_000_000;
}

export interface AiCostSummary {
    currency: 'USD';
    period: string;
    project: string | null;   // the project this summary is scoped to, or null for all repos
    team: string | null;      // the team this summary is scoped to, or null for all teams
    spend: number;            // total cloud spend in USD
    budget: number;           // budget ceiling for the gauge max
    utilization: number;      // spend / budget (0..1+), clamped at >=0
    tokens: { cloudInput: number; cloudOutput: number; localInput: number; localOutput: number };
    byAgent: Array<{ agent: string; cost: number; cloudInput: number; cloudOutput: number }>;
    byProject: Array<{ project: string; cost: number }>; // per-repo breakdown (each repo's card)
    byTeam: Array<{ team: string; cost: number }>;       // per-team breakdown (filterable)
}

/**
 * Pure aggregation of the token ledger into an AI-cost summary. Kept separate
 * from the route so it is trivially unit-testable and so the *gauge* never
 * computes anything — it just renders `spend` against `budget`. At a larger
 * org this is the seam where you'd swap the source (rollup table / vendor
 * billing API) without touching the gauge.
 */
export function aggregateAiCost(ledger: TokenLedger, opts: { budgetUsd: number; project?: string | null; team?: string | null }): AiCostSummary {
    const filterProject = opts.project ?? null;
    const filterTeam = opts.team ?? null;
    let cloudInput = 0, cloudOutput = 0, localInput = 0, localOutput = 0;
    const perAgent = new Map<string, { cloudInput: number; cloudOutput: number }>();
    const perProject = new Map<string, { cloudInput: number; cloudOutput: number }>();
    const perTeam = new Map<string, { cloudInput: number; cloudOutput: number }>();

    for (const record of Object.values(ledger)) {
        for (const e of record.entries) {
            // When scoped, skip entries that belong to other repos/teams.
            if (filterProject !== null && (e.project ?? null) !== filterProject) continue;
            if (filterTeam !== null && (e.team ?? null) !== filterTeam) continue;

            const isCloud = e.source === 'cloud';
            if (isCloud) { cloudInput += e.input; cloudOutput += e.output; }
            else { localInput += e.input; localOutput += e.output; }

            const agg = perAgent.get(e.agent) ?? { cloudInput: 0, cloudOutput: 0 };
            if (isCloud) { agg.cloudInput += e.input; agg.cloudOutput += e.output; }
            perAgent.set(e.agent, agg);

            // Per-repo breakdown (entries without a project roll up under "unattributed").
            const projKey = e.project ?? 'unattributed';
            const pagg = perProject.get(projKey) ?? { cloudInput: 0, cloudOutput: 0 };
            if (isCloud) { pagg.cloudInput += e.input; pagg.cloudOutput += e.output; }
            perProject.set(projKey, pagg);

            // Per-team breakdown (entries without a team roll up under "unassigned").
            const teamKey = e.team ?? 'unassigned';
            const tagg = perTeam.get(teamKey) ?? { cloudInput: 0, cloudOutput: 0 };
            if (isCloud) { tagg.cloudInput += e.input; tagg.cloudOutput += e.output; }
            perTeam.set(teamKey, tagg);
        }
    }

    const spend = cloudCost(cloudInput, cloudOutput);
    const budget = opts.budgetUsd > 0 ? opts.budgetUsd : 1;
    const byAgent = [...perAgent.entries()]
        .map(([agent, t]) => ({ agent, cost: cloudCost(t.cloudInput, t.cloudOutput), cloudInput: t.cloudInput, cloudOutput: t.cloudOutput }))
        .sort((a, b) => b.cost - a.cost);
    const byProject = [...perProject.entries()]
        .map(([project, t]) => ({ project, cost: cloudCost(t.cloudInput, t.cloudOutput) }))
        .sort((a, b) => b.cost - a.cost);
    const byTeam = [...perTeam.entries()]
        .map(([team, t]) => ({ team, cost: cloudCost(t.cloudInput, t.cloudOutput) }))
        .sort((a, b) => b.cost - a.cost);

    return {
        currency: 'USD',
        period: 'all-time',
        project: filterProject,
        team: filterTeam,
        spend,
        budget,
        utilization: Math.max(0, spend / budget),
        tokens: { cloudInput, cloudOutput, localInput, localOutput },
        byAgent,
        byProject,
        byTeam,
    };
}

function resolveBudget(): number {
    const raw = Number(process.env.AI_BUDGET_USD);
    return Number.isFinite(raw) && raw > 0 ? raw : 100;
}

export function mount(use: UseFn, rootDir: string, _configFile: string): void {
    // ── /api/analytics/ai-cost ───────────────────────────────────────────────
    // Server-side aggregation so the dashboard gauge is a dumb consumer of a
    // pre-computed number — keeps it scale-ready (swap the source here, not in the UI).
    use('/api/analytics/ai-cost', (req, res) => {
        try {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            const project = url.searchParams.get('project'); // omit → all repos
            const team = url.searchParams.get('team');       // omit → all teams
            const summary = aggregateAiCost(getLedger(rootDir), { budgetUsd: resolveBudget(), project, team });
            json(res, summary);
        } catch (e: unknown) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── /api/analytics/providers ─────────────────────────────────────────────
    // Authoritative, cross-machine spend pulled from vendor billing APIs
    // (OpenRouter, Anthropic, OpenAI). Complements the ledger plane above, which
    // only sees this install's agent usage.
    use('/api/analytics/providers', async (_req, res) => {
        try {
            json(res, await fetchAllProviderUsage());
        } catch (e: unknown) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });
}
