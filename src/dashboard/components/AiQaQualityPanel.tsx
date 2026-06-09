import React, { useEffect, useMemo, useState } from 'react';
import { fetchAiQaScorecard, postAiQaSweep, postFromAiqa, fetchAiQaEval, fetchAiQaHallucinations, fetchAiQaDatasets } from '../api';
import { useDemoMode } from '../DemoModeProvider';

type Severity = 'high' | 'medium' | 'low';
type EvalStatus = 'pass' | 'warn' | 'fail';

interface EvalSuiteResult {
    exampleId: string;
    overallScore: number;
    verdict: EvalStatus;
    passed: boolean;
    criteria: Array<{ id: string; name: string; verdict: EvalStatus; score: number; detail: string }>;
}

interface EvalSuiteSummary {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    averageScore: number;
}

interface EvalSuiteResponse {
    generatedAt: string;
    summary: EvalSuiteSummary;
    results: EvalSuiteResult[];
}

interface HallucinationSignal {
    id: string;
    agentId: string;
    type: string;
    severity: Severity;
    description: string;
    evidence: string;
}

interface HallucinationReport {
    agentId: string;
    totalSignals: number;
    highSeverity: number;
    mediumSeverity: number;
    lowSeverity: number;
    signals: HallucinationSignal[];
    hasHallucinationRisk: boolean;
}

interface DatasetInfo {
    id: string;
    name: string;
    description: string;
    examples: number;
}

interface AiQaFinding {
    id: string;
    severity: Severity;
    agentId: string;
    title: string;
    evidence: string;
    suggestedOwner: string;
    source: string;
    createdAt?: string;
    /** Present only after the finding has been synced to the planner (provider-agnostic) as a tracked task. */
    plannerUrl?: string;
    /** Present once a fix story has been authored from this finding. `number` is the live tracker ref (e.g. UNW-126). */
    authoredStory?: { number: string; url?: string };
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
    const { mode } = useDemoMode();
    const isFinancial = mode === 'financial';
    const effectiveAccent = isFinancial ? '#CC0000' : accentColor;

