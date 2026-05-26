import React from 'react';
import type { AgentStatus } from '../types';

// Claude Sonnet pricing ($/1M tokens) — adjust to match whichever model you demo with
const CLOUD_INPUT_RATE  = 3.00;   // $3.00 / 1M input tokens
const CLOUD_OUTPUT_RATE = 15.00;  // $15.00 / 1M output tokens

function cloudCost(input: number, output: number): number {
    return (input * CLOUD_INPUT_RATE + output * CLOUD_OUTPUT_RATE) / 1_000_000;
}

function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

function fmtCost(n: number): string {
    if (n === 0) return '$0.00';
    if (n < 0.01) return '<$0.01';
    return `$${n.toFixed(2)}`;
}

interface AgentRow {
    id: string;
    label: string;
    localInput:  number;
    localOutput: number;
    cloudInput:  number;
    cloudOutput: number;
}

interface Props {
    agentStatuses: Record<string, AgentStatus | null>;
    displayNames: Record<string, string>;
}

export function AgentCostBreakdown({ agentStatuses, displayNames }: Props) {
    const rows: AgentRow[] = Object.entries(agentStatuses)
        .filter(([, s]) => s !== null)
        .map(([id, s]) => {
            const t = s!.tokens ?? {};
            return {
                id,
                label: displayNames[id] || id,
                localInput:  (t.meshllm?.input ?? 0) + (t.ollama?.input ?? 0),
                localOutput: (t.meshllm?.output ?? 0) + (t.ollama?.output ?? 0),
                cloudInput:  t.cloud?.input  ?? 0,
                cloudOutput: t.cloud?.output ?? 0,
            };
        })
        .filter(r => r.localInput + r.localOutput + r.cloudInput + r.cloudOutput > 0)
        .sort((a, b) => (b.cloudInput + b.cloudOutput) - (a.cloudInput + a.cloudOutput));

    if (rows.length === 0) {
        return <div style={s.empty}>No token activity yet.</div>;
    }

    const totals = rows.reduce(
        (acc, r) => ({
            localIn:  acc.localIn  + r.localInput,
            localOut: acc.localOut + r.localOutput,
            cloudIn:  acc.cloudIn  + r.cloudInput,
            cloudOut: acc.cloudOut + r.cloudOutput,
        }),
        { localIn: 0, localOut: 0, cloudIn: 0, cloudOut: 0 },
    );

    const totalLocal     = totals.localIn + totals.localOut;
    const totalCloud     = totals.cloudIn + totals.cloudOut;
    const actualCost     = cloudCost(totals.cloudIn, totals.cloudOut);
    const ifAllCloudCost = cloudCost(totals.localIn + totals.cloudIn, totals.localOut + totals.cloudOut);
    const savedCost      = ifAllCloudCost - actualCost;

    return (
        <div style={s.container}>
            <div style={s.title}>Per-Agent Token Cost</div>
            <table style={s.table}>
                <thead>
                    <tr>
                        <th style={s.th}>Agent</th>
                        <th style={{ ...s.th, ...s.right }}>Local</th>
                        <th style={{ ...s.th, ...s.right }}>Cloud</th>
                        <th style={{ ...s.th, ...s.right }}>Cost</th>
                        <th style={{ ...s.th, ...s.right }}>Saved</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(r => {
                        const local       = r.localInput + r.localOutput;
                        const cloud       = r.cloudInput + r.cloudOutput;
                        const cost        = cloudCost(r.cloudInput, r.cloudOutput);
                        const ifAllCloud  = cloudCost(r.localInput + r.cloudInput, r.localOutput + r.cloudOutput);
                        const saved       = ifAllCloud - cost;
                        return (
                            <tr key={r.id}>
                                <td style={s.td}>{r.label}</td>
                                <td style={{ ...s.td, ...s.right, color: '#10B981' }}>{local > 0 ? fmt(local) : '—'}</td>
                                <td style={{ ...s.td, ...s.right, color: cloud > 0 ? '#F59E0B' : '#555' }}>{cloud > 0 ? fmt(cloud) : '—'}</td>
                                <td style={{ ...s.td, ...s.right, color: cost > 0 ? '#F59E0B' : '#555' }}>{fmtCost(cost)}</td>
                                <td style={{ ...s.td, ...s.right, color: '#22C55E' }}>{saved > 0.005 ? fmtCost(saved) : '—'}</td>
                            </tr>
                        );
                    })}
                </tbody>
                <tfoot>
                    <tr>
                        <td style={{ ...s.td, ...s.foot }}>Total</td>
                        <td style={{ ...s.td, ...s.right, ...s.foot, color: '#10B981' }}>{fmt(totalLocal)}</td>
                        <td style={{ ...s.td, ...s.right, ...s.foot, color: totalCloud > 0 ? '#F59E0B' : '#555' }}>{totalCloud > 0 ? fmt(totalCloud) : '—'}</td>
                        <td style={{ ...s.td, ...s.right, ...s.foot, color: actualCost > 0 ? '#F59E0B' : '#555' }}>{fmtCost(actualCost)}</td>
                        <td style={{ ...s.td, ...s.right, ...s.foot, color: '#22C55E' }}>{savedCost > 0.005 ? fmtCost(savedCost) : '—'}</td>
                    </tr>
                </tfoot>
            </table>
            <div style={s.summary}>
                <span style={s.summaryItem}>
                    <span style={{ color: '#888' }}>If all cloud: </span>
                    <span style={{ color: '#F59E0B' }}>{fmtCost(ifAllCloudCost)}</span>
                </span>
                <span style={s.separator}>·</span>
                <span style={s.summaryItem}>
                    <span style={{ color: '#888' }}>Actual: </span>
                    <span style={{ color: '#F59E0B' }}>{fmtCost(actualCost)}</span>
                </span>
                <span style={s.separator}>·</span>
                <span style={s.summaryItem}>
                    <span style={{ color: '#888' }}>Saved: </span>
                    <span style={{ color: '#22C55E', fontWeight: 700 }}>{fmtCost(savedCost)}</span>
                </span>
            </div>
            <div style={s.rateNote}>Rates: ${CLOUD_INPUT_RATE}/1M in · ${CLOUD_OUTPUT_RATE}/1M out (Claude Sonnet)</div>
        </div>
    );
}

const s: Record<string, React.CSSProperties> = {
    container: {
        position: 'absolute',
        top: '100%',
        left: 0,
        zIndex: 1000,
        marginTop: 6,
        background: '#1a1a2e',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8,
        padding: '12px 14px',
        minWidth: 380,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    },
    title: {
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: '#666',
        marginBottom: 10,
    },
    table: {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 11,
    },
    th: {
        fontSize: 9,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: '#555',
        paddingBottom: 6,
        borderBottom: '1px solid rgba(255,255,255,0.07)',
    },
    right: { textAlign: 'right' },
    td: {
        padding: '4px 0',
        color: '#ccc',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
    },
    foot: {
        fontWeight: 600,
        borderTop: '1px solid rgba(255,255,255,0.1)',
        borderBottom: 'none',
        paddingTop: 6,
        color: '#aaa',
    },
    summary: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginTop: 10,
        fontSize: 11,
    },
    summaryItem: { display: 'inline-flex', gap: 3 },
    separator: { color: '#444' },
    rateNote: {
        fontSize: 9,
        color: '#444',
        marginTop: 6,
    },
    empty: {
        fontSize: 11,
        color: '#555',
        padding: '8px 0',
    },
};
