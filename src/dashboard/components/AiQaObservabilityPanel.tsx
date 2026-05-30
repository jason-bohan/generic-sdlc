import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { TelemetrySnapshot, ServiceNode, ErrorEvent, Anomaly } from '../../shared/telemetry';
import { useDemoMode } from '../DemoModeProvider';

const DD_RED = '#CC0000';
const DD_DARK = '#1C1C1E';
const DD_CARD = '#2C2C2E';
const DD_BORDER = '#3A3A3C';
const DD_TEXT = '#F2F2F7';
const DD_MUTED = '#8E8E93';
const DD_GREEN = '#30D158';
const DD_ORANGE = '#FF9F0A';
const DD_BLUE = '#0A84FF';

function fmt(n: number): string {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
}

function fmtLatency(ms: number): string {
    if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
    return Math.round(ms) + 'ms';
}

function svcColor(type: string): string {
    switch (type) {
        case 'api': return DD_BLUE;
        case 'db': return DD_GREEN;
        case 'cache': return DD_ORANGE;
        case 'external': return DD_RED;
        default: return DD_MUTED;
    }
}

function Sparkline({ values, color, height = 24 }: { values: number[]; color: string; height?: number }) {
    if (values.length < 2) return null;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = max - min || 1;
    const w = 60;
    const h = height;
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * (h - 4) - 2}`).join(' ');
    return (
        <svg width={w} height={h} style={{ flexShrink: 0 }}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function ServiceCard({ svc }: { svc: ServiceNode }) {
    const color = svcColor(svc.type);
    const hasError = svc.metrics.errorRate > 0.02;
    const latencyColor = svc.metrics.p99Latency > 3000 ? DD_RED : svc.metrics.p95Latency > 2000 ? DD_ORANGE : DD_GREEN;

    return (
        <div style={{ ...cardStyle, borderLeft: `3px solid ${color}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: DD_TEXT }}>{svc.name}</span>
                <span style={{ fontSize: 10, color: DD_MUTED, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>{svc.type}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 6 }}>
                <div>
                    <div style={{ fontSize: 9, color: DD_MUTED, fontFamily: 'var(--font-mono)' }}>RPS</div>
                    <div style={{ fontSize: 15, fontWeight: 750, color: DD_TEXT }}>{fmt(svc.metrics.requestRate)}</div>
                </div>
                <div>
                    <div style={{ fontSize: 9, color: DD_MUTED, fontFamily: 'var(--font-mono)' }}>Errors</div>
                    <div style={{ fontSize: 15, fontWeight: 750, color: hasError ? DD_RED : DD_GREEN }}>
                        {(svc.metrics.errorRate * 100).toFixed(2)}%
                    </div>
                </div>
                <div>
                    <div style={{ fontSize: 9, color: DD_MUTED, fontFamily: 'var(--font-mono)' }}>P99</div>
                    <div style={{ fontSize: 15, fontWeight: 750, color: latencyColor }}>{fmtLatency(svc.metrics.p99Latency)}</div>
                </div>
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 10, color: DD_MUTED, fontFamily: 'var(--font-mono)' }}>
                <span>p50: {fmtLatency(svc.metrics.p50Latency)}</span>
                <span>p95: {fmtLatency(svc.metrics.p95Latency)}</span>
            </div>
            {svc.dependencies.length > 0 && (
                <div style={{ fontSize: 9, color: DD_MUTED, marginTop: 6, fontFamily: 'var(--font-mono)' }}>
                    ↓ {svc.dependencies.join(', ')}
                </div>
            )}
        </div>
    );
}

