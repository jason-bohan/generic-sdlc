import React, { useEffect, useState } from 'react';
import { Gauge } from './Gauge';

interface AiCostSummary {
    currency: string;
    project: string | null;
    team: string | null;
    spend: number;
    budget: number;
    utilization: number;
    byAgent: Array<{ agent: string; cost: number }>;
    byProject: Array<{ project: string; cost: number }>;
    byTeam: Array<{ team: string; cost: number }>;
}

function fmtUsd(n: number): string {
    if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
    if (n === 0) return '$0';
    if (n < 0.01) return '<$0.01';
    return `$${n.toFixed(2)}`;
}

/**
 * AI Quality Engineer desk panel: a speedometer of total cloud AI spend vs budget.
 * Reads the server-aggregated /api/analytics/ai-cost — it computes nothing itself,
 * so the same component works whether the source is local token math or a billing rollup.
 */
export function AiCostGaugePanel({ accentColor }: { accentColor: string }) {
    const [data, setData] = useState<AiCostSummary | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let alive = true;
        // Scope the gauge to the active project so it reflects that repo's spend.
        const load = () => fetch('/api/active-project')
            .then(r => r.ok ? r.json() : null)
            .then((p: { active?: string } | null) => {
                const q = p?.active ? `?project=${encodeURIComponent(p.active)}` : '';
                return fetch(`/api/analytics/ai-cost${q}`);
            })
            .then(r => r && r.ok ? r.json() : Promise.reject())
            .then((d: AiCostSummary) => { if (alive) { setData(d); setError(false); } })
            .catch(() => { if (alive) setError(true); });
        load();
        const t = setInterval(load, 30_000);
        return () => { alive = false; clearInterval(t); };
    }, []);

    const topDriver = data?.byAgent?.[0];

    return (
        <section
            data-testid="aiqa-cost-gauge-panel"
            style={{
                border: `1px solid ${accentColor}40`,
                borderRadius: 12,
                padding: '16px 18px',
                margin: '12px 0',
                background: `${accentColor}0d`,
                display: 'flex',
                alignItems: 'center',
                gap: 20,
                flexWrap: 'wrap',
            }}
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: accentColor, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    AI Spend vs Budget
                </span>
                <span style={{ fontSize: 12, color: '#64748b' }}>
                    {data?.project ? `${data.project} · cloud token cost` : 'Cloud token cost, all stories'}
                </span>
            </div>

            {error && <span style={{ fontSize: 13, color: '#94a3b8' }}>cost data unavailable</span>}

            {!error && data && (
                <>
                    <Gauge
                        value={data.spend}
                        max={data.budget}
                        valueLabel={fmtUsd(data.spend)}
                        label={`of ${fmtUsd(data.budget)} budget`}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#475569' }}>
                        <div><strong style={{ fontSize: 18, color: data.spend > data.budget ? '#ef4444' : '#0f172a' }}>{Math.round(data.utilization * 100)}%</strong> of budget used</div>
                        {topDriver && topDriver.cost > 0 && (
                            <div>Top driver: <strong>{topDriver.agent}</strong> ({fmtUsd(topDriver.cost)})</div>
                        )}
                    </div>
                </>
            )}
        </section>
    );
}
