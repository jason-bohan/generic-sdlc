import { useEffect, useRef } from 'react';
import type { AgentStatus, AgentProfile } from '../types';
import { AGENT_ROSTER } from '../types';

const POLL_INTERVAL = 3000;
const RECONNECT_DELAY = 5000;

interface StatusEvent {
    agentId: string;
    status: AgentStatus;
    timestamp: string;
}

/**
 * Replaces useAgentStatusPolling with an SSE-based approach.
 * Opens a single EventSource for all agents and falls back to polling if SSE is unavailable.
 */
export function useAgentStatusSSE(
    updateAgentStatus: (agentId: string, data: AgentStatus) => void,
): void {
    const updateRef = useRef(updateAgentStatus);
    updateRef.current = updateAgentStatus;

    useEffect(() => {
        let es: EventSource | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let closed = false;

        function startPolling() {
            if (pollTimer) return;
            const activeAgents = AGENT_ROSTER.filter((a) => a.active);
            pollTimer = setInterval(async () => {
                for (const agent of activeAgents) {
                    try {
                        const res = await fetch(`/api/status?agentId=${agent.id}`);
                        if (res.ok) updateRef.current(agent.id, await res.json());
                    } catch { /* silent */ }
                }
            }, POLL_INTERVAL);
        }

        function stopPolling() {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }

        async function initialFetch() {
            const activeAgents = AGENT_ROSTER.filter((a: AgentProfile) => a.active);
            await Promise.allSettled(activeAgents.map(async (agent) => {
                try {
                    const res = await fetch(`/api/status?agentId=${agent.id}`);
                    if (res.ok) updateRef.current(agent.id, await res.json());
                } catch { /* silent */ }
            }));
        }

        function connect() {
            if (closed) return;
            try {
                es = new EventSource('/api/status/stream?agentId=all');

                es.onmessage = (e) => {
                    try {
                        const ev = JSON.parse(e.data) as StatusEvent;
                        if (ev.agentId && ev.status) updateRef.current(ev.agentId, ev.status);
                    } catch { /* malformed event */ }
                };

                es.onopen = () => {
                    stopPolling();
                };

                es.onerror = () => {
                    es?.close();
                    es = null;
                    startPolling();
                    if (!closed) {
                        reconnectTimer = setTimeout(() => {
                            stopPolling();
                            connect();
                        }, RECONNECT_DELAY);
                    }
                };
            } catch {
                startPolling();
            }
        }

        void initialFetch().then(connect);

        return () => {
            closed = true;
            es?.close();
            stopPolling();
            if (reconnectTimer) clearTimeout(reconnectTimer);
        };
    }, []);
}
