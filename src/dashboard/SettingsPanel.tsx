import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTheme } from './ThemeProvider';
import type { ThemeDefinition } from './themes';
import { useFocusTrap } from './hooks/useFocusTrap';
import { AGENT_RESET_CONFIRM_PHRASE } from '../shared/agentResetConfirm';
import { DemoModeSelector } from './DemoModeSelector';

interface Props {
    open: boolean;
    onClose: () => void;
    /** After successful idle reset, refresh dashboard agent cards from the API. */
    onRefreshAgents?: () => void | Promise<void>;
}

export function SettingsPanel({ open, onClose, onRefreshAgents }: Props) {
    const { current, themes, setTheme } = useTheme();
    const panelRef = useRef<HTMLDivElement>(null);
    const resetModalRef = useRef<HTMLDivElement>(null);

    const [resetModalOpen, setResetModalOpen] = useState(false);
    const [resetPhrase, setResetPhrase] = useState('');
    const [resetBusy, setResetBusy] = useState(false);
    const [resetError, setResetError] = useState<string | null>(null);


    useFocusTrap(panelRef, open && !resetModalOpen);
    useFocusTrap(resetModalRef, open && resetModalOpen);

    useEffect(() => {
        if (!open) {
            setResetModalOpen(false);
            setResetPhrase('');
            setResetError(null);
            setResetBusy(false);
            return;
        }
    }, [open]);


    useEffect(() => {
        if (!open) return;
        function handleKey(e: KeyboardEvent) {
            if (e.key !== 'Escape') return;
            if (resetModalOpen) {
                setResetModalOpen(false);
                setResetPhrase('');
                setResetError(null);
            } else {
                onClose();
            }
        }
        function handleClick(e: MouseEvent) {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                if (!resetModalOpen) onClose();
            }
        }
        document.addEventListener('keydown', handleKey);
        setTimeout(() => document.addEventListener('click', handleClick), 0);
        return () => {
            document.removeEventListener('keydown', handleKey);
            document.removeEventListener('click', handleClick);
        };
    }, [open, onClose, resetModalOpen]);

    const confirmPhraseMatches = resetPhrase.trim() === AGENT_RESET_CONFIRM_PHRASE;

    const handleConfirmReset = async () => {
        if (!confirmPhraseMatches || resetBusy) return;
        setResetBusy(true);
        setResetError(null);
        try {
            const res = await fetch(`${window.location.origin}/api/agents/reset-to-idle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: resetPhrase.trim() }),
            });
            const body = await res.json().catch(() => ({})) as { error?: string };
            if (!res.ok) {
                setResetError(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
                return;
            }
            setResetModalOpen(false);
            setResetPhrase('');
            await onRefreshAgents?.();
        } catch (err) {
            setResetError(err instanceof Error ? err.message : String(err));
        } finally {
            setResetBusy(false);
        }
    };

    if (!open) return null;

    return (
        <div style={styles.overlay}>
            <div ref={panelRef} style={styles.panel} role="dialog" aria-modal="true">
                <div style={styles.header}>
                    <span style={styles.title}>Settings</span>
                    <button style={styles.closeBtn} onClick={onClose} aria-label="Close settings">&times;</button>
                </div>

                <div style={styles.section}>
                    <span style={styles.sectionLabel}>Demo Mode</span>
                    <DemoModeSelector />
                </div>

                <div style={{ ...styles.section, marginTop: 20 }}>
                    <span style={styles.sectionLabel}>Theme</span>
                    <div style={styles.themeGrid}>
                        {themes.map(theme => (
                            <ThemeCard
                                key={theme.id}
                                theme={theme}
                                active={current.id === theme.id}
                                onSelect={() => setTheme(theme.id)}
                            />
                        ))}
                    </div>
                </div>


                <div style={{ ...styles.section, marginTop: 28 }}>
                    <span style={styles.sectionLabel}>Workspace</span>
                    <p style={styles.dangerHint}>
                        Reset every agent status file to idle and clear all <code style={styles.codeInline}>.*-messages.json</code> queues.
                        Does not modify workflow database rows.
                    </p>
                    <button
                        type="button"
                        style={styles.dangerOutlineBtn}
                        onClick={() => {
                            setResetModalOpen(true);
                            setResetPhrase('');
                            setResetError(null);
                        }}
                        data-testid="settings-reset-agents-open"
                    >
                        Reset all agents…
                    </button>
                </div>

                <div style={styles.footer}>
                    <button style={styles.backBtn} onClick={onClose} aria-label="Back to floor">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8 }}>
                            <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
                        </svg>
                        Back to Floor
                    </button>
                </div>
            </div>

            {resetModalOpen && (
                <div
                    style={styles.resetOverlay}
                    role="presentation"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setResetModalOpen(false);
                            setResetPhrase('');
                            setResetError(null);
                        }
                    }}
                >
                    <div
                        ref={resetModalRef}
                        style={styles.resetModal}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="reset-agents-dialog-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2 id="reset-agents-dialog-title" style={styles.resetModalTitle}>Reset all agents?</h2>
                        <p style={styles.resetModalBody}>
                            This writes idle JSON for all six agents and clears chat message files.
                            Restart long-running agent drivers if they still hold old story context.
                        </p>
                        <p style={styles.resetModalPhrase}>
                            Type <strong>{AGENT_RESET_CONFIRM_PHRASE}</strong> to confirm:
                        </p>
                        <input
                            type="text"
                            autoComplete="off"
                            value={resetPhrase}
                            onChange={(e) => setResetPhrase(e.target.value)}
                            placeholder={AGENT_RESET_CONFIRM_PHRASE}
                            style={styles.resetInput}
                            data-testid="settings-reset-agents-phrase"
                            aria-label="Confirmation phrase"
                        />
                        {resetError && (
                            <p style={styles.resetError} role="alert">{resetError}</p>
                        )}
                        <div style={styles.resetModalActions}>
                            <button
                                type="button"
                                style={styles.resetCancelBtn}
                                onClick={() => {
                                    setResetModalOpen(false);
                                    setResetPhrase('');
                                    setResetError(null);
                                }}
                                disabled={resetBusy}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                style={{
                                    ...styles.resetConfirmBtn,
                                    opacity: confirmPhraseMatches && !resetBusy ? 1 : 0.45,
                                    cursor: confirmPhraseMatches && !resetBusy ? 'pointer' : 'not-allowed',
                                }}
                                onClick={() => void handleConfirmReset()}
                                disabled={!confirmPhraseMatches || resetBusy}
                                data-testid="settings-reset-agents-confirm"
                            >
                                {resetBusy ? 'Resetting…' : 'Reset agents'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function ThemeCard({ theme, active, onSelect }: { theme: ThemeDefinition; active: boolean; onSelect: () => void }) {
    return (
        <button
            style={{
                ...styles.card,
                borderColor: active ? theme.accent : 'var(--border)',
                boxShadow: active ? `0 0 0 2px ${theme.accent}` : 'none',
            }}
            onClick={onSelect}
        >
            <div style={styles.swatchRow}>
                <div style={{ ...styles.swatch, background: theme.bgPrimary }} />
                <div style={{ ...styles.swatch, background: theme.bgCard }} />
                <div style={{ ...styles.swatch, background: theme.accent }} />
                <div style={{ ...styles.swatch, background: theme.textPrimary }} />
            </div>
            <span style={styles.cardLabel}>{theme.name}</span>
            {active && <span style={styles.activeBadge}>Active</span>}
        </button>
    );
}
SettingsPanel.displayName = 'SettingsPanel';
ThemeCard.displayName = 'ThemeCard';

const styles: Record<string, CSSProperties> = {
    overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        justifyContent: 'flex-end',
    },
    panel: {
        width: 320,
        height: '100vh',
        background: 'var(--bg-card)',
        borderLeft: '1px solid var(--border)',
        boxShadow: '-4px 0 20px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        padding: 20,
        overflowY: 'auto',
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 24,
    },
    title: {
        fontSize: 18,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
    },
    closeBtn: {
        background: 'none',
        border: 'none',
        fontSize: 24,
        cursor: 'pointer',
        color: 'var(--text-secondary)',
        lineHeight: 1,
    },
    section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
    },
    sectionLabel: {
        fontSize: 12,
        textTransform: 'uppercase' as const,
        letterSpacing: 1,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
    },
    themeGrid: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
    },
    card: {
        background: 'var(--bg-secondary)',
        border: '2px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: 'border-color 0.2s, box-shadow 0.2s',
    },
    swatchRow: {
        display: 'flex',
        gap: 6,
    },
    swatch: {
        width: 32,
        height: 24,
        borderRadius: 4,
        border: '1px solid rgba(0,0,0,0.1)',
    },
    cardLabel: {
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
    },
    activeBadge: {
        alignSelf: 'flex-start',
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 10,
        background: 'var(--accent)',
        color: '#fff',
        fontWeight: 600,
    },
    footer: {
        marginTop: 'auto',
        paddingTop: 20,
        borderTop: '1px solid var(--border)',
    },
    backBtn: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        padding: '10px 16px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
        transition: 'background 0.15s, color 0.15s',
    },
    dangerHint: {
        margin: 0,
        fontSize: 12,
        lineHeight: 1.45,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
    },
    codeInline: {
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        background: 'var(--bg-secondary)',
        padding: '1px 6px',
        borderRadius: 4,
    },
    dangerOutlineBtn: {
        alignSelf: 'flex-start',
        padding: '8px 14px',
        fontSize: 12,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        borderRadius: 6,
        border: '1px solid var(--error)',
        background: 'rgba(239, 68, 68, 0.08)',
        color: 'var(--error)',
        cursor: 'pointer',
    },
    resetOverlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 9100,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
    },
    resetModal: {
        width: 'min(420px, 100%)',
        background: 'var(--bg-card)',
        borderRadius: 10,
        border: '1px solid var(--border)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        padding: 22,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
    },
    resetModalTitle: {
        margin: 0,
        fontSize: 17,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
    },
    resetModalBody: {
        margin: 0,
        fontSize: 13,
        lineHeight: 1.5,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
    },
    resetModalPhrase: {
        margin: 0,
        fontSize: 12,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
    },
    resetInput: {
        width: '100%',
        padding: '10px 12px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        boxSizing: 'border-box' as const,
    },
    resetError: {
        margin: 0,
        fontSize: 12,
        color: 'var(--error)',
        fontFamily: 'var(--font-mono)',
    },
    resetModalActions: {
        display: 'flex',
        gap: 10,
        justifyContent: 'flex-end',
        marginTop: 8,
    },
    resetCancelBtn: {
        padding: '8px 16px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-secondary)',
        fontWeight: 600,
        fontSize: 13,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
    },
    resetConfirmBtn: {
        padding: '8px 16px',
        borderRadius: 6,
        border: '1px solid var(--error)',
        background: 'var(--error)',
        color: '#fff',
        fontWeight: 700,
        fontSize: 13,
        fontFamily: 'var(--font-mono)',
    },
};