    const [data, setData] = useState<AiQaScorecard | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sweeping, setSweeping] = useState(false);
    const [sweepResult, setSweepResult] = useState<string | null>(null);
    const [evalSuite, setEvalSuite] = useState<EvalSuiteResponse | null>(null);
    const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
    const [hallucinationReport, setHallucinationReport] = useState<HallucinationReport | null>(null);
    const [selectedFinding, setSelectedFinding] = useState<AiQaFinding | null>(null);
    const [authoring, setAuthoring] = useState(false);
    const [authorResult, setAuthorResult] = useState<string | null>(null);

    const load = () => {
        setLoading(true);
        Promise.all([
            fetchAiQaScorecard().then((r) => r.ok ? r.json() : Promise.reject(new Error('scorecard'))),
            fetchAiQaEval().then((r) => r.ok ? r.json() : Promise.reject(new Error('eval'))).catch(() => null),
            fetchAiQaDatasets().then((r) => r.ok ? r.json() : Promise.reject(new Error('datasets'))).catch(() => null),
            fetchAiQaHallucinations().then((r) => r.ok ? r.json() : Promise.reject(new Error('hallucinations'))).catch(() => null),
        ])
            .then(([sc, evalRes, ds, hall]) => {
                setData(sc);
                setEvalSuite(evalRes);
                setDatasets(ds?.datasets ?? null);
                setHallucinationReport(hall?.report ?? null);
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

    const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const allFindings = useMemo(
        () => [...(data?.findings ?? [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3)),
        [data],
    );

    // Author fix stories from findings. No ids → top findings across the scorecard;
    // one id → just that finding (the per-finding modal action). Reloads after, so the
    // freshly-linked story surfaces on the finding once the mirror lands.
    const authorFromFindings = (findingIds?: string[], autoAssign = false) => {
        setAuthoring(true);
        setAuthorResult(null);
        postFromAiqa({ ...(findingIds ? { findingIds } : {}), autoAssign })
            .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then((body: { ok?: boolean; reason?: string; limited?: boolean; authored?: Array<{ number: string; name: string }>; tick?: { assigned?: Array<{ storyNumber: string; agentId: string }> } }) => {
                if (body.ok && body.authored?.length) {
                    const base = `Authored ${body.authored.length} story(ies): ${body.authored.map((a) => a.number).join(', ')}`;
                    const routed = body.tick?.assigned?.length
                        ? ` — assigned: ${body.tick.assigned.map((a) => `${a.storyNumber}→${a.agentId}`).join(', ')}`
                        : (autoAssign ? ' — no agents free to assign yet' : '');
                    setAuthorResult(base + routed);
                } else if (body.limited) {
                    setAuthorResult('Model usage limit reached — authoring paused, will retry after refresh.');
                } else {
                    setAuthorResult(body.reason ?? 'No stories authored.');
                }
                load();
            })
            .catch((e) => setAuthorResult(`Authoring failed: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => setAuthoring(false));
    };

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
                border: `1px solid ${effectiveAccent}40`,
                borderRadius: 8,
                padding: 16,
                margin: '12px 0',
                background: 'var(--bg-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                ...(isFinancial ? { borderTop: `3px solid #CC0000` } : {}),
            }}
        >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <h3 style={{ margin: 0, fontSize: 14, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 0 }}>
                            AI Workforce Quality
                        </h3>
                        {isFinancial && (
                            <span style={styles.fdicBadge}>FDIC-Insured</span>
                        )}
                    </div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
                        {isFinancial
                            ? 'Agent telemetry, financial controls, and compliance oversight.'
                            : 'Agent telemetry, eval checks, and actionable findings.'}
                    </p>
                </div>
                <div style={styles.actionRow}>
                    <button
                        type="button"
                        onClick={runSweep}
                        disabled={sweeping}
                        style={{
                            border: `1px solid ${effectiveAccent}`,
                            background: `${effectiveAccent}1a`,
                            color: effectiveAccent,
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
                    <button
                        type="button"
                        onClick={() => authorFromFindings()}
                        disabled={authoring || !data?.findings.length}
                        title="Author fix stories from the top findings (no fleet kickoff)"
                        style={{
                            border: `1px solid ${effectiveAccent}`,
                            background: effectiveAccent,
                            color: 'var(--bg-card)',
                            borderRadius: 6,
                            padding: '8px 12px',
                            cursor: authoring ? 'wait' : (!data?.findings.length ? 'not-allowed' : 'pointer'),
                            opacity: !data?.findings.length ? 0.5 : 1,
                            fontWeight: 800,
                            fontSize: 12,
                            fontFamily: 'var(--font-mono)',
                            letterSpacing: 0,
                        }}
                    >
                        {authoring ? 'Authoring…' : 'Author Fix Stories'}
                    </button>
                    <button
                        type="button"
                        onClick={() => authorFromFindings(undefined, true)}
                        disabled={authoring || !data?.findings.length}
                        title="Author fix stories from the top findings AND route each to its specialist agent"
                        style={{
                            border: `1px solid ${effectiveAccent}`,
                            background: effectiveAccent,
                            color: 'var(--bg-card)',
                            borderRadius: 6,
                            padding: '8px 12px',
                            cursor: authoring ? 'wait' : (!data?.findings.length ? 'not-allowed' : 'pointer'),
                            opacity: !data?.findings.length ? 0.5 : 1,
                            fontWeight: 800,
                            fontSize: 12,
                            fontFamily: 'var(--font-mono)',
                            letterSpacing: 0,
                        }}
                    >
                        {authoring ? 'Authoring…' : 'Author & Assign'}
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

                    {evalSuite && (
                        <div style={styles.evalSuiteSection} data-testid="aiqa-eval-suite">
                            <div style={styles.sectionTitle}>Eval Suite ({evalSuite.summary.passRate}% pass rate)</div>
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                                <span style={styles.evalStat}>Passed: <strong style={{ color: '#10b981' }}>{evalSuite.summary.passed}</strong></span>
                                <span style={styles.evalStat}>Failed: <strong style={{ color: '#ef4444' }}>{evalSuite.summary.failed}</strong></span>
                                <span style={styles.evalStat}>Avg Score: <strong>{evalSuite.summary.averageScore}</strong></span>
                                <span style={styles.evalStat}>Total: <strong>{evalSuite.summary.total}</strong></span>
                            </div>
                            {evalSuite.results.filter((r) => !r.passed).length > 0 && (
                                <div style={styles.evalResultsList}>
                                    {evalSuite.results.filter((r) => !r.passed).slice(0, 4).map((r) => (
                                        <div key={r.exampleId} style={{ ...styles.evalItem, fontSize: 11 }}>
                                            <span style={{ ...styles.evalStatus, background: '#ef4444' }} />
                                            <div>
                                                <div style={styles.evalName}>{r.exampleId} ({r.overallScore})</div>
                                                <div style={styles.evalEvidence}>{r.verdict}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {datasets && datasets.length > 0 && (
                        <div data-testid="aiqa-datasets">
                            <div style={styles.sectionTitle}>Eval Datasets ({datasets.length} registered)</div>
                            <div style={{ ...styles.evalRow, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                                {datasets.map((ds) => (
                                    <div key={ds.id} style={styles.datasetCard}>
                                        <div style={styles.evalName}>{ds.name}</div>
                                        <div style={styles.evalEvidence}>{ds.examples} examples</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {hallucinationReport && hallucinationReport.hasHallucinationRisk && (
                        <div data-testid="aiqa-hallucination-signals">
                            <div style={{ ...styles.sectionTitle, color: '#ef4444' }}>
                                Hallucination Risk Detected ({hallucinationReport.totalSignals} signal(s))
                            </div>
                            <div style={styles.controlGrid}>
                                {hallucinationReport.signals.slice(0, 4).map((s) => (
                                    <div key={s.id} style={{ ...styles.controlCard, borderColor: `${severityColor(s.severity)}55` }}>
                                        <div style={styles.controlHeader}>
                                            <span style={{ ...styles.evalStatus, background: severityColor(s.severity), marginTop: 2 }} />
                                            <strong style={styles.controlName}>{s.type.replace('-', ' ')}</strong>
                                            <span style={{ ...styles.controlStatus, color: severityColor(s.severity) }}>{s.severity}</span>
                                        </div>
                                        <div style={styles.evalEvidence}>{s.description}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {data.financial && (
                        <div style={{ ...styles.financialPanel, ...(isFinancial ? { borderLeft: `3px solid #CC0000`, paddingLeft: 12 } : {}) }} data-testid="aiqa-financial-controls">
                            <div style={{ ...styles.sectionTitle, ...(isFinancial ? { color: '#CC0000' } : {}) }}>Financial Controls</div>
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
                        <div style={styles.sectionTitle}>Findings ({allFindings.length})</div>
                        {allFindings.length === 0 ? (
                            <p style={styles.muted}>No open AIQA findings detected.</p>
                        ) : (
                            <div style={styles.findingScroll}>
                                {allFindings.map((finding) => (
                                    <div
                                        key={finding.id}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={`Open finding: ${finding.title}`}
                                        onClick={() => setSelectedFinding(finding)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedFinding(finding); } }}
                                        style={{ ...styles.findingRow, ...styles.findingRowClickable }}
                                    >
                                        <span style={{ ...styles.severity, color: severityColor(finding.severity), borderColor: `${severityColor(finding.severity)}66` }}>
                                            {finding.severity}
                                        </span>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={styles.findingTitle}>
                                                {finding.title} <span style={styles.findingAgent}>{finding.agentId}</span>
                                                {finding.authoredStory && (
                                                    <span style={{ ...styles.storyBadge, color: accentColor, borderColor: `${accentColor}66` }}>
                                                        {finding.authoredStory.number}
                                                    </span>
                                                )}
                                            </div>
                                            <div style={styles.findingEvidence}>{finding.evidence}</div>
                                            <div style={styles.findingRoute}>
                                                Owner: {finding.suggestedOwner} | Source: {finding.source}
                                                {finding.plannerUrl ? ' | Planner ↗' : ''}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {sweepResult && <p style={{ ...styles.muted, color: accentColor }}>{sweepResult}</p>}
                    {authorResult && <p style={{ ...styles.muted, color: accentColor }} data-testid="aiqa-author-result">{authorResult}</p>}
                </>
            )}

            {selectedFinding && (
                <FindingModal
                    finding={selectedFinding}
                    accent={effectiveAccent}
                    authoring={authoring}
                    onAuthor={() => authorFromFindings(selectedFinding.id ? [selectedFinding.id] : undefined)}
                    onClose={() => setSelectedFinding(null)}
                />
            )}
        </section>
    );
}

function FindingModal({ finding, accent, authoring, onAuthor, onClose }: { finding: AiQaFinding; accent: string; authoring: boolean; onAuthor: () => void; onClose: () => void }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const sevColor = severityColor(finding.severity);
    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={`Finding: ${finding.title}`}
            data-testid="aiqa-finding-modal"
            style={styles.modalOverlay}
            onClick={onClose}
        >
            <div style={{ ...styles.modalCard, borderTop: `3px solid ${sevColor}` }} onClick={(e) => e.stopPropagation()}>
                <div style={styles.modalHeader}>
                    <span style={{ ...styles.severity, color: sevColor, borderColor: `${sevColor}66` }}>{finding.severity}</span>
                    <h4 style={styles.modalTitle}>{finding.title}</h4>
                    <button type="button" aria-label="Close" onClick={onClose} style={styles.modalClose}>✕</button>
                </div>

                <dl style={styles.modalMeta}>
                    <div style={styles.modalMetaRow}><dt style={styles.modalDt}>Agent</dt><dd style={styles.modalDd}>{finding.agentId}</dd></div>
                    <div style={styles.modalMetaRow}><dt style={styles.modalDt}>Source</dt><dd style={styles.modalDd}>{finding.source}</dd></div>
                    <div style={styles.modalMetaRow}><dt style={styles.modalDt}>Owner</dt><dd style={styles.modalDd}>{finding.suggestedOwner}</dd></div>
                    {finding.createdAt && (
                        <div style={styles.modalMetaRow}><dt style={styles.modalDt}>Detected</dt><dd style={styles.modalDd}>{new Date(finding.createdAt).toLocaleString()}</dd></div>
                    )}
                </dl>

                <div style={styles.modalSectionTitle}>Evidence</div>
                <p style={styles.modalEvidence}>{finding.evidence}</p>

                <div style={styles.modalActions}>
                    {finding.authoredStory ? (
                        finding.authoredStory.url ? (
                            <a
                                href={finding.authoredStory.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-testid="aiqa-finding-story-link"
                                style={{ ...styles.modalPlannerLink, borderColor: accent, color: accent, background: `${accent}1a` }}
                            >
                                Story {finding.authoredStory.number} ↗
                            </a>
                        ) : (
                            <span style={{ ...styles.modalPlannerLink, borderColor: accent, color: accent, background: `${accent}1a` }}>
                                Story {finding.authoredStory.number}
                            </span>
                        )
                    ) : (
                        <button
                            type="button"
                            onClick={onAuthor}
                            disabled={authoring}
                            data-testid="aiqa-finding-author-btn"
                            style={{ ...styles.modalPlannerLink, borderColor: accent, color: 'var(--bg-card)', background: accent, cursor: authoring ? 'wait' : 'pointer' }}
                        >
                            {authoring ? 'Authoring…' : 'Author fix story'}
                        </button>
                    )}
                    {finding.plannerUrl ? (
                        <a
                            href={finding.plannerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="aiqa-finding-planner-link"
                            style={{ ...styles.modalPlannerLink, borderColor: accent, color: accent, background: `${accent}1a` }}
                        >
                            Open planner task ↗
                        </a>
                    ) : null}
                    <button type="button" onClick={onClose} style={styles.modalDismiss}>Close</button>
                </div>
            </div>
        </div>
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
    fdicBadge: {
        fontSize: 9,
        fontWeight: 800,
        fontFamily: 'var(--font-mono)',
        color: '#FFFFFF',
        background: '#003366',
        padding: '3px 8px',
        borderRadius: 4,
        letterSpacing: 0.5,
        textTransform: 'uppercase' as const,
        lineHeight: 1.3,
    },
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
    findingScroll: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto', paddingRight: 4 },
    storyBadge: { marginLeft: 6, border: '1px solid', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' },
    sectionTitle: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', fontWeight: 800, letterSpacing: 0 },
    findingRow: { display: 'grid', gridTemplateColumns: '74px minmax(0, 1fr)', gap: 10, border: '1px solid var(--border)', borderRadius: 6, padding: 10, background: 'var(--bg-secondary)' },
    findingRowClickable: { cursor: 'pointer', textAlign: 'left' as const, width: '100%', font: 'inherit' },
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
    evalSuiteSection: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)' },
    evalStat: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
    evalResultsList: { display: 'flex', flexDirection: 'column', gap: 6 },
    datasetCard: { border: '1px solid var(--border)', borderRadius: 6, padding: 10, background: 'var(--bg-card)', display: 'flex', flexDirection: 'column', gap: 4 },
    modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 1000 },
    modalCard: { width: 'min(560px, 100%)', maxHeight: '85vh', overflowY: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 18, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' },
    modalHeader: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: 10, alignItems: 'start' },
    modalTitle: { margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', overflowWrap: 'anywhere' },
    modalClose: { border: 'none', background: 'transparent', color: 'var(--text-tertiary)', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: 2 },
    modalMeta: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px', margin: 0 },
    modalMetaRow: { display: 'flex', gap: 6, alignItems: 'baseline' },
    modalDt: { fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', letterSpacing: 0 },
    modalDd: { margin: 0, fontSize: 12, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' },
    modalSectionTitle: { fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', letterSpacing: 0 },
    modalEvidence: { margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45, overflowWrap: 'anywhere' },
    modalActions: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 4, flexWrap: 'wrap' },
    modalPlannerLink: { fontSize: 12, fontWeight: 800, fontFamily: 'var(--font-mono)', border: '1px solid', borderRadius: 6, padding: '8px 12px', textDecoration: 'none' },
    modalNoPlanner: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
    modalDismiss: { border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', borderRadius: 6, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
};

AiQaQualityPanel.displayName = 'AiQaQualityPanel';
