import React from 'react';
import type { StatusEvent } from './types';

interface EventTimelineProps {
  events: StatusEvent[];
  maxItems?: number;
}

const TYPE_ICONS: Record<StatusEvent['type'], { symbol: string; color: string }> = {
  success: { symbol: '\u2713', color: 'var(--success)' },
  info: { symbol: '\u2022', color: 'var(--text-tertiary)' },
  warning: { symbol: '\u26A0', color: 'var(--warning)' },
  error: { symbol: '\u2716', color: 'var(--error)' },
  phase: { symbol: '\u25B6', color: 'var(--accent)' },
  verdict: { symbol: '\u2696', color: 'var(--warning)' },
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

export function EventTimeline({ events, maxItems = 10 }: EventTimelineProps) {
  const recent = [...events].reverse().slice(0, maxItems);

  if (recent.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>Activity</div>
        <div style={styles.empty}>No events yet</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>Activity</div>
      <div style={styles.list}>
        {recent.map((event, i) => {
          const icon = TYPE_ICONS[event.type] ?? TYPE_ICONS.info;
          return (
            <div key={i} style={styles.item}>
              <div style={styles.timeline}>
                <span style={{ ...styles.icon, color: icon.color }}>{icon.symbol}</span>
                {i < recent.length - 1 && <div style={styles.line} />}
              </div>
              <div style={styles.content}>
                <span style={styles.message}>{event.message}</span>
                <span style={styles.time}>{relativeTime(event.timestamp)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
EventTimeline.displayName = 'EventTimeline';

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '8px 12px',
    borderRadius: 6,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    maxHeight: 200,
    overflowY: 'auto',
  },
  header: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    marginBottom: 8,
  },
  empty: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    fontStyle: 'italic',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  item: {
    display: 'flex',
    gap: 8,
    minHeight: 28,
  },
  timeline: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: 16,
    flexShrink: 0,
  },
  icon: {
    fontSize: 12,
    lineHeight: '16px',
    fontWeight: 700,
  },
  line: {
    flex: 1,
    width: 1,
    background: 'var(--border)',
    marginTop: 2,
    marginBottom: 2,
  },
  content: {
    flex: 1,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
    paddingBottom: 6,
  },
  message: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: '16px',
  },
  time: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    lineHeight: '16px',
  },
};
