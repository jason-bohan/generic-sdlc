import { useState, useEffect, useRef, type CSSProperties } from 'react';
import type { AgentProfile, AgentStatus, RequestItem } from '../types';
import { AGENT_ROSTER, getPrUrl, type PullRequestWithAgentName } from '../types';

const styles: Record<string, CSSProperties> = {
    statPill: {
        display: 'flex',
        flexDirection: 'column' as const,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '10px 16px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        minWidth: 100,
        minHeight: 64,
        boxSizing: 'border-box' as const,
    },
    statLabel: {
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase' as const,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
        letterSpacing: 0.5,
    },
    statValue: {
        fontSize: 18,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
    },
    taskDropdown: {
        position: 'absolute' as const,
        top: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        marginTop: 6,
        background: 'var(--bg-card, #1e1e2e)',
        border: '1px solid var(--border, #333)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        zIndex: 100,
        minWidth: 360,
        maxWidth: 520,
        maxHeight: 400,
        overflowY: 'auto' as const,
        padding: '4px 0',
    },
    taskGroupHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 14px',
        width: '100%',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        transition: 'background 0.15s',
        textAlign: 'left' as const,
    },
    taskDropdownRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 14px 5px 30px',
        fontSize: 12,
    },
    taskDropdownId: {
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--text-tertiary)',
        flexShrink: 0,
        minWidth: 60,
    },
    taskDropdownName: {
        flex: 1,
        overflow: 'hidden' as const,
        textOverflow: 'ellipsis' as const,
        whiteSpace: 'nowrap' as const,
        fontSize: 12,
        color: 'var(--text-primary)',
    },
    prDropdown: {
        position: 'absolute' as const,
        top: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        marginTop: 6,
        background: 'var(--bg-card, #1e1e2e)',
        border: '1px solid var(--border, #333)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        zIndex: 100,
        minWidth: 320,
        maxWidth: 480,
        maxHeight: 300,
        overflowY: 'auto' as const,
        padding: '4px 0',
    },
    prItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        textDecoration: 'none',
        color: 'var(--text-primary, #e0e0e0)',
        fontSize: 13,
        fontFamily: 'system-ui, sans-serif',
        borderRadius: 0,
        transition: 'background 0.15s',
    },
    prNumber: {
        fontFamily: 'var(--font-mono, monospace)',
        fontWeight: 700,
        color: 'var(--accent, #6366f1)',
        fontSize: 12,
        flexShrink: 0,
        minWidth: 60,
    },
    prTitle: {
        flex: 1,
        overflow: 'hidden' as const,
        textOverflow: 'ellipsis' as const,
        whiteSpace: 'nowrap' as const,
    },
    prAgent: {
        fontSize: 11,
        color: 'var(--text-tertiary, #888)',
        flexShrink: 0,
        fontStyle: 'italic' as const,
    },
};

/** Pill label/value styles reused by SimpleFloor for the QA, integrations, and ledger controls. */
export const statPillBarStyles = {
    statPill: styles.statPill,
    statLabel: styles.statLabel,
    statValue: styles.statValue,
};

export interface StatPillProps {
    label: string;
    value: string;
}

export function StatPill({ label, value }: StatPillProps) {
    return (
        <div style={styles.statPill}>
            <span style={styles.statLabel}>{label}</span>
            <span style={styles.statValue}>{value}</span>
        </div>
    );
}

StatPill.displayName = 'StatPill';

export interface PrPillProps {
    items: PullRequestWithAgentName[];
}

