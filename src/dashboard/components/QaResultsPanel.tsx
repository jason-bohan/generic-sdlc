import { useState, useEffect } from 'react';

export interface QaResultsPanelProps {
    agentId: string;
    storyNumber?: string | null;
}

export function QaResultsPanel({ agentId, storyNumber }: QaResultsPanelProps) {
    const [latest, setLatest] = useState<{ passed?: number; failed?: number; skipped?: number; spec_file?: string; recorded_at?: string; failures_json?: string; empty?: boolean } | null>(null);

    useEffect(() => {
        const fetchLatest = () => {
            fetch(`${window.location.origin}/api/test-results?agentId=${agentId}&latest=1`)
                .then(r => r.json())
                .then(setLatest)
                .catch(() => {});
        };
        fetchLatest();
        const interval = setInterval(fetchLatest, 10_000);
        return () => clearInterval(interval);
    }, [agentId]);

    if (!storyNumber || !latest || latest.empty) return null;

    const total = (latest.passed ?? 0) + (latest.failed ?? 0) + (latest.skipped ?? 0);
    if (total === 0) return null;
    const allPass = (latest.failed ?? 0) === 0;
    const failures: Array<{ test: string; error: string }> = latest.failures_json ? (() => { try { return JSON.parse(latest.failures_json); } catch { return []; } })() : [];

    return (
        <div style={{ margin: '0 16px 8px', padding: 10, borderRadius: 8, background: allPass ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)', border: `1px solid ${allPass ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }} data-testid={`qa-results-${agentId}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: allPass ? '#22c55e' : '#ef4444' }}>
                    {allPass ? 'ALL TESTS PASS' : 'TESTS FAILING'}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {latest.recorded_at ? new Date(latest.recorded_at + 'Z').toLocaleTimeString() : ''}
                </span>
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                <span style={{ color: '#22c55e' }}>{latest.passed ?? 0} passed</span>
                <span style={{ color: (latest.failed ?? 0) > 0 ? '#ef4444' : 'var(--text-secondary)' }}>{latest.failed ?? 0} failed</span>
                {(latest.skipped ?? 0) > 0 && <span style={{ color: '#f59e0b' }}>{latest.skipped} skipped</span>}
            </div>
            {failures.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#ef4444', fontFamily: 'var(--font-mono)', maxHeight: 60, overflowY: 'auto' }}>
                    {failures.slice(0, 3).map((f, i) => (
                        <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {f.test}: {f.error}
                        </div>
                    ))}
                    {failures.length > 3 && <div style={{ opacity: 0.7 }}>+{failures.length - 3} more</div>}
                </div>
            )}
        </div>
    );
}

QaResultsPanel.displayName = 'QaResultsPanel';
