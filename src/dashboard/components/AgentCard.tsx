import { type CSSProperties, useState, useEffect, useCallback, useRef } from 'react';
import type { AgentProfile, AgentStatus, Phase } from '../types';
import type { ModelOption } from '../hooks/useAgentModels';
import { PHASE_LABELS, getPhaseColor, isActivePhase, HARD_ACTIVE_PHASES, SOFT_ACTIVE_PHASES } from '../phase-labels';
import { agentCardStyles as styles } from './AgentCard.styles';
import { StoppedResumeChip } from './StoppedResumeChip';
import { QaResultsPanel } from './QaResultsPanel';

/** Phases where global step mode pauses agents at checkpoints. Shared with SimpleFloor for paused-agent counts. */
export const STEP_MODE_CHECKPOINT_PHASES: ReadonlySet<string> = new Set([
    'analyzing', 'generating-code', 'validating', 'creating-pr',
    'watching-reviews', 'addressing-feedback', 'running-cypress', 'running-tests',
    'pending-review', 'reviewing', 'commenting', 'approved', 'changes-requested',
    'pending-build', 'monitoring-build', 'build-passed', 'build-failed',
    'researching', 'designing', 'spec-ready', 'collaborating',
]);

function getStatusDotAnimation(phase: Phase): string | undefined {
    if (HARD_ACTIVE_PHASES.has(phase)) return 'pulse 1.5s ease-in-out infinite';
    if (SOFT_ACTIVE_PHASES.has(phase)) return 'slowFade 4s ease-in-out infinite';
    return undefined;
}

export interface AgentCardProps {
    agent: AgentProfile;
    displayName?: string;
    onRename?: (newName: string) => void;
    status: AgentStatus | null;
    onSelect: () => void;
    onChat: () => void;
    onPickUpStory?: () => void;
    onApprove?: () => void;
    availableModels: ModelOption[];
    globalStepMode?: boolean;
}