function AnomalyAlert({ anomaly }: { anomaly: Anomaly }) {
    const color = anomaly.severity === 'critical' ? DD_RED : anomaly.severity === 'warning' ? DD_ORANGE : DD_BLUE;
    return (
        <div style={{ ...anomalyStyle, borderLeft: `3px solid ${color}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: DD_TEXT }}>{anomaly.title}</div>
                    <div style={{ fontSize: 11, color: DD_MUTED, marginTop: 2 }}>{anomaly.description}</div>
                </div>
                <span style={{
                    fontSize: 9, fontWeight: 800, fontFamily: 'var(--font-mono)',
                    color, textTransform: 'uppercase', flexShrink: 0,
                }}>
                    {anomaly.severity}
                </span>
            </div>
        </div>
    );
}

function ErrorRow({ err }: { err: ErrorEvent }) {
    return (
        <div style={errorRowStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{
                    fontSize: 9, fontWeight: 800, fontFamily: 'var(--font-mono)',
                    color: DD_RED, textTransform: 'uppercase', flexShrink: 0,
                }}>
                    {err.service}
                </span>
                <span style={{ fontSize: 9, color: DD_MUTED, fontFamily: 'var(--font-mono)' }}>
                    {new Date(err.timestamp).toLocaleTimeString()}
                </span>
            </div>
            <div style={{ fontSize: 11, color: DD_TEXT, marginTop: 2 }}>{err.message}</div>
        </div>
    );
}

export function AiQaObservabilityPanel({ accentColor }: { accentColor: string }) {
    const { mode } = useDemoMode();
    const [data, setData] = useState<TelemetrySnapshot | null>(null);
    const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedTab, setSelectedTab] = useState<'services' | 'errors' | 'anomalies'>('services');

    const load = () => {
        setLoading(true);
        fetch('/api/aiqa/telemetry')
            .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then((body: { snapshot: TelemetrySnapshot | null; anomalies: Anomaly[]; error: string | null }) => {
                if (body.snapshot) setData(body.snapshot);
                if (body.anomalies) setAnomalies(body.anomalies);
                if (body.error) setError(body.error);
                else setError(null);
            })
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        load();
        const t = setInterval(load, 60_000);
        return () => clearInterval(t);
    }, []);

    if (mode !== 'financial') return null;

    return (
        <section style={{
            border: `1px solid ${DD_RED}30`,
            borderRadius: 8,
            padding: 16,
            margin: '12px 0',
            background: DD_DARK,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            borderTop: `3px solid ${DD_RED}`,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: DD_RED, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 1 }}>
                        &#9679; Live
                    </span>
                    <h3 style={{ margin: 0, fontSize: 14, color: DD_TEXT, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 0 }}>
                        Observability
                    </h3>
                    {anomalies.length > 0 && (
                        <span style={{
                            fontSize: 9, fontWeight: 800, fontFamily: 'var(--font-mono)',
                            color: '#FFFFFF', background: DD_RED, padding: '2px 8px', borderRadius: 10,
                        }}>
                            {anomalies.length} alert{anomalies.length > 1 ? 's' : ''}
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                    {(['services', 'errors', 'anomalies'] as const).map((tab) => (
                        <button
                            key={tab}
                            type="button"
                            onClick={() => setSelectedTab(tab)}
                            style={{
                                padding: '4px 10px',
                                borderRadius: 4,
                                border: 'none',
                                background: selectedTab === tab ? DD_RED : 'transparent',
                                color: selectedTab === tab ? '#FFFFFF' : DD_MUTED,
                                fontSize: 10,
                                fontWeight: 700,
                                fontFamily: 'var(--font-mono)',
                                cursor: 'pointer',
                                textTransform: 'uppercase',
                            }}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
            </div>

            {loading && !data && (
                <p style={{ margin: 0, fontSize: 12, color: DD_MUTED }}>Loading telemetry...</p>
            )}
            {error && (
                <p style={{ margin: 0, fontSize: 12, color: DD_RED }}>
                    Telemetry unavailable: {error}
                </p>
            )}

            {data && selectedTab === 'services' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
                    {data.services.map((svc) => (
                        <ServiceCard key={svc.name} svc={svc} />
                    ))}
                </div>
            )}

            {data && selectedTab === 'errors' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {data.errors.length === 0 ? (
                        <p style={{ margin: 0, fontSize: 12, color: DD_MUTED }}>No recent errors.</p>
                    ) : data.errors.map((err) => (
                        <ErrorRow key={err.id} err={err} />
                    ))}
                </div>
            )}

            {selectedTab === 'anomalies' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {anomalies.length === 0 ? (
                        <p style={{ margin: 0, fontSize: 12, color: DD_GREEN }}>
                            &#10003; No anomalies detected.
                        </p>
                    ) : anomalies.map((a) => (
                        <AnomalyAlert key={a.id} anomaly={a} />
                    ))}
                </div>
            )}

            {data && (
                <div style={{ fontSize: 9, color: DD_MUTED, fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
                    {data.services.length} services &middot; {data.errors.length} errors &middot; {data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : ''}
                </div>
            )}
        </section>
    );
}

const cardStyle: CSSProperties = {
    background: DD_CARD,
    border: `1px solid ${DD_BORDER}`,
    borderRadius: 6,
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
};

const anomalyStyle: CSSProperties = {
    background: DD_CARD,
    border: `1px solid ${DD_BORDER}`,
    borderRadius: 6,
    padding: 10,
};

const errorRowStyle: CSSProperties = {
    background: DD_CARD,
    border: `1px solid ${DD_BORDER}`,
    borderRadius: 6,
    padding: 10,
};
