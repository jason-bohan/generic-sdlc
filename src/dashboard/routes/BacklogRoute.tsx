import { useNavigate } from '@tanstack/react-router';
import LocalBacklogView from '../LocalBacklogView';
import { useDashboard } from '../DashboardContext';
import { AGENT_ROSTER } from '../types';

export function BacklogRoute() {
    const navigate = useNavigate();
    const { fetchStatusForAgent, setNotifications, resolveAgentName } = useDashboard();

    return (
        <LocalBacklogView
            onBack={() => void navigate({ to: '/' })}
            onAssigned={(agent) => {
                void navigate({ to: '/' });
                void fetchStatusForAgent(agent);
                setNotifications(prev => [...prev, {
                    id: `assign-${Date.now()}`,
                    timestamp: new Date().toISOString(),
                    type: 'warning' as const,
                    title: `${resolveAgentName(agent.id)}: Story Assigned — Next Step`,
                    message: `Approve the workflow, then open a new Cursor agent window and say "start ${agent.id}" or run:  agent "start ${agent.id}"`,
                }]);
                const roster = AGENT_ROSTER.find(a => a.id === agent.id);
                if (roster) void fetchStatusForAgent(roster);
            }}
        />
    );
}
