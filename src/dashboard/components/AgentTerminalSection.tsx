import { useState, useCallback, type CSSProperties } from 'react';
import { AgentTerminal } from './AgentTerminal';
import type { AgentProfile, AgentStatus } from '../types';

interface AgentTerminalSectionProps {
    agentRoster: AgentProfile[];
    agentStatuses: Record<string, AgentStatus | null>;
}

export function AgentTerminalSection({ agentRoster, agentStatuses }: AgentTerminalSectionProps) {
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(agentRoster.map(a => a.id)));

    const toggle = useCallback((id: string) => {
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const allCollapsed = collapsed.size === agentRoster.length;
    const toggleAll = useCallback(() => {
        setCollapsed(allCollapsed ? new Set() : new Set(agentRoster.map(a => a.id)));
    }, [allCollapsed, agentRoster]);

    return (
        <div style={styles.section}>
            <div style={styles.header}>
                <span style={styles.label}>Agent Terminals</span>
                <button style={styles.toggleAll} onClick={toggleAll}>
                    {allCollapsed ? 'Expand all' : 'Collapse all'}
                </button>
            </div>
            <div style={styles.list}>
                {agentRoster.map(a => (
                    <AgentTerminal
                        key={a.id}
                        agentId={a.id}
                        active={!!agentStatuses[a.id]?.isRunning}
                        collapsed={collapsed.has(a.id)}
                        onToggleCollapse={() => toggle(a.id)}
                    />
                ))}
            </div>
        </div>
    );
}

AgentTerminalSection.displayName = 'AgentTerminalSection';

const styles: Record<string, CSSProperties> = {
    section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '0 16px 16px',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    label: {
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase' as const,
        letterSpacing: 1,
    },
    toggleAll: {
        background: 'none',
        border: '1px solid var(--border)',
        borderRadius: 4,
        color: 'var(--text-tertiary)',
        fontSize: 11,
        cursor: 'pointer',
        padding: '2px 8px',
    },
    list: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
    },
};
