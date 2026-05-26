import { useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentProfile, AgentStatus, PullRequestWithAgentName } from '../types';
import { StatPill, PrPill, TasksPill, statPillBarStyles as ps } from './StatPill';
import { floorStatsBarStyles as styles } from './FloorStatsBar.styles';
import { AgentCostBreakdown } from './AgentCostBreakdown';

export interface FloorStatsBarProps {
    integrationMock: boolean;
    activeAgents: AgentProfile[];
    totalCloudTokens: number;
    totalMeshllmTokens: number;
    totalOllamaTokens: number;
    agentStatuses: Record<string, AgentStatus | null>;
    displayNames: Record<string, string>;
    onSelectAgent: (agent: AgentProfile) => void;
    headerOpenPullRequests: PullRequestWithAgentName[];
    activeWorkItemCount: number;
    formatTokens: (n: number) => string;
    testSummary: { total_passed: number; total_failed: number; last_run_at: string | null } | null;
    showTestBreakdown: boolean;
    setShowTestBreakdown: Dispatch<SetStateAction<boolean>>;
    testRuns: Array<{ id: number; spec_file: string; passed: number; failed: number; skipped: number; duration_ms: number; recorded_at: string }>;
    setTestRuns: Dispatch<SetStateAction<Array<{ id: number; spec_file: string; passed: number; failed: number; skipped: number; duration_ms: number; recorded_at: string }>>>;
    externalMode?: string;
    onSetExternalMode?: (mode: string) => void;
    availableProjects: string[];
    activeProject: string;
    setActiveProject: Dispatch<SetStateAction<string>>;
    ledgerEntries: [string, { storyName: string | null; totals: { input: number; output: number } }][];
    showLedger: boolean;
    setShowLedger: Dispatch<SetStateAction<boolean>>;
    ledgerTotalTokens: number;
}

