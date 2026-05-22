import { createHashHistory, createRoute, createRootRoute, createRouter, Outlet } from '@tanstack/react-router';
import { useNavigate } from '@tanstack/react-router';
import { DashboardProvider, useDashboard } from './DashboardContext';
import { FloorRoute } from './routes/FloorRoute';
import { DeskRoute } from './routes/DeskRoute';
import { BacklogRoute } from './routes/BacklogRoute';
import ChatPanel from './ChatPanel';
import StoryPicker from './StoryPicker';
import TestRunner from './TestRunner';
import HelpChat from './HelpChat';
import { NotificationToast } from './NotificationToast';
import { NotificationHistory } from './NotificationHistory';
import { SettingsPanel } from './SettingsPanel';
import { AGENT_ROSTER } from './types';
import { appShellStyles as s } from './app-shell-styles';

function RootLayout() {
    return (
        <DashboardProvider>
            <RootLayoutShell />
        </DashboardProvider>
    );
}

function RootLayoutShell() {
    const navigate = useNavigate();
    const {
        statuses,
        fetchStatusForAgent,
        notifications,
        dismissNotification,
        clearNotifications,
        chatAgent,
        setChatAgent,
        chatMessages,
        handleSendChat,
        markChatRead,
        storyPickerAgent,
        setStoryPickerAgent,
        historyOpen,
        setHistoryOpen,
        settingsOpen,
        setSettingsOpen,
        testRunnerOpen,
        setTestRunnerOpen,
        displayNames,
        externalMode,
        resolveAgentName,
        setNotifications,
    } = useDashboard();

    return (
        <div style={s.appShell}>
            <button
                style={s.settingsCog}
                onClick={() => setSettingsOpen(o => !o)}
                title="Settings"
                aria-label="Settings"
                data-testid="app-settings-btn"
            >
                &#x2699;
            </button>
            <button
                style={{ ...s.settingsCog, right: 52 }}
                onClick={() => void navigate({ to: '/backlog' })}
                title="Local Backlog"
                aria-label="Local Backlog"
                data-testid="app-local-backlog-btn"
            >
                &#x2261;
            </button>
            <a
                style={{ ...s.settingsCog, right: 92, textDecoration: 'none' }}
                href="/api/meeting-agent/messages"
                target="_blank"
                rel="noopener noreferrer"
                title="Meeting Agent Demo"
                aria-label="Meeting Agent Demo"
                data-testid="app-meeting-agent-btn"
            >
                &#x270E;
            </a>
            <div style={s.mainContent}>
                <Outlet />
            </div>

            {chatAgent && (
                <ChatPanel
                    agent={chatAgent}
                    displayName={displayNames[chatAgent.id]}
                    messages={chatMessages[chatAgent.id] ?? []}
                    chatCapability={statuses[chatAgent.id]?.chatCapability}
                    agentModel={statuses[chatAgent.id]?.model}
                    onSend={handleSendChat}
                    onClose={() => setChatAgent(null)}
                    onMarkRead={() => markChatRead(chatAgent.id)}
                />
            )}

            {storyPickerAgent && (
                <StoryPicker
                    agentId={storyPickerAgent.id}
                    agentName={resolveAgentName(storyPickerAgent.id)}
                    onClose={() => setStoryPickerAgent(null)}
                    onAssigned={() => {
                        const agentName = resolveAgentName(storyPickerAgent.id);
                        const agentId = storyPickerAgent.id;
                        setStoryPickerAgent(null);
                        const agent = AGENT_ROSTER.find(a => a.id === agentId);
                        if (agent) void fetchStatusForAgent(agent);
                        setNotifications(prev => [...prev, {
                            id: `assign-${Date.now()}`,
                            timestamp: new Date().toISOString(),
                            type: 'warning' as const,
                            title: `${agentName}: Story Assigned — Next Step`,
                            message: `Approve the workflow, then open a new Cursor agent window and say "start ${agentId}" or run:  agent "start ${agentId}"`,
                        }]);
                    }}
                />
            )}

            {testRunnerOpen && externalMode === 'mock' && (
                <TestRunner onClose={() => setTestRunnerOpen(false)} />
            )}

            <HelpChat />
            <NotificationToast notifications={notifications} onDismiss={dismissNotification} />
            <NotificationHistory
                notifications={notifications}
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                onClear={clearNotifications}
            />
            <SettingsPanel
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                onRefreshAgents={() => {
                    for (const agent of AGENT_ROSTER.filter(a => a.active)) {
                        void fetchStatusForAgent(agent);
                    }
                }}
            />
        </div>
    );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: FloorRoute,
});

const deskRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/desk/$agentId',
    component: DeskRoute,
});

const backlogRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/backlog',
    component: BacklogRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, deskRoute, backlogRoute]);

export const router = createRouter({
    routeTree,
    history: createHashHistory(),
});

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}
