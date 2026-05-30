import React, { useEffect, useState } from 'react';
import { Gauge } from './components/Gauge';

interface AiCostSummary {
    currency: string;
    spend: number;
    budget: number;
    utilization: number;
    byAgent: Array<{ agent: string; cost: number }>;
    byProject: Array<{ project: string; cost: number }>;
    byTeam: Array<{ team: string; cost: number }>;
}

interface ProviderUsage {
    provider: string;
    configured: boolean;
    ok: boolean;
    spend: number | null;
    remaining: number | null;
    detail?: string;
}
interface ProviderReport {
    providers: ProviderUsage[];
    totalSpend: number;
    configuredCount: number;
}

function fmtUsd(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
    if (n === 0) return '$0';
    if (n < 0.01) return '<$0.01';
    return `$${n.toFixed(2)}`;
}

const PROVIDER_LABEL: Record<string, string> = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI' };

function Kpi({ label, value, accent }: { label: string; value: string; accent?: string }) {
    return (
        <div style={{ background: 'var(--card-bg, #fff)', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 18px', minWidth: 140 }}>
            <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: accent ?? '#0f172a' }}>{value}</div>
        </div>
    );
}

function Breakdown({ title, rows, testid }: { title: string; rows: Array<{ label: string; cost: number }>; testid: string }) {
    const max = Math.max(1, ...rows.map(r => r.cost));
    return (
        <section data-testid={testid} style={{ flex: 1, minWidth: 220 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 10px' }}>{title}</h3>
            {rows.length === 0 && <div style={{ fontSize: 13, color: '#94a3b8' }}>No spend yet</div>}
            {rows.slice(0, 6).map((r) => (
                <div key={r.label} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 2 }}>
                        <span style={{ color: '#334155' }}>{r.label}</span>
                        <strong>{fmtUsd(r.cost)}</strong>
                    </div>
                    <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3 }}>
                        <div style={{ height: 6, width: `${(r.cost / max) * 100}%`, background: '#14b8a6', borderRadius: 3 }} />
                    </div>
                </div>
            ))}
        </section>
    );
}

/**
 * Executive AI cost & usage view. Combines both data planes:
 *  - attribution (the framework's own agent spend, sliced by repo/team/agent)
 *  - authoritative spend (org-level totals from vendor billing connectors).
 */
export function ExecDashboard({ onBack }: { onBack: () => void }) {
    const [cost, setCost] = useState<AiCostSummary | null>(null);
    const [providers, setProviders] = useState<ProviderReport | null>(null);
    const [err, setErr] = useState(false);

    useEffect(() => {
        let alive = true;
        const load = () => Promise.all([
            fetch('/api/analytics/ai-cost').then(r => r.ok ? r.json() : Promise.reject()),
            fetch('/api/analytics/providers').then(r => r.ok ? r.json() : null),
        ]).then(([c, p]) => { if (alive) { setCost(c); setProviders(p); setErr(false); } })
            .catch(() => { if (alive) setErr(true); });
        load();
        const t = setInterval(load, 30_000);
        return () => { alive = false; clearInterval(t); };
    }, []);

    return (
        <div style={{ padding: '24px 28px', maxWidth: 1100, margin: '0 auto' }} data-testid="exec-dashboard">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                <button onClick={onBack} data-testid="exec-back-btn" style={{ border: '1px solid #cbd5e1', borderRadius: 8, padding: '6px 12px', background: 'transparent', cursor: 'pointer' }}>← Floor</button>
                <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>AI Cost &amp; Usage</h1>
            </div>

            {err && !cost && <div style={{ color: '#94a3b8' }}>Analytics unavailable.</div>}

            {cost && (
                <>
                    {/* Hero: gauge + KPIs */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 28, flexWrap: 'wrap', marginBottom: 28 }}>
                        <Gauge value={cost.spend} max={cost.budget} valueLabel={fmtUsd(cost.spend)} label={`of ${fmtUsd(cost.budget)} budget`} size={200} />
                        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                            <Kpi label="Agent spend" value={fmtUsd(cost.spend)} />
                            <Kpi label="Budget used" value={`${Math.round(cost.utilization * 100)}%`} accent={cost.spend > cost.budget ? '#ef4444' : undefined} />
                            <Kpi label="Vendor spend" value={fmtUsd(providers?.totalSpend)} accent="#14b8a6" />
                            <Kpi label="Providers" value={`${providers?.configuredCount ?? 0}/3`} />
                        </div>
                    </div>

                    {/* Provider cards (authoritative spend plane) */}
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>Provider spend (org-wide)</h2>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 28 }} data-testid="exec-providers">
                        {(providers?.providers ?? []).map((p) => (
                            <div key={p.provider} style={{ flex: 1, minWidth: 200, border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, opacity: p.configured ? 1 : 0.55 }}>
                                <div style={{ fontWeight: 700, marginBottom: 4 }}>{PROVIDER_LABEL[p.provider] ?? p.provider}</div>
                                <div style={{ fontSize: 24, fontWeight: 700 }}>{p.ok ? fmtUsd(p.spend) : '—'}</div>
                                <div style={{ fontSize: 12, color: p.ok ? '#64748b' : '#94a3b8' }}>
                                    {p.ok
                                        ? (p.remaining !== null ? `${fmtUsd(p.remaining)} credit left` : 'spend to date')
                                        : (p.configured ? (p.detail ?? 'unavailable') : 'not configured')}
                                </div>
                            </div>
                        ))}
                        {!providers && <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading providers…</div>}
                    </div>

                    {/* Attribution plane breakdowns */}
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>Where the agent spend went</h2>
                    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                        <Breakdown title="By repo" testid="exec-by-repo" rows={cost.byProject.map(p => ({ label: p.project, cost: p.cost }))} />
                        <Breakdown title="By team" testid="exec-by-team" rows={cost.byTeam.map(t => ({ label: t.team, cost: t.cost }))} />
                        <Breakdown title="By agent" testid="exec-by-agent" rows={cost.byAgent.map(a => ({ label: a.agent, cost: a.cost }))} />
                    </div>
                </>
            )}
        </div>
    );
}

export default ExecDashboard;
