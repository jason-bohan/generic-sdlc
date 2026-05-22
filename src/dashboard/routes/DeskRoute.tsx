import { useParams, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import AgentDetail from '../AgentDetail';
import { useDashboard } from '../DashboardContext';
import { AGENT_ROSTER } from '../types';
import { appShellStyles as s } from '../app-shell-styles';

function formatDuration(startedAt: string | null): string {
    if (!startedAt) return '--';
    const diff = Date.now() - new Date(startedAt).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins > 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${mins}m ${Math.floor((diff % 60_000) / 1000)}s`;
}

export function DeskRoute() {
    const { agentId } = useParams({ from: '/desk/$agentId' });
    const navigate = useNavigate();
    const { statuses, fetchStatusForAgent, displayNames, setChatAgent, setStoryPickerAgent, chatMessages } = useDashboard();
    const [elapsed, setElapsed] = useState('--');

    const agent = AGENT_ROSTER.find(a => a.id === agentId);
    const agentStatus = agentId ? statuses[agentId] : null;

    useEffect(() => {
        if (!agentStatus?.startedAt) return;
        const id = setInterval(() => setElapsed(formatDuration(agentStatus.startedAt)), 1000);
        setElapsed(formatDuration(agentStatus.startedAt));
        return () => clearInterval(id);
    }, [agentStatus?.startedAt]);

    const goBack = () => void navigate({ to: '/' });

    if (!agent) {
        return (
            <div style={s.loading}>
                <button style={s.backBtnLoading} onClick={goBack}>&larr; Back to The Floor</button>
                <p style={s.loadingText}>Unknown agent: {agentId}</p>
            </div>
        );
    }

    if (!agentStatus) {
        return (
            <div style={s.loading}>
                <button style={s.backBtnLoading} onClick={goBack}>&larr; Back to The Floor</button>
                <p style={s.loadingText}>Waiting for {displayNames[agentId] ?? agent.name} to report status…</p>
            </div>
        );
    }

    const agentMessages = chatMessages[agentId] ?? [];
    const pendingCount = agentMessages.filter(m => m.from === 'user' && (!m.status || m.status === 'pending')).length;

    return (
        <AgentDetail
            agent={agent}
            displayName={displayNames[agentId]}
            agentDisplayNameOverrides={displayNames}
            status={agentStatus}
            elapsed={elapsed}
            onBack={goBack}
            onChat={() => setChatAgent(agent)}
            onPickUpStory={() => setStoryPickerAgent(agent)}
            onReviewerDeskChanged={() => { void fetchStatusForAgent(agent); }}
            pendingMessages={pendingCount}
        />
    );
}
