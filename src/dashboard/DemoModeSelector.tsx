import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { DEMO_MODES, type DemoMode } from '../shared/demoMode';
import { useDemoMode } from './DemoModeProvider';

export function DemoModeSelector() {
    const { mode, loading, setMode } = useDemoMode();
    const isFinancial = mode === 'financial';

    const options = useMemo(() => DEMO_MODES, []);

    return (
        <div style={styles.wrapper}>
            <div style={styles.row}>
                {options.map((opt) => {
                    const active = opt.mode === mode;
                    const isFin = opt.mode === 'financial';
                    return (
                        <button
                            key={opt.mode}
                            type="button"
                            disabled={loading || active}
                            onClick={() => {
                                if (opt.mode !== mode) setMode(opt.mode as DemoMode).catch(() => {});
                            }}
                            style={{
                                ...styles.card,
                                ...(active && isFinancial && styles.cardFinancialActive),
                                ...(active && !isFinancial && styles.cardStandardActive),
                                borderColor: active
                                    ? (isFinancial ? '#CC0000' : '#7C3AED')
                                    : 'var(--border)',
                                background: active
                                    ? (isFinancial ? 'rgba(204, 0, 0, 0.06)' : 'rgba(124, 58, 237, 0.06)')
                                    : 'var(--bg-secondary)',
                            }}
                        >
                            {isFin && (
                                <div style={{
                                    ...styles.badge,
                                    background: active ? '#CC0000' : '#6E6E72',
                                }}>
                                    FDIC
                                </div>
                            )}
                            <span style={{
                                ...styles.label,
                                color: active ? (isFinancial ? '#CC0000' : '#7C3AED') : 'var(--text-primary)',
                            }}>
                                {opt.label}
                            </span>
                            <span style={styles.desc}>{opt.description}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

const styles: Record<string, CSSProperties> = {
    wrapper: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
    },
    row: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
    },
    card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '12px 14px',
        borderRadius: 8,
        border: '2px solid var(--border)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'var(--font-sans)',
        transition: 'border-color 0.15s, background 0.15s',
        position: 'relative',
    },
    cardFinancialActive: {
        boxShadow: '0 0 0 1px rgba(204, 0, 0, 0.15), 0 2px 8px rgba(204, 0, 0, 0.08)',
    },
    cardStandardActive: {
        boxShadow: '0 0 0 1px rgba(124, 58, 237, 0.15), 0 2px 8px rgba(124, 58, 237, 0.08)',
    },
    badge: {
        position: 'absolute',
        top: 8,
        right: 8,
        fontSize: 9,
        fontWeight: 800,
        fontFamily: 'var(--font-mono)',
        color: '#FFFFFF',
        padding: '2px 6px',
        borderRadius: 4,
        letterSpacing: 0.5,
    },
    label: {
        fontSize: 14,
        fontWeight: 700,
        fontFamily: 'var(--font-sans)',
    },
    desc: {
        fontSize: 11,
        color: 'var(--text-tertiary)',
        lineHeight: 1.4,
        fontFamily: 'var(--font-mono)',
    },
};