export function PrPill({ items }: PrPillProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const count = items.length;

    useEffect(() => {
        if (!open) return;
        function close(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    return (
        <div ref={ref} style={{ position: 'relative' }}>
            <div
                style={{ ...styles.statPill, cursor: count > 0 ? 'pointer' : 'default' }}
                onClick={() => { if (count > 0) setOpen(!open); }}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                aria-haspopup="true"
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && count > 0) { e.preventDefault(); setOpen(!open); } }}
            >
                <span style={styles.statLabel}>Open PRs</span>
                <span style={{ ...styles.statValue, ...(count > 0 ? { color: 'var(--accent, #6366f1)' } : {}) }}>
                    {count}
                    {count > 0 && <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.6 }}>&#9662;</span>}
                </span>
            </div>
            {open && items.length > 0 && (
                <div style={styles.prDropdown} role="menu">
                    {items.map((pr) => (
                        <a
                            key={pr.id}
                            href={getPrUrl(pr)}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={styles.prItem}
                            role="menuitem"
                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover, rgba(99,102,241,0.1))'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                        >
                            <span style={styles.prNumber}>#{pr.id}</span>
                            <span style={styles.prTitle}>{pr.title}</span>
                            <span style={styles.prAgent}>{pr.agentName}</span>
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}

PrPill.displayName = 'PrPill';

const TASK_STATUS_SORT: Record<string, number> = { in_progress: 0, pending: 1, failed: 2, completed: 3, complete: 3 };
const TASK_STATUS_DOT_COLORS: Record<string, string> = {
    pending: 'var(--text-tertiary)', in_progress: 'var(--info)', completed: 'var(--success)', complete: 'var(--success)', failed: 'var(--error)',
};
const TASK_CAT_COLORS: Record<string, { bg: string; fg: string }> = {
    Frontend: { bg: 'rgba(99,102,241,0.12)', fg: '#6366f1' },
    Api: { bg: 'rgba(16,185,129,0.12)', fg: '#10b981' },
    QA: { bg: 'rgba(245,158,11,0.12)', fg: '#f59e0b' },
    AzureDevOps: { bg: 'rgba(6,182,212,0.12)', fg: '#06b6d4' },
    UX: { bg: 'rgba(236,72,153,0.12)', fg: '#ec4899' },
};
const REQ_TYPE_DOT: Record<string, string> = { review: '#f59e0b', design: '#ec4899', build: '#ef4444' };
const REQ_TYPE_BADGE: Record<string, { bg: string; fg: string }> = {
    review: { bg: 'rgba(245,158,11,0.12)', fg: '#f59e0b' },
    design: { bg: 'rgba(236,72,153,0.12)', fg: '#ec4899' },
    build:  { bg: 'rgba(239,68,68,0.12)',  fg: '#ef4444' },
};
const REQ_TYPE_LABELS: Record<string, string> = { review: 'Review', design: 'Design', build: 'Build' };

export interface TasksPillProps {
    count: number;
    agentStatuses: Record<string, AgentStatus | null>;
    displayNames?: Record<string, string>;
    onSelectAgent: (agent: AgentProfile) => void;
}

export function TasksPill({ count, agentStatuses, displayNames = {}, onSelectAgent }: TasksPillProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        function close(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    const agentTasks: Array<{ agent: AgentProfile; tasks: Array<{ id: string; name: string; status: string; category?: string; agilityStatus?: string; hours?: number }>; requests: RequestItem[] }> = [];
    let totalItems = 0;
    for (const agent of AGENT_ROSTER) {
        const status = agentStatuses[agent.id];
        if (!status) continue;
        const activeTasks = (status.tasks ?? []).filter(t => {
            const ns = (t.status as string) === 'complete' ? 'completed' : t.status;
            return ns !== 'completed' && ns !== 'failed';
        });
        const openReqs = (status.requests ?? []).filter(r => r.status !== 'resolved');
        if (activeTasks.length === 0 && openReqs.length === 0) continue;
        const sorted = [...activeTasks].sort((a, b) => (TASK_STATUS_SORT[a.status] ?? 9) - (TASK_STATUS_SORT[b.status] ?? 9));
        agentTasks.push({ agent, tasks: sorted as Array<{ id: string; name: string; status: string; category?: string; agilityStatus?: string; hours?: number }>, requests: openReqs });
        totalItems += sorted.length + openReqs.length;
    }

    return (
        <div ref={ref} style={{ position: 'relative' }}>
            <div
                style={{ ...styles.statPill, cursor: totalItems > 0 ? 'pointer' : 'default' }}
                onClick={() => { if (totalItems > 0) setOpen(!open); }}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                aria-haspopup="true"
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && totalItems > 0) { e.preventDefault(); setOpen(!open); } }}
            >
                <span style={styles.statLabel}>Active work</span>
                <span style={{ ...styles.statValue, ...(count > 0 ? { color: 'var(--accent, #6366f1)' } : {}) }}>
                    {count}
                    {totalItems > 0 && <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.6 }}>&#9662;</span>}
                </span>
            </div>
            {open && totalItems > 0 && (
                <div style={styles.taskDropdown} role="menu">
                    {agentTasks.map(({ agent, tasks, requests }) => {
                        const itemCount = tasks.length + requests.length;
                        return (
                        <div key={agent.id}>
                            <button
                                onClick={() => { setOpen(false); onSelectAgent(agent); }}
                                style={styles.taskGroupHeader}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover, rgba(99,102,241,0.1))'; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                            >
                                <span style={{ width: 8, height: 8, borderRadius: '50%', background: agent.accentColor, flexShrink: 0 }} />
                                <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>
                                    {displayNames[agent.id] || agent.name}
                                </span>
                                <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{itemCount} item{itemCount !== 1 ? 's' : ''}</span>
                            </button>
                            {tasks.map((task) => {
                                const ns = (task.status as string) === 'complete' ? 'completed' : task.status;
                                const dotColor = TASK_STATUS_DOT_COLORS[ns] ?? 'var(--text-tertiary)';
                                const catColors = task.category ? (TASK_CAT_COLORS[task.category] ?? { bg: 'rgba(120,113,108,0.12)', fg: '#78716c' }) : null;
                                const isDone = ns === 'completed' || ns === 'failed';
                                return (
                                    <div key={task.id} style={{ ...styles.taskDropdownRow, opacity: isDone ? 0.5 : 1 }}>
                                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                                        <span style={styles.taskDropdownId}>{task.id}</span>
                                        <span style={styles.taskDropdownName}>{task.name}</span>
                                        {catColors && (
                                            <span style={{ fontSize: 8, fontFamily: 'var(--font-mono)', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', padding: '1px 6px', borderRadius: 6, background: catColors.bg, color: catColors.fg, flexShrink: 0 }}>
                                                {task.category}
                                            </span>
                                        )}
                                    </div>
                                );
                            })}
                            {requests.map((req) => {
                                const dotColor = REQ_TYPE_DOT[req.type] ?? '#f59e0b';
                                const badge = REQ_TYPE_BADGE[req.type] ?? REQ_TYPE_BADGE.review;
                                const isResolved = req.status === 'resolved';
                                return (
                                    <div key={req.id} style={{ ...styles.taskDropdownRow, opacity: isResolved ? 0.5 : 1 }}>
                                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                                        <span style={{ ...styles.taskDropdownId, color: badge.fg }}>{req.id}</span>
                                        <span style={styles.taskDropdownName}>{req.summary}</span>
                                        <span style={{ fontSize: 8, fontFamily: 'var(--font-mono)', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', padding: '1px 6px', borderRadius: 6, background: badge.bg, color: badge.fg, flexShrink: 0 }}>
                                            {REQ_TYPE_LABELS[req.type] ?? req.type}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

TasksPill.displayName = 'TasksPill';
