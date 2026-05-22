import { useRef } from 'react';
import type { DashboardNotification } from './NotificationToast';
import { useFocusTrap } from './hooks/useFocusTrap';

interface NotificationHistoryProps {
    notifications: DashboardNotification[];
    open: boolean;
    onClose: () => void;
    onClear: () => void;
}

const TYPE_STYLES: Record<DashboardNotification['type'], { icon: string; color: string }> = {
    success: { icon: '\u2713', color: '#10B981' },
    info:    { icon: '\u2022', color: '#006674' },
    warning: { icon: '\u26A0', color: '#F59E0B' },
    error:   { icon: '\u2716', color: '#f3503f' },
};

function relativeTime(isoString: string): string {
    const diff = Date.now() - new Date(isoString).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationHistory({ notifications, open, onClose, onClear }: NotificationHistoryProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    useFocusTrap(panelRef, open);

    if (!open) return null;

    const sorted = [...notifications].reverse();

    return (
        <div style={styles.overlay} onClick={onClose}>
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                style={styles.panel}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={styles.header}>
                    <span style={styles.headerTitle}>Notifications</span>
                    <span style={styles.headerCount}>{notifications.length}</span>
                    <div style={{ flex: 1 }} />
                    {notifications.length > 0 && (
                        <button style={styles.clearBtn} onClick={onClear}>Clear all</button>
                    )}
                    <button
                        style={styles.closeBtn}
                        onClick={onClose}
                        aria-label="Close notifications"
                    >
                        &times;
                    </button>
                </div>

                <div style={styles.list}>
                    {sorted.length === 0 && (
                        <div style={styles.empty}>No notifications yet</div>
                    )}
                    {sorted.map((n) => {
                        const cfg = TYPE_STYLES[n.type];
                        return (
                            <div key={n.id} style={styles.item}>
                                <span style={{ ...styles.icon, color: cfg.color }}>{cfg.icon}</span>
                                <div style={styles.itemBody}>
                                    <div style={styles.itemHeader}>
                                        <strong style={styles.itemTitle}>{n.title}</strong>
                                        {n.agentName && <span style={styles.itemAgent}>{n.agentName}</span>}
                                        <span style={styles.itemTime}>{relativeTime(n.timestamp)}</span>
                                    </div>
                                    <span style={styles.itemMessage}>{n.message}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
NotificationHistory.displayName = 'NotificationHistory';

const styles: Record<string, React.CSSProperties> = {
    overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(0,0,0,0.3)',
    },
    panel: {
        position: 'absolute',
        top: 50,
        right: 24,
        width: 380,
        maxHeight: 'calc(100vh - 100px)',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
    },
    headerTitle: {
        fontSize: 14,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
    },
    headerCount: {
        fontSize: 10,
        color: 'var(--accent)',
        fontFamily: 'var(--font-mono)',
        background: 'var(--accent-dim)',
        padding: '2px 6px',
        borderRadius: 8,
        fontWeight: 700,
    },
    clearBtn: {
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-tertiary)',
        background: 'none',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 4,
        padding: '3px 8px',
        cursor: 'pointer',
    },
    closeBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--text-tertiary)',
        fontSize: 18,
        cursor: 'pointer',
        padding: '0 4px',
    },
    list: {
        flex: 1,
        overflowY: 'auto',
        padding: '8px 0',
    },
    empty: {
        padding: '24px 16px',
        textAlign: 'center',
        color: 'var(--text-tertiary)',
        fontSize: 12,
        fontStyle: 'italic',
        fontFamily: 'var(--font-mono)',
    },
    item: {
        display: 'flex',
        gap: 10,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
    },
    icon: {
        fontSize: 13,
        lineHeight: '18px',
        flexShrink: 0,
        fontWeight: 700,
        marginTop: 1,
    },
    itemBody: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
    },
    itemHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
    },
    itemTitle: {
        fontSize: 11,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
    },
    itemAgent: {
        fontSize: 9,
        color: 'var(--accent)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
    },
    itemTime: {
        fontSize: 9,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
        marginLeft: 'auto',
        flexShrink: 0,
    },
    itemMessage: {
        fontSize: 11,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
        lineHeight: '14px',
    },
};
