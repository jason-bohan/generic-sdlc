import { type ReactNode, useState, useEffect } from 'react';
import { agentDetailStyles as s } from './AgentDetail.styles';

export function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div style={s.section}>
            <h2 style={s.sectionTitle}>{title}</h2>
            {children}
        </div>
    );
}
Section.displayName = 'Section';

export function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'accent' | 'success' }) {
    const valueColor = tone === 'accent' ? 'var(--accent)' : tone === 'success' ? 'var(--success)' : 'var(--text-primary)';
    return (
        <div style={s.statCard}>
            <span style={s.statLabel}>{label}</span>
            <span style={{ ...s.statValue, color: valueColor }}>{value}</span>
            {sub && <span style={s.statSub}>{sub}</span>}
        </div>
    );
}
StatCard.displayName = 'StatCard';

export interface TestRun {
    id: number;
    spec_file: string;
    passed: number;
    failed: number;
    skipped: number;
    duration_ms: number;
    failures_json: string;
    recorded_at: string;
}

export function TestRunHistory({ agentId, accentColor }: { agentId: string; accentColor: string }) {
    const [runs, setRuns] = useState<TestRun[]>([]);
    const [expanded, setExpanded] = useState<number | null>(null);

    useEffect(() => {
        let active = true;
        const poll = () => {
            fetch(`/api/test-results?agentId=${agentId}`)
                .then(r => r.json())
                .then(d => { if (active && Array.isArray(d.runs)) setRuns(d.runs); })
                .catch(() => {});
        };
        poll();
        const id = setInterval(poll, 5000);
        return () => { active = false; clearInterval(id); };
    }, [agentId]);

    const totalPassed = runs.reduce((acc, r) => acc + r.passed, 0);
    const totalFailed = runs.reduce((acc, r) => acc + r.failed, 0);

    return (
        <Section title="Test Results">
            {runs.length === 0 ? (
                <p style={s.emptyText}>No test runs recorded yet. Run Cypress via the CLI and results will appear here.</p>
            ) : (
                <>
                    <div style={s.cypressStats}>
                        <CypressStat label="Runs" value={runs.length} color={accentColor} />
                        <CypressStat label="Passed" value={totalPassed} color="var(--success)" />
                        <CypressStat label="Failed" value={totalFailed} color="var(--error)" />
                    </div>
                    <div style={s.testRunList}>
                        {runs.map(run => {
                            const allPass = run.failed === 0;
                            const failures: Array<{ test: string; error: string; spec: string }> =
                                (() => { try { return JSON.parse(run.failures_json); } catch { return []; } })();
                            const isExpanded = expanded === run.id;
                            return (
                                <div key={run.id} style={s.testRunRow}>
                                    <button
                                        onClick={() => setExpanded(isExpanded ? null : run.id)}
                                        style={s.testRunHeader}
                                    >
                                        <span style={{ ...s.testRunStatus, color: allPass ? 'var(--success)' : 'var(--error)' }}>
                                            {allPass ? '\u2713' : '\u2717'}
                                        </span>
                                        <span style={s.testRunSpec}>{run.spec_file}</span>
                                        <span style={s.testRunCounts}>
                                            <span style={{ color: 'var(--success)' }}>{run.passed}P</span>
                                            {run.failed > 0 && <span style={{ color: 'var(--error)', marginLeft: 6 }}>{run.failed}F</span>}
                                        </span>
                                        <span style={s.testRunTime}>
                                            {new Date(run.recorded_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                        <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 4 }}>
                                            {isExpanded ? '\u25B2' : '\u25BC'}
                                        </span>
                                    </button>
                                    {isExpanded && (
                                        <div style={s.testRunDetails}>
                                            <div style={s.testRunMeta}>
                                                <span>Duration: {run.duration_ms > 0 ? `${(run.duration_ms / 1000).toFixed(1)}s` : '\u2014'}</span>
                                                <span>Skipped: {run.skipped}</span>
                                            </div>
                                            {failures.length > 0 && (
                                                <div style={s.failureList}>
                                                    {failures.map((f, i) => (
                                                        <div key={i} style={s.failureItem}>
                                                            <span style={s.failureTest}>{f.test}</span>
                                                            <code style={s.failureError}>{f.error}</code>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            {failures.length === 0 && <p style={s.emptyText}>All tests passed</p>}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </Section>
    );
}
TestRunHistory.displayName = 'TestRunHistory';

export function CypressStat({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center' }}>
            <span style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color }}>{value}</span>
            <span style={s.cypressLabel}>{label}</span>
        </div>
    );
}
CypressStat.displayName = 'CypressStat';
