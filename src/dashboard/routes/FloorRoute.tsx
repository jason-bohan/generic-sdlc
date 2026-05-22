import { useNavigate } from '@tanstack/react-router';
import SimpleFloor from '../SimpleFloor';
import { useDashboard } from '../DashboardContext';
import { AGENT_ROSTER } from '../types';
import type { AgentProfile } from '../types';

export function FloorRoute() {
    const navigate = useNavigate();
    const {
        statuses,
        displayNames,
        setDisplayNames,
        fetchStatusForAgent,
        notifications,
        setHistoryOpen,
        setChatAgent,
        setStoryPickerAgent,
        externalMode,
        setExternalMode,
        worktreeInfo,
        pendingMessageCounts,
        setTestRunnerOpen,
    } = useDashboard();

    const handleSelectAgent = (agent: AgentProfile) => {
        if (agent.active) void navigate({ to: '/desk/$agentId', params: { agentId: agent.id } });
    };

    const handleRefresh = () => {
        for (const agent of AGENT_ROSTER.filter(a => a.active)) {
            void fetchStatusForAgent(agent);
        }
    };

    const floorProps = {
        agentStatuses: statuses,
        displayNames,
        onDisplayNamesChange: setDisplayNames,
        onSelectAgent: handleSelectAgent,
        onChatWith: setChatAgent,
        onPickUpStory: setStoryPickerAgent,
        onRefreshStatus: handleRefresh,
        notificationCount: notifications.filter(n => !n.dismissed).length,
        onToggleNotifications: () => setHistoryOpen(o => !o),
        pendingMessageCounts,
        externalMode,
        onToggleTestRunner: () => setTestRunnerOpen(o => !o),
        onSetExternalMode: setExternalMode,
        onOpenLocalBacklog: () => void navigate({ to: '/backlog' }),
        worktreeBranch: worktreeInfo ? (worktreeInfo.isWorktree ? worktreeInfo.branch : 'Main/Prod') : null,
        isWorktree: worktreeInfo?.isWorktree ?? false,
        worktreeHue: worktreeInfo?.accentHue,
    };

    return <SimpleFloor {...floorProps} />;
}
