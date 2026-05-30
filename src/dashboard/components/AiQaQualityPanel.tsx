import React, { useEffect, useMemo, useState } from 'react';
import { fetchAiQaScorecard, postAiQaSweep } from '../api';

type Severity = 'high' | 'medium' | 'low';
type EvalStatus = 'pass' | 'warn' | 'fail';

interface AiQaFinding {
    id: string;
    severity: Severity;
    agentId: string;
    title: string;
    evidence: string;
    suggestedOwner: string;
    source: string;
}

interface AgentQualityCard {
    agentId: string;
    currentPhase: string;
    isRunning: boolean;
    openTasks: number;
    failedTasks: number;
    openRequests: number;
    activePrs: number;
    tokenTotal: number;
    findings: number;
}

interface AiQaEvalCheck {
    id: string;
    name: string;
    status: EvalStatus;
    evidence: string;
}

interface FinancialControl {
    id: string;
    name: string;
    status: EvalStatus;
    evidence: string;
    owner: string;
}

interface FinancialRiskSignal {
    area: string;
    risk: Severity;
    evidence: string;
}

interface AiQaScorecard {
    generatedAt: string;
    summary: {
        qualityScore: number;
        openFindings: number;
        highSeverity: number;
        sessionsReviewed: number;
        tokenTotal: number;
    };
    scorecards: AgentQualityCard[];
    findings: AiQaFinding[];
    evals: AiQaEvalCheck[];
    financial?: {
        financialRisk: Severity;
        riskSignals: FinancialRiskSignal[];
        controls: FinancialControl[];
        targetRepo?: {
            project: string;
            workspacePath: string | null;
            scannedFiles: number;
            matchedFiles: string[];
            unavailableReason?: string;
        };
    };
}

function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
}

function severityColor(severity: Severity): string {
    if (severity === 'high') return '#ef4444';
    if (severity === 'medium') return '#f59e0b';
    return '#64748b';
}

function evalColor(status: EvalStatus): string {
    if (status === 'fail') return '#ef4444';
    if (status === 'warn') return '#f59e0b';
    return '#10b981';
}

