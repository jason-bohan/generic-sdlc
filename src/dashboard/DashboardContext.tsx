import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState,
    useEffect,
    type ReactNode,
} from 'react';
import type { AgentStatus, AgentProfile, ChatMessage, Phase } from './types';
import { AGENT_ROSTER } from './types';
import type { DashboardNotification } from './NotificationToast';
import {
    useAgilityTaskSync,
    useDashboardBootstrapFetch,
    usePhaseTransitionNotifications,
    useTauriStatusNotifications,
} from './hooks/usePolling';
import { useAgentStatusSSE } from './hooks/useAgentStatusSSE';
import { useAgentChatSSE } from './hooks/useAgentChatSSE';
import { writeChatMessage } from './write-chat-message';

interface DashboardContextValue {
    // Agent statuses
    statuses: Record<string, AgentStatus | null>;
    fetchStatusForAgent: (agent: AgentProfile) => Promise<void>;
    // Config
    displayNames: Record<string, string>;
    setDisplayNames: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    externalMode: string;
    setExternalMode: React.Dispatch<React.SetStateAction<string>>;
    worktreeInfo: { isWorktree: boolean; branch: string; accentHue: number } | null;
    // Notifications
    notifications: DashboardNotification[];
    setNotifications: React.Dispatch<React.SetStateAction<DashboardNotification[]>>;
    dismissNotification: (id: string) => void;
    clearNotifications: () => void;
    // Chat
    chatMessages: Record<string, ChatMessage[]>;
    chatAgent: AgentProfile | null;
    setChatAgent: React.Dispatch<React.SetStateAction<AgentProfile | null>>;
    handleSendChat: (message: string) => void;
    markChatRead: (agentId: string) => void;
    pendingMessageCounts: Record<string, number>;
    // Story picker
    storyPickerAgent: AgentProfile | null;
    setStoryPickerAgent: React.Dispatch<React.SetStateAction<AgentProfile | null>>;
    // Overlay panels
    historyOpen: boolean;
    setHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>;
    settingsOpen: boolean;
    setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
    testRunnerOpen: boolean;
    setTestRunnerOpen: React.Dispatch<React.SetStateAction<boolean>>;
    // Utility
    resolveAgentName: (agentId: string) => string;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard(): DashboardContextValue {
    const ctx = useContext(DashboardContext);
    if (!ctx) throw new Error('useDashboard must be used inside DashboardProvider');
    return ctx;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
    const [statuses, setStatuses] = useState<Record<string, AgentStatus | null>>({});
    const [displayNames, setDisplayNames] = useState<Record<string, string>>({});
    const [externalMode, setExternalMode] = useState('live');
    const [worktreeInfo, setWorktreeInfo] = useState<{ isWorktree: boolean; branch: string; accentHue: number } | null>(null);
    const [notifications, setNotifications] = useState<DashboardNotification[]>([]);
    const [chatMessages, setChatMessages] = useState<Record<string, ChatMessage[]>>({});
    const [chatAgent, setChatAgent] = useState<AgentProfile | null>(null);
    const [storyPickerAgent, setStoryPickerAgent] = useState<AgentProfile | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [testRunnerOpen, setTestRunnerOpen] = useState(false);
    const notifiedEvents = useRef(new Set<string>());
    const prevPhases = useRef<Record<string, Phase>>({});

    useDashboardBootstrapFetch(setDisplayNames, setExternalMode);

    useEffect(() => {
        fetch('/api/worktree-info')
            .then(r => r.json())
            .then((info: { isWorktree: boolean; branch: string; accentHue: number }) => {
                setWorktreeInfo(info);
                if (info.isWorktree) {
                    const root = document.documentElement;
                    root.style.setProperty('--accent', `hsl(${info.accentHue}, 70%, 45%)`);
                    root.style.setProperty('--accent-dim', `hsla(${info.accentHue}, 70%, 45%, 0.1)`);
                }
            })
            .catch(() => {});
    }, []);

    const resolveAgentName = useCallback((agentId: string) => {
        if (displayNames[agentId]) return displayNames[agentId];
        const a = AGENT_ROSTER.find(r => r.id === agentId);
        return a?.name ?? agentId;
    }, [displayNames]);

    const updateAgentStatus = useCallback((agentId: string, data: AgentStatus) => {
        setStatuses(prev => ({ ...prev, [agentId]: data }));
    }, []);

    const fetchStatusForAgent = useCallback(async (agent: AgentProfile) => {
        try {
            const res = await fetch(`/api/status?agentId=${agent.id}`);
            if (!res.ok) return;
            const data: AgentStatus = await res.json();
            updateAgentStatus(agent.id, data);
        } catch { /* silent */ }
    }, [updateAgentStatus]);

    useAgentStatusSSE(updateAgentStatus);
    useAgilityTaskSync(statuses);
    useTauriStatusNotifications(statuses, notifiedEvents);
    usePhaseTransitionNotifications(statuses, prevPhases, resolveAgentName, setNotifications);
    useAgentChatSSE(chatAgent?.id ?? null, setChatMessages);

    const handleSendChat = useCallback((message: string) => {
        if (!chatAgent) return;
        const msg: ChatMessage = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            timestamp: new Date().toISOString(),
            from: 'user',
            agentId: chatAgent.id,
            message,
        };
        setChatMessages(prev => {
            const existing = prev[chatAgent.id] ?? [];
            if (existing.some(m => m.id === msg.id)) return prev;
            return { ...prev, [chatAgent.id]: [...existing, msg] };
        });
        writeChatMessage(chatAgent.id, msg);
    }, [chatAgent]);

    const markChatRead = useCallback((agentId: string) => {
        setChatMessages(prev => {
            const msgs = prev[agentId];
            if (!msgs) return prev;
            const updated = msgs.map(m =>
                m.from === 'user' && (!m.status || m.status === 'pending')
                    ? { ...m, status: 'read' as const }
                    : m
            );
            return { ...prev, [agentId]: updated };
        });
        fetch('/api/chat/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
        }).catch(() => {});
    }, []);

    const dismissNotification = useCallback((id: string) => {
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, dismissed: true } : n));
    }, []);

    const clearNotifications = useCallback(() => setNotifications([]), []);

    const pendingMessageCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const [agentId, msgs] of Object.entries(chatMessages)) {
            counts[agentId] = msgs.filter(m => m.from === 'user' && (!m.status || m.status === 'pending')).length;
        }
        return counts;
    }, [chatMessages]);

    const value = useMemo<DashboardContextValue>(() => ({
        statuses,
        fetchStatusForAgent,
        displayNames,
        setDisplayNames,
        externalMode,
        setExternalMode,
        worktreeInfo,
        notifications,
        setNotifications,
        dismissNotification,
        clearNotifications,
        chatMessages,
        chatAgent,
        setChatAgent,
        handleSendChat,
        markChatRead,
        pendingMessageCounts,
        storyPickerAgent,
        setStoryPickerAgent,
        historyOpen,
        setHistoryOpen,
        settingsOpen,
        setSettingsOpen,
        testRunnerOpen,
        setTestRunnerOpen,
        resolveAgentName,
    }), [
        statuses, fetchStatusForAgent, displayNames, externalMode, worktreeInfo,
        notifications, dismissNotification, clearNotifications,
        chatMessages, chatAgent, handleSendChat, markChatRead, pendingMessageCounts,
        storyPickerAgent, historyOpen, settingsOpen, testRunnerOpen,
        resolveAgentName,
    ]);

    return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
