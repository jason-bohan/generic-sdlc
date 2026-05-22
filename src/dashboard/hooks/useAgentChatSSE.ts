import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../types';
import type { Dispatch, SetStateAction } from 'react';

const POLL_INTERVAL = 3000;
const RECONNECT_DELAY = 5000;

interface ChatMessageEvent {
    agentId: string;
    message: {
        id: string;
        from: string;
        message: string;
        timestamp: string;
        status?: string;
    };
}

function toChatMessage(agentId: string, m: ChatMessageEvent['message']): ChatMessage {
    return { id: m.id, agentId, from: m.from, message: m.message, timestamp: m.timestamp, status: m.status as ChatMessage['status'] };
}

/**
 * Replaces useChatMessagePolling. Opens an SSE connection to /api/chat/stream
 * for the active chat agent. The server seeds recent history on connect and
 * pushes new messages as they arrive. Falls back to polling on error.
 */
export function useAgentChatSSE(
    chatAgentId: string | null,
    setChatMessages: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>,
): void {
    const setRef = useRef(setChatMessages);
    setRef.current = setChatMessages;

    useEffect(() => {
        if (!chatAgentId) return;
        const agentId = chatAgentId;

        let es: EventSource | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let closed = false;
        const seenIds = new Set<string>();

        function merge(msgs: ChatMessage[]) {
            const fresh = msgs.filter((m) => !seenIds.has(m.id));
            if (fresh.length === 0) return;
            for (const m of fresh) seenIds.add(m.id);
            setRef.current((prev) => {
                const existing = prev[agentId] ?? [];
                const existingIds = new Set(existing.map((m) => m.id));
                const unique = fresh.filter((m) => !existingIds.has(m.id));
                if (unique.length === 0) return prev;
                return { ...prev, [agentId]: [...existing, ...unique] };
            });
        }

        function startPolling() {
            if (pollTimer) return;
            pollTimer = setInterval(async () => {
                try {
                    const res = await fetch(`/api/chat/messages?agentId=${agentId}`);
                    if (res.ok) {
                        const rows = await res.json() as Array<{ id: string; from: string; message: string; timestamp: string; status?: string }>;
                        merge(rows.map((r) => toChatMessage(agentId, r)));
                    }
                } catch { /* silent */ }
            }, POLL_INTERVAL);
        }

        function stopPolling() {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }

        function connect() {
            if (closed) return;
            try {
                es = new EventSource(`/api/chat/stream?agentId=${agentId}`);

                es.onmessage = (e) => {
                    try {
                        const ev = JSON.parse(e.data) as ChatMessageEvent;
                        if (ev.agentId === agentId && ev.message) {
                            merge([toChatMessage(agentId, ev.message)]);
                        }
                    } catch { /* malformed */ }
                };

                es.onopen = () => stopPolling();

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

        connect();

        return () => {
            closed = true;
            es?.close();
            stopPolling();
            if (reconnectTimer) clearTimeout(reconnectTimer);
        };
    }, [chatAgentId]);
}
