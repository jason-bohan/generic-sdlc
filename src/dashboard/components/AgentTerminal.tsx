import { useState, useEffect, useRef, type CSSProperties } from 'react';

interface AgentTerminalProps {
    agentId: string;
    active: boolean;
    collapsed: boolean;
    onToggleCollapse: () => void;
    /** When true, renders in full-height desk mode without the collapsible header chrome */
    embedded?: boolean;
}

export function AgentTerminal({ agentId, active, collapsed, onToggleCollapse, embedded = false }: AgentTerminalProps) {
    const [log, setLog] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);

    useEffect(() => {
        let cancelled = false;
        const poll = async () => {
            try {
                const res = await fetch(`/api/agent-output?agentId=${encodeURIComponent(agentId)}`, {
                    signal: AbortSignal.timeout(5000),
                });
                if (cancelled) return;
                if (res.ok) {
                    const text = await res.text();
                    setLog(text);
                    setError(null);
                } else if (res.status === 404) {
                    setError('No log yet');
                }
            } catch {
                if (!cancelled) setError('Waiting for output…');
            }
        };
        poll();
        const interval = setInterval(poll, active ? 2000 : 10000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [agentId, active]);

    useEffect(() => {
        if (!collapsed && autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [log, autoScroll, collapsed]);

    const handleScroll = () => {
        const el = containerRef.current;
        if (!el) return;
        setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    };

    if (embedded) {
        return (
            <div style={styles.embeddedWrapper}>
                <div style={styles.embeddedHeader}>
                    <span style={dotStyle(active ? '#22c55e' : '#6b7280')} />
                    <span style={styles.embeddedTitle}>Agent Log</span>
                    {active && <span style={styles.live}>LIVE</span>}
                    {autoScroll && active && <span style={styles.scrollPin}>↓ auto</span>}
                </div>
                <div ref={containerRef} onScroll={handleScroll} style={styles.embeddedTerminal}>
                    {error && !log
                        ? <span style={styles.dim}>{error}</span>
                        : <pre style={styles.pre}>{log || (error ?? 'No log yet')}</pre>
                    }
                    <div ref={bottomRef} />
                </div>
            </div>
        );
    }

    return (
        <div style={styles.wrapper}>
            <div style={styles.row} onClick={onToggleCollapse} role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onToggleCollapse(); }}>
                <span style={dotStyle(active ? '#22c55e' : '#6b7280')} />
                <span style={styles.name}>{agentId}</span>
                {active && <span style={styles.live}>LIVE</span>}
                {!active && error && <span style={styles.hint}>{error}</span>}
                {!active && !error && log && (
                    <span style={styles.hint}>{log.trim().split('\n').at(-1)?.slice(0, 80)}</span>
                )}
                <span style={styles.chevron}>{collapsed ? '▸' : '▾'}</span>
            </div>
            {!collapsed && (
                <div ref={containerRef} onScroll={handleScroll} style={styles.terminal}>
                    {error
                        ? <span style={styles.dim}>{error}</span>
                        : <pre style={styles.pre}>{log}</pre>
                    }
                    <div ref={bottomRef} />
                </div>
            )}
        </div>
    );
}

AgentTerminal.displayName = 'AgentTerminal';

function dotStyle(color: string): CSSProperties {
    return { width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 };
}

const styles: Record<string, CSSProperties> = {
    wrapper: {
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
    },
    row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        cursor: 'pointer',
        userSelect: 'none',
        outline: 'none',
    },
    name: {
        fontWeight: 600,
        fontSize: 12,
        color: 'var(--text-primary)',
        minWidth: 70,
    },
    live: {
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 1,
        color: '#22c55e',
        background: 'rgba(34,197,94,0.1)',
        padding: '1px 5px',
        borderRadius: 3,
    },
    hint: {
        flex: 1,
        color: 'var(--text-tertiary)',
        fontSize: 11,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' as const,
    },
    chevron: {
        color: 'var(--text-tertiary)',
        fontSize: 10,
        marginLeft: 'auto',
    },
    terminal: {
        borderTop: '1px solid var(--border)',
        background: '#0d1117',
        overflowY: 'auto' as const,
        maxHeight: 320,
        padding: '8px 12px',
    },
    pre: {
        margin: 0,
        color: '#c9d1d9',
        whiteSpace: 'pre-wrap' as const,
        wordBreak: 'break-word' as const,
    },
    dim: {
        color: '#484f58',
    },
    embeddedWrapper: {
        background: '#0d1117',
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        marginTop: 16,
    },
    embeddedHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(255,255,255,0.03)',
    },
    embeddedTitle: {
        fontWeight: 600,
        fontSize: 10,
        color: '#484f58',
        textTransform: 'uppercase' as const,
        letterSpacing: '0.1em',
        flex: 1,
    },
    embeddedTerminal: {
        overflowY: 'auto' as const,
        maxHeight: 480,
        padding: '10px 14px',
    },
    scrollPin: {
        fontSize: 9,
        color: '#484f58',
        fontWeight: 600,
        letterSpacing: '0.05em',
    },
};
