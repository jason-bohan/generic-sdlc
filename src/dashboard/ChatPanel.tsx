import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react';
import type { AgentProfile, ChatMessage, MessageDeliveryStatus } from './types';
import { useFocusTrap } from './hooks/useFocusTrap';
import { mergeTranscript, useVoiceInput } from './hooks/useVoiceInput';

interface ChatPanelProps {
    agent: AgentProfile;
    displayName?: string;
    messages: ChatMessage[];
    chatCapability?: 'live' | 'auto-reply' | 'unavailable';
    agentModel?: string;
    onSend: (message: string) => void;
    onClose: () => void;
    onMarkRead?: () => void;
}

const PANEL_W = 380;
const PANEL_H = 480;
const DRAG_THRESHOLD = 4;

export default function ChatPanel({ agent, displayName, messages, chatCapability, agentModel, onSend, onClose, onMarkRead }: ChatPanelProps) {
    const agentLabel = displayName || agent.name;
    const [input, setInput] = useState('');
    const bottomRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const voiceBaseRef = useRef('');
    const dragState = useRef<{
        startX: number; startY: number;
        origX: number; origY: number;
        dragging: boolean; pointerId: number;
    } | null>(null);
    useFocusTrap(panelRef, true);
    const voice = useVoiceInput(useCallback((text: string) => {
        setInput(mergeTranscript(voiceBaseRef.current, text));
    }, []));

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    useEffect(() => {
        onMarkRead?.();
    }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [onClose]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = input.trim();
        if (!trimmed) return;
        onSend(trimmed);
        setInput('');
    };

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        const panel = panelRef.current;
        const header = headerRef.current;
        if (!panel || !header) return;
        const rect = panel.getBoundingClientRect();
        dragState.current = {
            startX: e.clientX, startY: e.clientY,
            origX: rect.left, origY: rect.top,
            dragging: false, pointerId: e.pointerId,
        };
        header.setPointerCapture(e.pointerId);
    }, []);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        const d = dragState.current;
        if (!d) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;

        if (!d.dragging) {
            if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
            d.dragging = true;
            if (headerRef.current) headerRef.current.style.cursor = 'grabbing';
        }

        const panel = panelRef.current;
        if (!panel) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const x = Math.max(0, Math.min(vw - PANEL_W, d.origX + dx));
        const y = Math.max(0, Math.min(vh - PANEL_H, d.origY + dy));
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }, []);

    const onPointerUp = useCallback(() => {
        if (headerRef.current) headerRef.current.style.cursor = 'grab';
        dragState.current = null;
    }, []);

    return (
        <div
            ref={panelRef}
            style={s.panel}
            role="dialog"
            aria-modal="true"
            aria-label={`Chat with ${agentLabel}`}
        >
            <div
                ref={headerRef}
                style={s.header}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <div style={s.headerInfo}>
                    <div style={{ ...s.dot, background: agent.accentColor }} />
                    <span style={s.headerName}>/btw {agent.shortName.toLowerCase()}</span>
                    <span style={s.headerRole}>{agent.title}</span>
                </div>
                <button style={s.closeBtn} onClick={onClose} aria-label="Close chat">&times;</button>
            </div>

            {chatCapability && (
                <div style={{
                    padding: '5px 16px',
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    borderBottom: '1px solid var(--border)',
                    background: chatCapability === 'live' ? 'rgba(34, 197, 94, 0.06)'
                        : chatCapability === 'unavailable' ? 'rgba(156, 163, 175, 0.06)'
                        : 'rgba(245, 158, 11, 0.06)',
                    color: chatCapability === 'live' ? '#22c55e'
                        : chatCapability === 'unavailable' ? 'var(--text-tertiary)'
                        : '#f59e0b',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                }}>
                    <span style={{ fontSize: 12, flexShrink: 0, lineHeight: 1 }}>
                        {chatCapability === 'live' ? '\uD83D\uDDE8\uFE0F'
                            : chatCapability === 'unavailable' ? '\uD83D\uDEAB'
                            : '\uD83E\uDD16'}
                    </span>
                    <span>
                        {chatCapability === 'live' ? 'Live session'
                            : chatCapability === 'unavailable' ? 'Agent unavailable'
                            : 'Auto-reply'}
                    </span>
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 10, marginLeft: 'auto' }}>
                        {chatCapability === 'live' ? 'real-time'
                            : chatCapability === 'unavailable' ? 'can\'t receive'
                            : agentModel && agentModel !== 'auto' ? agentModel : 'simulated'}
                    </span>
                </div>
            )}

            <div style={s.messages} role="log" aria-live="polite">
                {messages.length === 0 && (
                    <div style={s.empty}>
                        Send a message to {agentLabel} while they're working.
                        <br />
                        <span style={s.hint}>
                            Use this to give context, ask questions, or redirect priorities.
                        </span>
                    </div>
                )}
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        style={{
                            ...s.message,
                            alignSelf: msg.from === 'user' ? 'flex-end' : 'flex-start',
                            background: msg.from === 'user' ? 'var(--accent-dim)' : 'var(--bg-secondary)',
                            borderColor: msg.from === 'user' ? `${agent.accentColor}44` : 'var(--border)',
                        }}
                    >
                        <span style={s.msgFrom}>
                            {msg.from === 'user' ? 'You' : agent.shortName}
                        </span>
                        <span style={s.msgText}>{msg.message}</span>
                        <div style={s.msgFooter}>
                            <span style={s.msgTime}>
                                {new Date(msg.timestamp).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                })}
                            </span>
                            {msg.from === 'user' && msg.status && (
                                <DeliveryIndicator status={msg.status} />
                            )}
                        </div>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            <form style={s.inputBar} onSubmit={handleSubmit}>
                <input
                    style={s.input}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={`Message ${agent.shortName}...`}
                    autoFocus
                />
                <button
                    type="button"
                    style={{
                        ...s.voiceBtn,
                        borderColor: voice.listening ? 'var(--error)' : 'var(--border)',
                        color: voice.listening ? 'var(--error)' : 'var(--text-secondary)',
                        background: voice.listening ? 'rgba(239, 68, 68, 0.14)' : 'var(--bg-primary)',
                        opacity: voice.supported ? 1 : 0.45,
                    }}
                    onClick={() => {
                        voiceBaseRef.current = input;
                        voice.toggle();
                    }}
                    disabled={!voice.supported}
                    aria-label={voice.listening ? 'Stop voice input' : 'Start voice input'}
                    title={voice.error ?? (voice.supported ? 'Start voice input' : 'Voice input is not supported in this browser')}
                >
                    🎙
                </button>
                <button type="submit" style={{ ...s.sendBtn, background: agent.accentColor }}>
                    Send
                </button>
            </form>
        </div>
    );
}
ChatPanel.displayName = 'ChatPanel';

