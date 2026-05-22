import { useEffect, useRef } from 'react';

export interface DashboardNotification {
    id: string;
    timestamp: string;
    type: 'success' | 'info' | 'warning' | 'error';
    title: string;
    message: string;
    agentName?: string;
    dismissed?: boolean;
}

interface NotificationToastProps {
    notifications: DashboardNotification[];
    onDismiss: (id: string) => void;
}

const AUTO_DISMISS_MS = 5000;

const TYPE_CONFIG: Record<DashboardNotification['type'], { icon: string; accent: string }> = {
    success: { icon: '\u2713', accent: 'var(--success)' },
    info:    { icon: '\u2022', accent: 'var(--info)' },
    warning: { icon: '\u26A0', accent: 'var(--warning)' },
    error:   { icon: '\u2716', accent: 'var(--error)' },
};

const KEYFRAMES_ID = 'notification-toast-keyframes';

export function NotificationToast({ notifications, onDismiss }: NotificationToastProps) {
    const visible = notifications.filter((n) => !n.dismissed).slice(-5);

    useEffect(() => {
        if (document.getElementById(KEYFRAMES_ID)) return;
        const style = document.createElement('style');
        style.id = KEYFRAMES_ID;
        style.textContent = `@keyframes slideInRight{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}`;
        document.head.appendChild(style);
    }, []);

    return (
        <div style={styles.stack} role="status" aria-live="polite">
            {visible.map((n) => (
                <Toast key={n.id} notification={n} onDismiss={onDismiss} />
            ))}
        </div>
    );
}

function Toast({ notification, onDismiss }: { notification: DashboardNotification; onDismiss: (id: string) => void }) {
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        if (notification.type === 'error' || notification.type === 'warning') return;
        timerRef.current = setTimeout(() => onDismiss(notification.id), AUTO_DISMISS_MS);
        return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    }, [notification.id, notification.type, onDismiss]);

    const cfg = TYPE_CONFIG[notification.type];

    return (
        <div
            style={{ ...styles.toast, borderLeftColor: cfg.accent, borderLeftWidth: 4 }}
            onMouseEnter={() => { if (timerRef.current) clearTimeout(timerRef.current); }}
            onMouseLeave={() => {
                if (notification.type !== 'error') {
                    timerRef.current = setTimeout(() => onDismiss(notification.id), AUTO_DISMISS_MS);
                }
            }}
        >
            <span style={{ ...styles.icon, color: cfg.accent }}>{cfg.icon}</span>
            <div style={styles.body}>
                <div style={styles.header}>
                    <strong style={styles.title}>{notification.title}</strong>
                    {notification.agentName && (
                        <span style={styles.agent}>{notification.agentName}</span>
                    )}
                </div>
                <span style={styles.message}>{notification.message}</span>
            </div>
            <button style={styles.dismiss} onClick={() => onDismiss(notification.id)} aria-label="Dismiss" data-testid={`toast-dismiss-${notification.id}`}>&times;</button>
        </div>
    );
}
NotificationToast.displayName = 'NotificationToast';
Toast.displayName = 'Toast';

const styles: Record<string, React.CSSProperties> = {
    stack: {
        position: 'fixed',
        bottom: 60,
        right: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 9999,
        pointerEvents: 'none',
        maxWidth: 360,
    },
    toast: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 14px',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--bg-card)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
        pointerEvents: 'auto',
        animation: 'slideInRight 0.3s ease-out',
    },
    icon: {
        fontSize: 16,
        lineHeight: '20px',
        flexShrink: 0,
        fontWeight: 700,
    },
    body: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
    },
    title: {
        fontSize: 13,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
    },
    agent: {
        fontSize: 12,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
    },
    message: {
        fontSize: 12,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
        lineHeight: '16px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
    },
    dismiss: {
        background: 'none',
        border: 'none',
        color: 'var(--text-tertiary)',
        fontSize: 16,
        cursor: 'pointer',
        padding: '0 2px',
        lineHeight: '20px',
        flexShrink: 0,
    },
};