export function FloorStatsBar({
    integrationMock,
    activeAgents,
    totalCloudTokens,
    totalMeshllmTokens,
    totalOllamaTokens,
    agentStatuses,
    displayNames,
    onSelectAgent,
    headerOpenPullRequests,
    activeWorkItemCount,
    formatTokens,
    testSummary,
    showTestBreakdown,
    setShowTestBreakdown,
    testRuns,
    setTestRuns,
    externalMode,
    onSetExternalMode,
    availableProjects,
    activeProject,
    setActiveProject,
    ledgerEntries,
    showLedger,
    setShowLedger,
    ledgerTotalTokens,
}: FloorStatsBarProps) {
    const [showCostBreakdown, setShowCostBreakdown] = useState(false);
    return (
        <>
            <div
                style={{
                    ...styles.statsBar,
                    ...(integrationMock
                        ? {
                            backgroundColor: 'rgba(245, 158, 11, 0.06)',
                            borderRadius: 8,
                            paddingLeft: 8,
                            paddingRight: 8,
                            marginLeft: -8,
                            marginRight: -8,
                            transition: 'background-color 0.35s ease',
                        }
                        : {
                            backgroundColor: 'rgba(34, 197, 94, 0.06)',
                            borderRadius: 8,
                            paddingLeft: 8,
                            paddingRight: 8,
                            marginLeft: -8,
                            marginRight: -8,
                            transition: 'background-color 0.35s ease',
                        }),
                }}
                role="status"
                aria-label="System Statistics"
            >
                <StatPill label="Agents" value={activeAgents.length.toString()} />
                <div style={{ position: 'relative' }}>
                    <button
                        onClick={() => setShowCostBreakdown(v => !v)}
                        style={{ ...ps.statPill, cursor: 'pointer', background: 'var(--bg-card)' }}
                        title="Click to see per-agent cost breakdown"
                    >
                        <span style={ps.statLabel}>Tokens {showCostBreakdown ? '▲' : '▼'}</span>
                        <span style={ps.statValue}>
                            {formatTokens(totalCloudTokens + totalMeshllmTokens + totalOllamaTokens)}
                        </span>
                    </button>
                    {showCostBreakdown && (
                        <AgentCostBreakdown agentStatuses={agentStatuses} displayNames={displayNames} />
                    )}
                </div>
                <TasksPill count={activeWorkItemCount} agentStatuses={agentStatuses} displayNames={displayNames} onSelectAgent={onSelectAgent} />
                <PrPill items={headerOpenPullRequests} />
                {testSummary && testSummary.last_run_at && (
                    <div style={{ position: 'relative' }}>
                        <button
                            onClick={() => {
                                const next = !showTestBreakdown;
                                setShowTestBreakdown(next);
                                if (next) {
                                    fetch('/api/test-results?agentId=qa')
                                        .then(r => r.json())
                                        .then(d => { if (Array.isArray(d.runs)) setTestRuns(d.runs); })
                                        .catch(() => {});
                                }
                            }}
                            style={{ ...ps.statPill, borderColor: testSummary.total_failed > 0 ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)', cursor: 'pointer', background: 'var(--bg-card)' }}
                        >
                            <span style={ps.statLabel}>QA Tests {showTestBreakdown ? '\u25B2' : '\u25BC'}</span>
                            <span style={{ ...ps.statValue, color: testSummary.total_failed > 0 ? '#ef4444' : '#22c55e' }}>
                                {testSummary.total_passed}P / {testSummary.total_failed}F
                            </span>
                        </button>
                        {showTestBreakdown && testRuns.length > 0 && (
                            <div style={styles.testBreakdownPopup}>
                                <div style={styles.testBreakdownHeader}>
                                    <span>Spec</span>
                                    <span style={{ textAlign: 'right' }}>Result</span>
                                </div>
                                {testRuns.map(run => {
                                    const allPass = run.failed === 0 && run.passed > 0;
                                    return (
                                        <div key={run.id} style={{ ...styles.testBreakdownRow, borderLeftColor: allPass ? '#22c55e' : '#ef4444' }}>
                                            <span style={styles.testBreakdownSpec}>{run.spec_file}</span>
                                            <span style={styles.testBreakdownResult}>
                                                <span style={{ color: '#22c55e', fontWeight: 700 }}>{run.passed}</span>
                                                {run.failed > 0 && <span style={{ color: '#ef4444', fontWeight: 700, marginLeft: 6 }}>{run.failed}</span>}
                                                {run.skipped > 0 && <span style={{ color: '#f59e0b', marginLeft: 6 }}>{run.skipped}</span>}
                                            </span>
                                            <span style={styles.testBreakdownTime}>
                                                {new Date(run.recorded_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
                <button
                    onClick={async () => {
                        const next = externalMode === 'mock' ? 'live' : 'mock';
                        const warning = next === 'live'
                            ? 'Switch to LIVE mode?\n\nThis will enable real Azure DevOps calls, git pushes, and Agility updates. Only do this if you are ready to work against production systems.'
                            : 'Switch to MOCK mode?\n\nAll external integrations (ADO, Agility, git push) will be simulated. Agent work will not affect production systems.';
                        if (!window.confirm(warning)) return;
                        try {
                            const r = await fetch('/api/external-mode', {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ mode: next }),
                            });
                            const d = await r.json();
                            if (d.ok && onSetExternalMode) onSetExternalMode(next);
                        } catch { /* silent */ }
                    }}
                    style={{
                        ...ps.statPill,
                        cursor: 'pointer',
                        background: 'var(--bg-card)',
                        borderColor: integrationMock ? 'rgba(245,158,11,0.55)' : 'rgba(34,197,94,0.55)',
                        transition: 'box-shadow 0.3s ease, border-color 0.3s ease, background-color 0.3s ease',
                        ...(integrationMock
                            ? {
                                boxShadow: '0 0 20px rgba(245, 158, 11, 0.42), 0 0 8px rgba(245, 158, 11, 0.2) inset',
                            }
                            : {
                                boxShadow: '0 0 18px rgba(34, 197, 94, 0.35), 0 0 6px rgba(34, 197, 94, 0.12) inset',
                            }),
                    }}
                    title={`Click to switch to ${integrationMock ? 'live' : 'mock'} mode`}
                >
                    <span style={ps.statLabel}>Integrations</span>
                    <span
                        style={{
                            ...ps.statValue,
                            color: integrationMock ? '#f59e0b' : '#22c55e',
                            fontSize: 22,
                            fontWeight: 800,
                            letterSpacing: '0.02em',
                            textShadow: integrationMock
                                ? '0 0 14px rgba(245, 158, 11, 0.65), 0 0 28px rgba(245, 158, 11, 0.25)'
                                : '0 0 14px rgba(34, 197, 94, 0.55), 0 0 26px rgba(34, 197, 94, 0.22)',
                            transition: 'color 0.3s ease, text-shadow 0.3s ease',
                        }}
                    >
                        {integrationMock ? 'Mock' : 'Live'}
                    </span>
                </button>
                {availableProjects.length > 0 && (
                    <div style={{ ...ps.statPill, padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={ps.statLabel}>Repo</span>
                        {availableProjects.length === 1 ? (
                            <span style={{ ...ps.statValue, fontSize: 13 }}>
                                {availableProjects[0].charAt(0).toUpperCase() + availableProjects[0].slice(1)}
                            </span>
                        ) : (
                            <select
                                value={activeProject}
                                onChange={async (e) => {
                                    const name = e.target.value;
                                    setActiveProject(name);
                                    try {
                                        await fetch('/api/active-project', {
                                            method: 'PUT',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ project: name }),
                                        });
                                    } catch { /* non-critical */ }
                                }}
                                style={{
                                    background: 'var(--bg-card)',
                                    color: 'var(--text)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 6,
                                    padding: '4px 8px',
                                    fontSize: 13,
                                    cursor: 'pointer',
                                    outline: 'none',
                                }}
                                aria-label="Active repo"
                            >
                                {availableProjects.map(p => (
                                    <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                                ))}
                            </select>
                        )}
                    </div>
                )}
                {ledgerEntries.length > 0 && (
                    <button
                        onClick={() => setShowLedger(v => !v)}
                        style={{ ...ps.statPill, cursor: 'pointer', border: showLedger ? '1px solid var(--accent)' : '1px solid transparent', position: 'relative' }}
                        title="Story token ledger"
                    >
                        <span style={ps.statValue}>{formatTokens(ledgerTotalTokens)}</span>
                        <span style={ps.statLabel}>Story Tokens ({ledgerEntries.length})</span>
                    </button>
                )}
            </div>

            {showLedger && ledgerEntries.length > 0 && (
                <div style={{ margin: '0 16px 12px', padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', maxHeight: 260, overflowY: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>Token Ledger by Story</span>
                        <button onClick={() => setShowLedger(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 16 }} aria-label="Close ledger">&times;</button>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Story</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Input</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Output</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ledgerEntries.map(([num, data]) => (
                                <tr key={num} style={{ borderBottom: '1px solid var(--border)' }}>
                                    <td style={{ padding: '4px 8px', color: 'var(--accent)' }} title={data.storyName ?? ''}>{num}</td>
                                    <td style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-secondary)' }}>{(data.totals?.input ?? 0).toLocaleString()}</td>
                                    <td style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-secondary)' }}>{(data.totals?.output ?? 0).toLocaleString()}</td>
                                    <td style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-primary)', fontWeight: 600 }}>{((data.totals?.input ?? 0) + (data.totals?.output ?? 0)).toLocaleString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}

FloorStatsBar.displayName = 'FloorStatsBar';
