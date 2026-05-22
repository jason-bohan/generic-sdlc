import { useState, useEffect, useRef } from 'react';

export interface StoppedResumeChipProps {
    agentId: string;
}

export function StoppedResumeChip({ agentId }: StoppedResumeChipProps) {
    const [open, setOpen] = useState(false);
    const [spawning, setSpawning] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const handleResume = async () => {
        setSpawning(true);
        try {
            await fetch(`${window.location.origin}/api/agent/continue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId }),
            });
        } catch { /* silent */ }
        setTimeout(() => { setSpawning(false); setOpen(false); }, 2000);
    };

    return (
        <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
            <button
                onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
                style={{
                    fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
                    background: '#ef444418', color: '#ef4444', border: '1px solid #ef444444',
                    borderRadius: 4, padding: '1px 6px', cursor: 'pointer',
                    letterSpacing: '0.04em',
                }}
                data-testid={`stopped-badge-${agentId}`}
            >
                STOPPED
            </button>
            {open && (
                <div style={{
                    position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                    marginTop: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '10px 14px', zIndex: 100,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.25)', whiteSpace: 'nowrap',
                    minWidth: 180,
                }}>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.4 }}>
                        Agent was terminated mid-work.
                    </div>
                    <button
                        onClick={(e) => { e.stopPropagation(); void handleResume(); }}
                        disabled={spawning}
                        style={{
                            width: '100%', fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)',
                            padding: '6px 12px', borderRadius: 4, border: 'none', cursor: spawning ? 'wait' : 'pointer',
                            background: 'var(--accent)', color: '#fff', letterSpacing: '0.03em',
                        }}
                        data-testid={`resume-btn-${agentId}`}
                    >
                        {spawning ? 'Starting...' : 'Resume'}
                    </button>
                </div>
            )}
        </div>
    );
}

StoppedResumeChip.displayName = 'StoppedResumeChip';