export function AgentCard({
    agent,
    displayName,
    onRename,
    status,
    onSelect,
    onChat,
    onPickUpStory,
    onApprove,
    availableModels,
    globalStepMode,
}: AgentCardProps) {
    const phase = status?.currentPhase ?? 'idle';
    const isWorking = isActivePhase(phase);
    const isInactive = !agent.active;
    const isPaused = !!globalStepMode && STEP_MODE_CHECKPOINT_PHASES.has(phase) && phase !== 'idle';
    const isStopped = isWorking && status?.isRunning === false && !!status?.storyNumber && !isPaused;

    const [model, setModel] = useState('auto');
    const [modelOpen, setModelOpen] = useState(false);
    const [modelFilter, setModelFilter] = useState('');
    const modelRef = useRef<HTMLDivElement>(null);
    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState('');

    const shownName = displayName || agent.name;

    useEffect(() => {
        fetch(`${window.location.origin}/api/agent/model/${agent.id}`)
            .then(r => r.json())
            .then(d => { if (d.model) setModel(d.model); })
            .catch(() => {});
    }, [agent.id]);

    useEffect(() => {
        if (!modelOpen) return;
        const handler = (e: MouseEvent) => {
            if (modelRef.current && !modelRef.current.contains(e.target as Node)) { setModelOpen(false); setModelFilter(''); }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [modelOpen]);

    const selectModel = useCallback((newModel: string) => {
        setModel(newModel);
        setModelOpen(false);
        setModelFilter('');
        fetch(`${window.location.origin}/api/agent/model`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: agent.id, model: newModel }),
        }).catch(() => {});
    }, [agent.id]);

    const modelLabel = availableModels?.find(m => m.id === model)?.label || 'Auto';
    const modelCategory = availableModels?.find(m => m.id === model)?.category || 'auto';

    const cardStyle: CSSProperties = {
        ...styles.card,
        opacity: isInactive ? 0.4 : 1,
        pointerEvents: isInactive ? 'none' : 'auto',
        borderLeft: isStopped ? '4px solid #ef4444' : isPaused ? '4px solid #f59e0b' : isWorking ? `4px solid ${agent.accentColor}` : '4px solid transparent',
    };

    return (
        <div
            style={cardStyle}
            role="article"
            aria-label={`${shownName} — ${PHASE_LABELS[phase]}`}
            data-testid={`simple-agent-card-${agent.id}`}
            tabIndex={isInactive ? -1 : 0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (agent.active) onSelect();
                }
            }}
        >
            <div style={styles.cardHeader}>
                <div style={styles.cardHeaderLeft}>
                    <div style={{ ...styles.cardAvatar, background: agent.accentColor, ...((phase === 'idle' || phase === 'complete') ? { opacity: 0.6 } : {}) }}>
                        {agent.avatar}
                    </div>
                    <div>
                        {editing ? (
                            <input
                                value={editValue}
                                onChange={e => setEditValue(e.target.value)}
                                onClick={e => e.stopPropagation()}
                                onBlur={() => {
                                    setEditing(false);
                                    if (editValue.trim() !== shownName) onRename?.(editValue);
                                }}
                                onKeyDown={e => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') { setEditing(false); if (editValue.trim() !== shownName) onRename?.(editValue); }
                                    if (e.key === 'Escape') { setEditing(false); setEditValue(shownName); }
                                }}
                                autoFocus
                                style={{ ...styles.cardName, background: 'var(--bg-secondary)', border: '1px solid var(--accent)', borderRadius: 4, padding: '1px 6px', outline: 'none', width: '100%' }}
                            />
                        ) : (
                            <div
                                style={{ ...styles.cardName, cursor: 'pointer' }}
                                onDoubleClick={() => { setEditValue(shownName); setEditing(true); }}
                                title="Double-click to rename"
                            >
                                {shownName}
                            </div>
                        )}
                        <div style={styles.cardRole}>{agent.title}</div>
                    </div>
                </div>
                <div style={styles.cardBadges}>
                    <span
                        style={{ ...styles.phaseBadge, color: isStopped ? '#ef4444' : isPaused ? '#f59e0b' : getPhaseColor(phase) }}
                        aria-live="polite"
                    >
                        <span style={{ ...styles.statusDot, background: isStopped ? '#ef4444' : isPaused ? '#f59e0b' : getPhaseColor(phase), ...(isStopped ? {} : isPaused ? { animation: 'pausePulse 2s ease-in-out infinite' } : getStatusDotAnimation(phase) ? { animation: getStatusDotAnimation(phase) } : {}) }} />
                        {PHASE_LABELS[phase]}
                    </span>
                    {isStopped && <StoppedResumeChip agentId={agent.id} />}
                    {isPaused && (
                        <span style={styles.pausedBadge} data-testid={`paused-badge-${agent.id}`}>
                            PAUSED
                        </span>
                    )}
                    {status?.storyNumber && (
                        <span style={styles.storyBadge}>{status.storyNumber}</span>
                    )}
                </div>
            </div>

            {status?.currentTask && (
                <div style={styles.taskRow}>
                    {status.currentTask}
                </div>
            )}

            {agent.active && availableModels && availableModels.length > 0 && (
                <div style={styles.modelRow} ref={modelRef}>
                    <button
                        onClick={() => { if (!isWorking) setModelOpen(o => !o); }}
                        disabled={isWorking}
                        style={{
                            ...styles.modelPill,
                            borderColor: modelCategory === 'cloud' ? 'var(--accent)' : modelCategory === 'local' ? 'var(--success)' : 'var(--border)',
                            color: modelCategory === 'cloud' ? 'var(--accent)' : modelCategory === 'local' ? 'var(--success)' : 'var(--text-secondary)',
                            ...(isWorking ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
                        }}
                        data-testid={`simple-agent-model-${agent.id}`}
                    >
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: modelCategory === 'cloud' ? 'var(--accent)' : modelCategory === 'local' ? 'var(--success)' : 'var(--text-secondary)', flexShrink: 0 }} />
                        {modelLabel}
                        {status?.chatCapability === 'live' && (
                            <span style={{ fontSize: 9, fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,0.12)', padding: '1px 5px', borderRadius: 4, marginLeft: 4 }} title="Live session - agent responds in real-time">LIVE</span>
                        )}
                        {status?.chatCapability === 'auto-reply' && (
                            <span style={{ fontSize: 9, fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.12)', padding: '1px 5px', borderRadius: 4, marginLeft: 4 }} title="Auto-reply - simulated response">AUTO</span>
                        )}
                        {status?.chatCapability === 'unavailable' && (
                            <span style={{ fontSize: 9, fontWeight: 700, color: '#e879a0', background: 'rgba(232,121,160,0.12)', padding: '1px 5px', borderRadius: 4, marginLeft: 4 }} title="Agent can't receive messages right now">OFF</span>
                        )}
                        <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 2 }}>{modelOpen ? '\u25B2' : '\u25BC'}</span>
                    </button>
                    {modelOpen && (
                        <div style={styles.modelPopup}>
                            <div style={styles.modelPopupArrow} />
                            <div style={{ padding: '6px 10px 4px' }}>
                                <input
                                    type="text"
                                    placeholder="Search models\u2026"
                                    value={modelFilter}
                                    onChange={e => setModelFilter(e.target.value)}
                                    autoFocus
                                    style={styles.modelSearch}
                                />
                            </div>
                            {(['auto', 'cloud', 'local'] as const).map(cat => {
                                const q = modelFilter.toLowerCase();
                                const items = availableModels.filter(m => m.category === cat && (!q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)));
                                if (!items.length) return null;
                                const catLabel = cat === 'auto' ? 'Default' : cat === 'cloud' ? 'Cloud' : 'Local';
                                return (
                                    <div key={cat}>
                                        <div style={styles.modelCatHeader}>{catLabel}</div>
                                        {items.map(m => {
                                            const tip = m.id === 'auto' ? 'Uses the default model for this agent'
                                                : m.id === 'local' ? 'Runs locally via Ollama - no cloud usage'
                                                : (m as any).tag === 'MAX' ? 'Highest capability - uses max-mode tokens'
                                                : m.id.includes('-xhigh') || m.label.includes('Extra High') ? 'Extended thinking with very high token budget'
                                                : m.id.includes('-high') || m.label.includes('High') ? 'Extended thinking with higher token budget'
                                                : 'Standard cloud model';
                                            return (
                                            <button
                                                key={m.id}
                                                onClick={() => { selectModel(m.id); setModelFilter(''); }}
                                                title={tip}
                                                style={{
                                                    ...styles.modelOption,
                                                    ...(m.id === model ? styles.modelOptionActive : {}),
                                                }}
                                            >
                                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: cat === 'cloud' ? 'var(--accent)' : cat === 'local' ? 'var(--success)' : 'var(--text-secondary)', flexShrink: 0 }} />
                                                {m.label}
                                                {(m as any).tag && <span style={{ fontSize: 9, fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.12)', padding: '1px 5px', borderRadius: 4, marginLeft: 4 }}>{(m as any).tag}</span>}
                                                {m.id === model && <span style={{ marginLeft: 'auto', fontSize: 11 }}>{'\u2713'}</span>}
                                            </button>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                            <div style={styles.modelManageRow}>
                                <span style={styles.modelManageHint}>
                                    Ctrl+Shift+P &rarr; &quot;Cursor Settings&quot; &rarr; Models
                                </span>
                            </div>
                            <div style={{ borderTop: '1px solid var(--border)', padding: '8px 10px 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>/btw Chat</div>
                                {([
                                    { key: 'live', dot: '#22c55e', icon: '\uD83D\uDDE8\uFE0F', label: 'Live', desc: 'Real-time responses' },
                                    { key: 'auto-reply', dot: '#f59e0b', icon: '\uD83E\uDD16', label: 'Auto-reply', desc: 'Simulated response' },
                                    { key: 'unavailable', dot: '#e879a0', icon: '\uD83D\uDEAB', label: 'Unavailable', desc: 'Can\'t receive' },
                                ] as const).map(tier => (
                                    <div key={tier.key} style={{
                                        display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
                                        opacity: status?.chatCapability === tier.key ? 1 : 0.5,
                                        fontWeight: status?.chatCapability === tier.key ? 700 : 400,
                                    }} title={`${tier.label}: ${tier.desc}`}>
                                        <span style={{ fontSize: 12, flexShrink: 0, lineHeight: 1 }}>{tier.icon}</span>
                                        <span style={{ color: tier.dot }}>{tier.label}</span>
                                        <span style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>{tier.desc}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {agent.role === 'qa' && <QaResultsPanel agentId={agent.id} storyNumber={status?.storyNumber} />}

            <div style={styles.cardActions}>
                <button style={styles.actionBtn} onClick={onSelect} data-testid={`simple-agent-open-${agent.id}`}>
                    Open Desk
                </button>
                {agent.active && (
                    <button
                        style={{
                            ...styles.actionBtn,
                            ...(status?.chatCapability === 'unavailable'
                                ? { opacity: 0.45, cursor: 'not-allowed', color: '#e879a0', borderColor: '#e879a044' }
                                : {}),
                        }}
                        onClick={status?.chatCapability === 'unavailable' ? undefined : onChat}
                        disabled={status?.chatCapability === 'unavailable'}
                        data-testid={`simple-agent-chat-${agent.id}`}
                        title={status?.chatCapability === 'unavailable'
                            ? 'This agent can\'t receive messages right now'
                            : status?.chatCapability === 'live'
                                ? 'Live session - agent will respond in real-time'
                                : 'Auto-reply - simulated response'}
                    >
                        /btw
                    </button>
                )}
                {onPickUpStory && (phase === 'idle' || phase === 'complete') && (
                    <button style={{ ...styles.actionBtn, ...styles.actionBtnPrimary }} onClick={onPickUpStory} data-testid={`simple-agent-assign-${agent.id}`}>
                        Pick Up Story
                    </button>
                )}
                {phase === 'pending-approval' && onApprove && (
                    <button style={{ ...styles.actionBtn, ...styles.actionBtnWarn }} onClick={onApprove} data-testid={`simple-agent-approve-${agent.id}`}>
                        Approve Start
                    </button>
                )}
                {isPaused && (
                    <button style={{ ...styles.actionBtn, ...styles.actionBtnPaused }} onClick={onSelect} data-testid={`simple-agent-review-${agent.id}`}>
                        Review & Continue
                    </button>
                )}
            </div>
        </div>
    );
}

AgentCard.displayName = 'AgentCard';
