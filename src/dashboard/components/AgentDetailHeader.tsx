import type { AgentProfile, AgentStatus } from '../types';
import { AGENT_ROSTER } from '../types';
import { PHASE_LABELS_DESK as PHASE_LABELS, PHASE_COLORS } from '../phase-labels';
import { agentDetailStyles as s } from './AgentDetail.styles';

export interface AgentDetailHeaderProps {
    agent: AgentProfile;
    shownName: string;
    status: AgentStatus;
    pendingMessages: number;
    onBack: () => void;
    onChat?: () => void;
    onPickUpStory?: () => void;
    toggleStepMode: () => Promise<void>;
    handleContinue: () => Promise<unknown>;
    continuing: boolean;
    effectiveStepMode: boolean;
    isPausedAtStep: boolean;
    globalStepMode: boolean;
    totalSelected: number;
}

export function AgentDetailHeader({
    agent,
    shownName,
    status,
    pendingMessages,
    onBack,
    onChat,
    onPickUpStory,
    toggleStepMode,
    handleContinue,
    continuing,
    effectiveStepMode,
    isPausedAtStep,
    globalStepMode,
    totalSelected,
}: AgentDetailHeaderProps) {
    return (
        <header style={s.header}>
            <div style={s.headerLeft}>
                <button style={s.backBtn} onClick={onBack} aria-label="Back to floor">&larr;</button>
                <div
                    style={{
                        ...s.miniAvatar,
                        background: `linear-gradient(135deg, ${agent.accentColor}, ${agent.accentColor}88)`,
                    }}
                >
                    <span style={s.miniAvatarLetter}>{agent.avatar}</span>
                </div>
                <h1 style={s.title}>
                    <span style={{ color: agent.accentColor }}>{shownName.slice(0, 3)}</span>
                    {shownName.slice(3)}
                </h1>
                <span style={s.subtitle}>{agent.title}</span>
            </div>
            <div style={s.headerRight}>
                {status.currentPhase === 'pending-approval' && (
                    <button
                        style={{ ...s.pickupBtn, borderColor: 'var(--warning)', color: 'var(--warning)', fontWeight: 700 }}
                        onClick={async () => {
                            try {
                                const res = await fetch(`${window.location.origin}/api/scheduler/approve`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ agentId: agent.id }),
                                });
                                if (!res.ok) {
                                    const err = await res.json().catch(() => ({}));
                                    alert(`Approve failed: ${(err as { error?: string }).error || res.statusText}`);
                                }
                            } catch (e: unknown) {
                                alert(`Approve failed: ${e instanceof Error ? e.message : String(e)}`);
                            }
                        }}
                    >
                        Approve Start
                    </button>
                )}
                {onPickUpStory && (status.currentPhase === 'idle' || status.currentPhase === 'complete') && (
                    <button style={{ ...s.pickupBtn, borderColor: agent.accentColor, color: agent.accentColor }} onClick={onPickUpStory}>
                        Pick Up Story
                    </button>
                )}
                {onChat && (
                    <button
                        style={{
                            ...s.btwBtn,
                            color: status.chatCapability === 'unavailable' ? '#e879a0' : agent.accentColor,
                            borderColor: status.chatCapability === 'unavailable' ? '#e879a044' : `${agent.accentColor}44`,
                            position: 'relative' as const,
                            ...(status.chatCapability === 'unavailable' ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
                        }}
                        onClick={status.chatCapability === 'unavailable' ? undefined : onChat}
                        disabled={status.chatCapability === 'unavailable'}
                        title={status.chatCapability === 'unavailable'
                            ? 'This agent can\'t receive messages right now'
                            : status.chatCapability === 'live'
                                ? 'Live session - real-time responses'
                                : 'Auto-reply - simulated response'}
                    >
                        {status.chatCapability === 'live' && (
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block', marginRight: 4, verticalAlign: 'middle' }} />
                        )}
                        /btw
                        {pendingMessages > 0 && status.chatCapability !== 'unavailable' && (
                            <span style={s.pendingBadge}>{pendingMessages}</span>
                        )}
                    </button>
                )}
                <div style={s.stepModeGroup}>
                    <label style={s.stepToggleLabel} title={globalStepMode ? 'Global step mode is active' : 'Toggle step mode for this agent'}>
                        <span style={{ ...s.stepToggleLabelText, opacity: globalStepMode ? 0.5 : 1 }}>Step{globalStepMode ? ' (global)' : ''}</span>
                        <button
                            type="button"
                            onClick={globalStepMode ? undefined : () => { void toggleStepMode(); }}
                            style={{
                                ...s.stepToggleTrack,
                                background: effectiveStepMode ? 'var(--accent)' : 'var(--bg-secondary)',
                                opacity: globalStepMode ? 0.5 : 1,
                                cursor: globalStepMode ? 'not-allowed' : 'pointer',
                            }}
                            aria-label="Toggle step mode"
                            disabled={globalStepMode}
                        >
                            <span style={{
                                ...s.stepToggleThumb,
                                transform: effectiveStepMode ? 'translateX(16px)' : 'translateX(1px)',
                            }} />
                        </button>
                    </label>
                    {isPausedAtStep && !status.isRunning ? (
                        <button
                            type="button"
                            style={s.nextStepBtn}
                            onClick={() => { void handleContinue().catch(() => {}); }}
                            disabled={continuing}
                            data-testid={`${agent.id}-resume-btn`}
                        >
                            {continuing ? 'Starting...' : totalSelected > 0 ? `Resume with ${totalSelected} item${totalSelected > 1 ? 's' : ''}` : 'Next Step'}
                        </button>
                    ) : !status.isRunning && status.storyNumber && status.currentPhase !== 'idle' && status.currentPhase !== 'complete' && (
                        <button
                            type="button"
                            style={s.resumeBtn}
                            onClick={() => { void handleContinue().catch(() => {}); }}
                            disabled={continuing}
                            data-testid={`${agent.id}-resume-btn`}
                        >
                            {continuing ? 'Starting...' : 'Resume'}
                        </button>
                    )}
                </div>
                {status.storyNumber && <span style={{ ...s.storyBadge, background: `${agent.accentColor}22`, color: agent.accentColor }}>{status.storyNumber}</span>}
                {status.collaborators && status.collaborators.length > 0 && (
                    <span style={s.collabBadge}>
                        {status.collaborators.map((cId) => {
                            const partner = AGENT_ROSTER.find((a) => a.id === cId);
                            return partner ? partner.name : cId;
                        }).join(', ')}
                    </span>
                )}
                <div
                    style={{
                        ...s.phaseBadge,
                        borderColor: PHASE_COLORS[status.currentPhase],
                        color: PHASE_COLORS[status.currentPhase],
                    }}
                >
                    {status.currentPhase !== 'idle' && status.currentPhase !== 'complete' && (
                        <span
                            style={{
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                background: PHASE_COLORS[status.currentPhase],
                                animation: 'pulse 1.5s ease-in-out infinite',
                            }}
                        />
                    )}
                    {PHASE_LABELS[status.currentPhase]}
                </div>
            </div>
        </header>
    );
}
AgentDetailHeader.displayName = 'AgentDetailHeader';
