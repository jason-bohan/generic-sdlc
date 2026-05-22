import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import SimpleFloor from '../SimpleFloor';
import { useTheme } from '../ThemeProvider';
import { useDashboard } from '../DashboardContext';
import { AGENT_ROSTER } from '../types';
import type { AgentProfile } from '../types';
import { appShellStyles as s } from '../app-shell-styles';

const Floor3D = lazy(() => import('../floor3d/Floor3D'));

export function FloorRoute() {
    const navigate = useNavigate();
    const { current: theme } = useTheme();
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

    if (theme.id === 'simple') {
        return <SimpleFloor {...floorProps} />;
    }

    return (
        <Suspense fallback={<div style={s.loading}><p style={s.loadingText}>Loading 3D floor…</p></div>}>
            <Floor3D {...floorProps} />
        </Suspense>
    );
}
