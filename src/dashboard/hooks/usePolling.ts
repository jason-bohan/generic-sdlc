import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AgentProfile, AgentStatus, ChatMessage, Phase } from '../types';
import { AGENT_ROSTER } from '../types';
import { PHASE_LABELS } from '../phase-labels';
import type { DashboardNotification } from '../NotificationToast';

const IS_TAURI = !!(typeof window !== 'undefined' && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const POLL_INTERVAL = 2000;
const AGILITY_SYNC_INTERVAL = 30_000;

/** @deprecated Use TanStack Router routes instead of this union. Kept only if referenced externally. */
export type AppView = { kind: 'floor' } | { kind: 'desk'; agent: AgentProfile } | { kind: 'local-backlog' };

function formatDuration(startedAt: string | null): string {
    if (!startedAt) return '--';
    const diff = Date.now() - new Date(startedAt).getTime();
    const mins = Math.floor(diff / 60_000);
    const secs = Math.floor((diff % 60_000) / 1000);
    if (mins > 60) {
        const hrs = Math.floor(mins / 60);
        return `${hrs}h ${mins % 60}m`;
    }
    return `${mins}m ${secs}s`;
}

export function useDashboardBootstrapFetch(
    setDisplayNames: Dispatch<SetStateAction<Record<string, string>>>,
    setExternalMode: Dispatch<SetStateAction<string>>,
): void {
    useEffect(() => {
        fetch('/api/agent/display-names')
            .then((r) => r.json())
            .then((d: { displayNames?: Record<string, string> }) => {
                if (d.displayNames) setDisplayNames(d.displayNames);
            })
            .catch(() => {});
        fetch('/api/external-mode')
            .then((r) => r.json())
            .then((d: { mode?: string }) => {
                if (d.mode) setExternalMode(d.mode);
            })
            .catch(() => {});
    }, [setDisplayNames, setExternalMode]);
}

export function useAgentStatusPolling(fetchStatusForAgent: (agent: AgentProfile) => Promise<void>): void {
    useEffect(() => {
        const activeAgents = AGENT_ROSTER.filter((a) => a.active);

        for (const agent of activeAgents) {
            void fetchStatusForAgent(agent);
        }
        const id = setInterval(() => {
            for (const agent of activeAgents) {
                void fetchStatusForAgent(agent);
            }
        }, POLL_INTERVAL);
        return () => clearInterval(id);
    }, [fetchStatusForAgent]);
}

export function useAgilityTaskSync(statuses: Record<string, AgentStatus | null>): void {
    useEffect(() => {
        const syncTasks = async () => {
            for (const [agentId, status] of Object.entries(statuses)) {
                if (!status?.storyNumber) continue;
                const phase = status.currentPhase;
                if (phase === 'idle' || phase === 'complete') continue;
                try {
                    await fetch('/api/agility/tasks/sync', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ agentId, storyNumber: status.storyNumber }),
                    });
                } catch {
                    /* silent */
                }
            }
        };
        const id = setInterval(syncTasks, AGILITY_SYNC_INTERVAL);
        return () => clearInterval(id);
    }, [statuses]);
}

export function useTauriStatusNotifications(
    statuses: Record<string, AgentStatus | null>,
    notifiedEvents: MutableRefObject<Set<string>>,
): void {
    useEffect(() => {
        if (!IS_TAURI) return;

        const allStatuses = Object.values(statuses);
        const triggerNotification = async (title: string, body: string) => {
            try {
                const { isPermissionGranted, requestPermission, sendNotification } =
                    await import('@tauri-apps/plugin-notification');
                let granted = await isPermissionGranted();
                if (!granted) granted = (await requestPermission()) === 'granted';
                if (granted) sendNotification({ title, body });
            } catch {
                /* unavailable */
            }
        };

        for (const status of allStatuses) {
            if (!status) continue;
            for (const event of status.events) {
                const key = `${event.timestamp}:${event.message}`;
                if (notifiedEvents.current.has(key)) continue;
                notifiedEvents.current.add(key);

                if (event.type === 'error') triggerNotification('Agent Error', event.message);
                else if (event.message.toLowerCase().includes('pr reviewed') || event.message.toLowerCase().includes('pr approved'))
                    triggerNotification('PR Update', event.message);
                else if (event.message.toLowerCase().includes('cypress') && event.type === 'warning')
                    triggerNotification('Cypress Failure', event.message);
                else if (event.message.toLowerCase().includes('task complete'))
                    triggerNotification('Task Complete', event.message);
            }
        }
    }, [statuses, notifiedEvents]);
}

export function usePhaseTransitionNotifications(
    statuses: Record<string, AgentStatus | null>,
    prevPhases: MutableRefObject<Record<string, Phase>>,
    resolveAgentName: (agentId: string) => string,
    setNotifications: Dispatch<SetStateAction<DashboardNotification[]>>,
): void {
    useEffect(() => {
        for (const agent of AGENT_ROSTER) {
            const status = statuses[agent.id];
            if (!status) continue;
            const currentPhase = status.currentPhase;
            const prevPhase = prevPhases.current[agent.id];

            if (prevPhase !== undefined && prevPhase !== currentPhase) {
                const notifType =
                    currentPhase === 'error' ? 'error' : currentPhase === 'complete' ? 'success' : 'info';
                const n: DashboardNotification = {
                    id: `phase-${agent.id}-${Date.now()}`,
                    timestamp: new Date().toISOString(),
                    type: notifType,
                    title: `Phase: ${PHASE_LABELS[currentPhase] ?? currentPhase}`,
                    message: `${resolveAgentName(agent.id)} moved from ${PHASE_LABELS[prevPhase] ?? prevPhase} to ${PHASE_LABELS[currentPhase] ?? currentPhase}`,
                    agentName: resolveAgentName(agent.id),
                };
                setNotifications((prev) => [...prev, n]);
            }
            prevPhases.current[agent.id] = currentPhase;
        }
    }, [statuses, resolveAgentName, setNotifications, prevPhases]);
}


export function useChatMessagePolling(
    chatAgent: AgentProfile | null,
    setChatMessages: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>,
): void {
    useEffect(() => {
        if (!chatAgent) return;
        const agentId = chatAgent.id;

        async function pollMessages() {
            try {
                let messages: ChatMessage[] = [];
                if (IS_TAURI) {
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        const raw = await invoke<string>('read_agent_messages', { agentId });
                        messages = JSON.parse(raw);
                    } catch {
                        const res = await fetch(`/api/chat/messages?agentId=${agentId}`);
                        if (res.ok) messages = await res.json();
                    }
                } else {
                    const res = await fetch(`/api/chat/messages?agentId=${agentId}`);
                    if (res.ok) messages = await res.json();
                }

                if (messages.length > 0) {
                    setChatMessages((prev) => {
                        const existing = prev[agentId] ?? [];
                        const existingIds = new Set(existing.map((m) => m.id));
                        const newMsgs = messages.filter((m) => !existingIds.has(m.id));
                        if (newMsgs.length === 0) return prev;
                        return { ...prev, [agentId]: [...existing, ...newMsgs] };
                    });
                }
            } catch {
                /* silent */
            }
        }

        void pollMessages();
        const id = setInterval(pollMessages, POLL_INTERVAL);
        return () => clearInterval(id);
    }, [chatAgent, setChatMessages]);
}