const DELIVERY_ICONS: Record<MessageDeliveryStatus, { symbol: string; color: string; label: string }> = {
    pending: { symbol: '\u25CB', color: 'var(--text-tertiary)', label: 'Sent' },
    read: { symbol: '\u2713', color: 'var(--info)', label: 'Read' },
    acted: { symbol: '\u2713\u2713', color: 'var(--success)', label: 'Acted on' },
};

function DeliveryIndicator({ status }: { status: MessageDeliveryStatus }) {
    const info = DELIVERY_ICONS[status];
    return (
        <span style={s.deliveryBadge} title={info.label}>
            <span style={{ color: info.color, fontSize: 10 }}>{info.symbol}</span>
            <span style={{ color: info.color, fontSize: 9 }}>{info.label}</span>
        </span>
    );
}

const s: Record<string, CSSProperties> = {
    panel: {
        position: 'fixed',
        bottom: 24,
        right: 24,
        width: 380,
        height: 480,
        maxHeight: 'calc(100vh - 48px)',
        maxWidth: 'calc(100vw - 48px)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        zIndex: 9999,
        willChange: 'left, top',
    },

    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        borderRadius: '12px 12px 0 0',
        background: 'var(--bg-secondary)',
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
    },
    headerInfo: { display: 'flex', alignItems: 'center', gap: 8 },
    dot: { width: 8, height: 8, borderRadius: '50%' },
    headerName: { fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' },
    headerRole: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
    closeBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--text-secondary)',
        fontSize: 22,
        cursor: 'pointer',
        padding: '2px 6px',
        lineHeight: 1,
        borderRadius: 4,
    },

    messages: {
        flex: 1,
        overflowY: 'auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
    },
    empty: {
        textAlign: 'center',
        color: 'var(--text-tertiary)',
        fontSize: 13,
        padding: '32px 16px',
        lineHeight: 1.6,
    },
    hint: { fontSize: 11, fontStyle: 'italic' },

    message: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '8px 12px',
        borderRadius: 6,
        border: '1px solid',
        maxWidth: '85%',
    },
    msgFrom: { fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.06em' },
    msgText: { fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 },
    msgFooter: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
    msgTime: { fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' },
    deliveryBadge: { display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-mono)' },

    inputBar: {
        display: 'flex',
        gap: 8,
        padding: 12,
        borderTop: '1px solid var(--border)',
        borderRadius: '0 0 12px 12px',
    },
    input: {
        flex: 1,
        padding: '8px 12px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        fontSize: 13,
        fontFamily: 'var(--font-mono)',
        outline: 'none',
    },
    voiceBtn: {
        width: 34,
        height: 34,
        borderRadius: 6,
        border: '1px solid',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        fontSize: 14,
        lineHeight: 1,
        flexShrink: 0,
    },
    sendBtn: {
        padding: '8px 16px',
        borderRadius: 6,
        border: 'none',
        color: '#fff',
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.04em',
    },
};
