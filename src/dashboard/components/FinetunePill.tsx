import { useState, useEffect, type CSSProperties } from 'react';

interface FinetuneStatus {
    running: boolean;
    lastRunAt: string | null;
    lastRunResult: 'success' | 'failed' | 'skipped' | null;
    lastRunLog: string;
    storiesUntilNext: number;
    storiesCompleted: number;
    threshold: number;
}

export function FinetunePill() {
    const [status, setStatus] = useState<FinetuneStatus | null>(null);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const poll = async () => {
            try {
                const res = await fetch('/api/finetune/status', { signal: AbortSignal.timeout(4000) });
                if (!cancelled && res.ok) setStatus(await res.json());
            } catch { /* silent */ }
        };
        poll();
        const interval = setInterval(poll, status?.running ? 3000 : 15000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [status?.running]);

    if (!status) return null;

    const { running, lastRunResult, lastRunLog, storiesUntilNext, storiesCompleted, threshold } = status;

    const pillColor = running ? '#f59e0b'
        : lastRunResult === 'success' ? '#22c55e'
        : lastRunResult === 'failed' ? '#ef4444'
        : '#6b7280';

    const pillLabel = running ? '⟳ Training…'
        : lastRunResult === 'success' ? '✓ Tuned'
        : lastRunResult === 'failed' ? '✗ Train failed'
        : lastRunResult === 'skipped' ? '↷ Dataset ready'
        : null;

    const progressHint = !running && !lastRunResult
        ? `${storiesUntilNext} stor${storiesUntilNext === 1 ? 'y' : 'ies'} until train`
        : `${storiesCompleted} completed · ${storiesUntilNext} until next`;

    return (
        <div style={styles.wrapper}>
            {pillLabel && (
                <button
                    style={{ ...styles.pill, background: `${pillColor}22`, color: pillColor, borderColor: `${pillColor}44` }}
                    onClick={() => setExpanded(e => !e)}
                    title={progressHint}
                >
                    {pillLabel}
                </button>
            )}
            {!pillLabel && (
                <span style={styles.hint} title="Auto fine-tune progress">
                    {progressHint}
                </span>
            )}
            {expanded && (
                <div style={styles.popup}>
                    <div style={styles.popupHeader}>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>Fine-tune status</span>
                        <button style={styles.close} onClick={() => setExpanded(false)}>✕</button>
                    </div>
                    <div style={styles.popupRow}>
                        <span style={styles.dim}>Stories</span>
                        <span>{storiesCompleted} completed · threshold {threshold}</span>
                    </div>
                    <div style={styles.popupRow}>
                        <span style={styles.dim}>Next run</span>
                        <span>{running ? 'running now' : `${storiesUntilNext} stor${storiesUntilNext === 1 ? 'y' : 'ies'} away`}</span>
                    </div>
                    {lastRunLog && (
                        <pre style={styles.log}>{lastRunLog.split('\n').slice(-12).join('\n')}</pre>
                    )}
                    {!running && (
                        <button style={styles.triggerBtn} onClick={async () => {
                            await fetch('/api/finetune/trigger', { method: 'POST' });
                            setExpanded(false);
                        }}>
                            Trigger now
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

FinetunePill.displayName = 'FinetunePill';

const styles: Record<string, CSSProperties> = {
    wrapper: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
    },
    pill: {
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.05em',
        padding: '2px 8px',
        borderRadius: 20,
        border: '1px solid',
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        background: 'none',
    },
    hint: {
        fontSize: 10,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
        whiteSpace: 'nowrap' as const,
    },
    popup: {
        position: 'absolute' as const,
        top: '100%',
        right: 0,
        marginTop: 6,
        width: 320,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column' as const,
        gap: 8,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-primary)',
    },
    popupHeader: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    popupRow: {
        display: 'flex',
        justifyContent: 'space-between',
    },
    dim: {
        color: 'var(--text-tertiary)',
    },
    log: {
        margin: 0,
        padding: '6px 8px',
        background: '#0d1117',
        borderRadius: 4,
        fontSize: 10,
        color: '#c9d1d9',
        overflowX: 'auto' as const,
        maxHeight: 120,
        overflowY: 'auto' as const,
        whiteSpace: 'pre-wrap' as const,
        wordBreak: 'break-word' as const,
    },
    close: {
        background: 'none',
        border: 'none',
        color: 'var(--text-tertiary)',
        cursor: 'pointer',
        fontSize: 11,
        padding: '0 4px',
    },
    triggerBtn: {
        background: 'var(--accent)',
        color: '#fff',
        border: 'none',
        borderRadius: 4,
        padding: '4px 10px',
        fontSize: 11,
        cursor: 'pointer',
        fontWeight: 600,
        alignSelf: 'flex-start' as const,
    },
};