export function AiQaQualityPanel({ accentColor }: { accentColor: string }) {
    const [data, setData] = useState<AiQaScorecard | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sweeping, setSweeping] = useState(false);
    const [sweepResult, setSweepResult] = useState<string | null>(null);

    const load = () => {
        setLoading(true);
        fetchAiQaScorecard()
            .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then((next: AiQaScorecard) => {
                setData(next);
                setError(null);
            })
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        load();
        const t = setInterval(load, 30_000);
        return () => clearInterval(t);
    }, []);

    const topFindings = useMemo(() => data?.findings.slice(0, 6) ?? [], [data]);

    const runSweep = () => {
        setSweeping(true);
        setSweepResult(null);
        postAiQaSweep()
            .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then((body: { written?: number; scorecard?: AiQaScorecard }) => {
                setSweepResult(`${body.written ?? 0} task pill(s) filed`);
                if (body.scorecard) setData(body.scorecard);
                else load();
            })
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setSweeping(false));
    };

    return (
        <section
            data-testid="aiqa-quality-panel"
            style={{
                border: `1px solid ${accentColor}40`,
                borderRadius: 8,
                padding: 16,
                margin: '12px 0',
                background: 'var(--bg-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div>
                    <h3 style={{ margin: 0, fontSize: 14, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 0 }}>
                        AI Workforce Quality
                    </h3>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
                        Agent telemetry, eval checks, and actionable findings.
                    </p>
                </div>
                <div style={styles.actionRow}>
                    <button
                        type="button"
                        onClick={runSweep}
                        disabled={sweeping}
                        style={{
                            border: `1px solid ${accentColor}`,
                            background: `${accentColor}1a`,
                            color: accentColor,
                            borderRadius: 6,
                            padding: '8px 12px',
                            cursor: sweeping ? 'wait' : 'pointer',
                            fontWeight: 800,
                            fontSize: 12,
                            fontFamily: 'var(--font-mono)',
                            letterSpacing: 0,
                        }}
                    >
                        {sweeping ? 'Running Sweep' : 'Run Eval Sweep'}
                    </button>
                </div>
            </div>

            {loading && !data && <p style={styles.muted}>Loading AIQA scorecard...</p>}
            {error && <p style={{ ...styles.muted, color: '#ef4444' }}>AIQA data unavailable: {error}</p>}

            {data && (
                <>
                    <div style={styles.metricsGrid}>
                        <Metric label="Quality Score" value={`${data.summary.qualityScore}`} tone={data.summary.qualityScore < 70 ? '#ef4444' : accentColor} />
                        <Metric label="Open Findings" value={String(data.summary.openFindings)} tone={data.summary.highSeverity ? '#ef4444' : accentColor} />
                        <Metric label="Financial Risk" value={data.financial?.financialRisk ?? 'low'} tone={severityColor(data.financial?.financialRisk ?? 'low')} />
                        <Metric label="Sessions Reviewed" value={String(data.summary.sessionsReviewed)} />
                        <Metric label="Ledger Tokens" value={fmtTokens(data.summary.tokenTotal)} />
                    </div>

                    <div style={styles.agentGrid}>
                        {data.scorecards.map((card) => (
                            <div key={card.agentId} style={{ ...styles.agentCard, borderColor: card.findings ? `${severityColor(card.failedTasks ? 'high' : 'medium')}55` : 'var(--border)' }}>
                                <div style={styles.agentTopline}>
                                    <strong style={styles.agentName}>{card.agentId}</strong>
                                    <span style={{ ...styles.phaseBadge, color: card.isRunning ? '#10b981' : 'var(--text-tertiary)' }}>
                                        {card.currentPhase}
                                    </span>
                                </div>
                                <div style={styles.agentStats}>
                                    <span>{card.findings} finding(s)</span>
                                    <span>{card.openTasks} task(s)</span>
                                    <span>{fmtTokens(card.tokenTotal)} tokens</span>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div style={styles.evalRow}>
                        {data.evals.map((check) => (
                            <div key={check.id} style={styles.evalItem}>
                                <span style={{ ...styles.evalStatus, background: evalColor(check.status) }} />
                                <div>
                                    <div style={styles.evalName}>{check.name}</div>
                                    <div style={styles.evalEvidence}>{check.evidence}</div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {data.financial && (
                        <div style={styles.financialPanel} data-testid="aiqa-financial-controls">
                            <div style={styles.sectionTitle}>Financial Controls</div>
                            <div style={styles.targetRepo}>
                                Target: {data.financial.targetRepo?.project ?? 'default'}
                                {data.financial.targetRepo?.workspacePath ? ` | ${data.financial.targetRepo.scannedFiles} files scanned` : ''}
                                {data.financial.targetRepo?.unavailableReason ? ` | ${data.financial.targetRepo.unavailableReason}` : ''}
                            </div>
                            <div style={styles.controlGrid}>
                                {data.financial.controls.map((control) => (
                                    <div key={control.id} style={{ ...styles.controlCard, borderColor: `${evalColor(control.status)}55` }}>
                                        <div style={styles.controlHeader}>
                                            <span style={{ ...styles.evalStatus, background: evalColor(control.status), marginTop: 2 }} />
                                            <strong style={styles.controlName}>{control.name}</strong>
                                            <span style={{ ...styles.controlStatus, color: evalColor(control.status) }}>{control.status}</span>
                                        </div>
                                        <div style={styles.evalEvidence}>{control.evidence}</div>
                                        <div style={styles.findingRoute}>Owner: {control.owner}</div>
                                    </div>
                                ))}
                            </div>
                            {data.financial.riskSignals.length > 0 && (
                                <div style={styles.riskSignalList}>
                                    {data.financial.riskSignals.map((signal) => (
                                        <div key={`${signal.area}:${signal.evidence}`} style={styles.riskSignal}>
                                            <span style={{ ...styles.severity, color: severityColor(signal.risk), borderColor: `${severityColor(signal.risk)}66` }}>{signal.risk}</span>
                                            <div>
                                                <div style={styles.findingTitle}>{signal.area}</div>
                                                <div style={styles.findingEvidence}>{signal.evidence}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    <div style={styles.findingList}>
                        <div style={styles.sectionTitle}>Top Findings</div>
                        {topFindings.length === 0 ? (
                            <p style={styles.muted}>No open AIQA findings detected.</p>
                        ) : topFindings.map((finding) => (
                            <div key={finding.id} style={styles.findingRow}>
                                <span style={{ ...styles.severity, color: severityColor(finding.severity), borderColor: `${severityColor(finding.severity)}66` }}>
                                    {finding.severity}
                                </span>
                                <div style={{ minWidth: 0 }}>
                                    <div style={styles.findingTitle}>{finding.title} <span style={styles.findingAgent}>{finding.agentId}</span></div>
                                    <div style={styles.findingEvidence}>{finding.evidence}</div>
                                    <div style={styles.findingRoute}>Owner: {finding.suggestedOwner} | Source: {finding.source}</div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {sweepResult && <p style={{ ...styles.muted, color: accentColor }}>{sweepResult}</p>}
                </>
            )}
        </section>
    );
}

function Metric({ label, value, tone = 'var(--text-primary)' }: { label: string; value: string; tone?: string }) {
    return (
        <div style={styles.metric}>
            <span style={{ ...styles.metricValue, color: tone }}>{value}</span>
            <span style={styles.metricLabel}>{label}</span>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    muted: { margin: 0, fontSize: 12, color: 'var(--text-tertiary)' },
    actionRow: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
    metricsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 },
    metric: { border: '1px solid var(--border)', borderRadius: 6, padding: 10, background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 2 },
    metricValue: { fontSize: 22, fontWeight: 850, fontFamily: 'var(--font-mono)', letterSpacing: 0 },
    metricLabel: { fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', letterSpacing: 0 },
    agentGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 },
    agentCard: { border: '1px solid var(--border)', borderRadius: 6, padding: 10, background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 8 },
    agentTopline: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
    agentName: { fontSize: 12, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' },
    phaseBadge: { fontSize: 10, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    agentStats: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
    evalRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 },
    evalItem: { display: 'flex', gap: 8, alignItems: 'flex-start', border: '1px solid var(--border)', borderRadius: 6, padding: 10, background: 'var(--bg-secondary)' },
    evalStatus: { width: 8, height: 8, borderRadius: 999, marginTop: 4, flexShrink: 0 },
    evalName: { fontSize: 12, fontWeight: 750, color: 'var(--text-primary)' },
    evalEvidence: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.35 },
    findingList: { display: 'flex', flexDirection: 'column', gap: 8 },
    sectionTitle: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', fontWeight: 800, letterSpacing: 0 },
    findingRow: { display: 'grid', gridTemplateColumns: '74px minmax(0, 1fr)', gap: 10, border: '1px solid var(--border)', borderRadius: 6, padding: 10, background: 'var(--bg-secondary)' },
    severity: { alignSelf: 'start', textTransform: 'uppercase', border: '1px solid', borderRadius: 4, padding: '3px 6px', fontSize: 10, fontWeight: 850, fontFamily: 'var(--font-mono)', textAlign: 'center' },
    findingTitle: { fontSize: 13, color: 'var(--text-primary)', fontWeight: 750, overflowWrap: 'anywhere' },
    findingAgent: { color: 'var(--text-tertiary)', fontSize: 11, fontFamily: 'var(--font-mono)' },
    findingEvidence: { marginTop: 3, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.35, overflowWrap: 'anywhere' },
    findingRoute: { marginTop: 5, fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
    financialPanel: { display: 'flex', flexDirection: 'column', gap: 8 },
    targetRepo: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
    controlGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 8 },
    controlCard: { border: '1px solid var(--border)', borderRadius: 6, padding: 10, background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 6 },
    controlHeader: { display: 'grid', gridTemplateColumns: '12px minmax(0, 1fr) auto', gap: 8, alignItems: 'center' },
    controlName: { fontSize: 12, color: 'var(--text-primary)', overflowWrap: 'anywhere' },
    controlStatus: { fontSize: 10, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', fontWeight: 850 },
    riskSignalList: { display: 'flex', flexDirection: 'column', gap: 8 },
    riskSignal: { display: 'grid', gridTemplateColumns: '74px minmax(0, 1fr)', gap: 10, border: '1px solid var(--border)', borderRadius: 6, padding: 10, background: 'var(--bg-secondary)' },
};

AiQaQualityPanel.displayName = 'AiQaQualityPanel';
