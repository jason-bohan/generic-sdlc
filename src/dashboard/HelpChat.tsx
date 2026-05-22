import { useState, useRef, useEffect, useCallback, useMemo, type CSSProperties } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useFocusTrap } from './hooks/useFocusTrap';
import { mergeTranscript, useVoiceInput } from './hooks/useVoiceInput';

interface HelpMessage {
    role: 'user' | 'assistant';
    content: string;
    source?: 'kb' | 'ollama' | 'driver' | 'offline';
}

const SUGGESTIONS = [
    'How do I create a story?',
    'What is step mode?',
    'Which execution mode should I use?',
    'How do I enable mock mode?',
    'What does each agent do?',
    'How do I chat with an agent?',
];

const md: Record<string, CSSProperties> = {
    h1: { fontSize: '1.2rem', margin: '12px 0 8px', fontWeight: 700, lineHeight: 1.3 },
    h2: { fontSize: '1.08rem', margin: '10px 0 6px', fontWeight: 700, lineHeight: 1.35 },
    h3: { fontSize: '1rem', margin: '10px 0 6px', fontWeight: 700, lineHeight: 1.4, color: 'var(--text-primary)' },
    h4: { fontSize: '0.95rem', margin: '8px 0 4px', fontWeight: 700 },
    p: { margin: '0 0 8px' },
    ul: { margin: '0 0 8px', paddingLeft: 20 },
    ol: { margin: '0 0 8px', paddingLeft: 20 },
    li: { marginBottom: 4 },
    a: { color: 'var(--accent)', textDecoration: 'underline' },
    strong: { fontWeight: 700 },
    em: { fontStyle: 'italic' },
    hr: { border: 'none', borderTop: '1px solid var(--border)', margin: '10px 0' },
    blockquote: {
        margin: '0 0 8px',
        paddingLeft: 12,
        borderLeft: '3px solid var(--border)',
        color: 'var(--text-secondary)',
    },
    pre: {
        margin: '0 0 8px',
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--bg-primary)',
        overflowX: 'auto',
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
    },
    codeBlockInner: { fontFamily: 'inherit', fontSize: 'inherit', background: 'none', border: 'none', padding: 0, display: 'block' },
    tableWrap: { overflowX: 'auto', margin: '0 0 10px' },
    table: { borderCollapse: 'collapse', width: '100%', fontSize: 12 },
    th: { border: '1px solid var(--border)', padding: '6px 8px', textAlign: 'left', background: 'var(--bg-secondary)' },
    td: { border: '1px solid var(--border)', padding: '6px 8px', verticalAlign: 'top' },
};

function buildMarkdownComponents(inlineCodeStyle: CSSProperties): Components {
    return {
        h1: ({ children }) => <h1 style={md.h1}>{children}</h1>,
        h2: ({ children }) => <h2 style={md.h2}>{children}</h2>,
        h3: ({ children }) => <h3 style={md.h3}>{children}</h3>,
        h4: ({ children }) => <h4 style={md.h4}>{children}</h4>,
        p: ({ children }) => <p style={md.p}>{children}</p>,
        ul: ({ children }) => <ul style={md.ul}>{children}</ul>,
        ol: ({ children }) => <ol style={md.ol}>{children}</ol>,
        li: ({ children }) => <li style={md.li}>{children}</li>,
        a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" style={md.a}>
                {children}
            </a>
        ),
        strong: ({ children }) => <strong style={md.strong}>{children}</strong>,
        em: ({ children }) => <em style={md.em}>{children}</em>,
        hr: () => <hr style={md.hr} />,
        blockquote: ({ children }) => <blockquote style={md.blockquote}>{children}</blockquote>,
        code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? '');
            if (!isBlock) {
                return (
                    <code className={className} style={inlineCodeStyle} {...props}>
                        {children}
                    </code>
                );
            }
            return (
                <pre style={md.pre}>
                    <code className={className} style={md.codeBlockInner} {...props}>
                        {children}
                    </code>
                </pre>
            );
        },
        table: ({ children }) => (
            <div style={md.tableWrap}>
                <table style={md.table}>{children}</table>
            </div>
        ),
        thead: ({ children }) => <thead>{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr>{children}</tr>,
        th: ({ children }) => <th style={md.th}>{children}</th>,
        td: ({ children }) => <td style={md.td}>{children}</td>,
    };
}

function HelpMarkdown({ text, inlineCodeStyle }: { text: string; inlineCodeStyle: CSSProperties }) {
    const components = useMemo(() => buildMarkdownComponents(inlineCodeStyle), [inlineCodeStyle]);
    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {text}
        </ReactMarkdown>
    );
}

export default function HelpChat() {
    const [open, setOpen] = useState(false);
    const [messages, setMessages] = useState<HelpMessage[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [longThinking, setLongThinking] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const voiceBaseRef = useRef('');
    /** Bumped on clear/close so in-flight help responses are ignored. */
    const chatEpochRef = useRef(0);
    useFocusTrap(panelRef, open);
    const voice = useVoiceInput(useCallback((text: string) => {
        setInput(mergeTranscript(voiceBaseRef.current, text));
    }, []));

    const clearChat = useCallback(() => {
        chatEpochRef.current += 1;
        setMessages([]);
        setInput('');
        setLoading(false);
        setLongThinking(false);
    }, []);

    const closeHelp = useCallback(() => {
        clearChat();
        setOpen(false);
    }, [clearChat]);

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50);
    }, [open]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length, loading]);

    useEffect(() => {
        if (!loading) {
            setLongThinking(false);
            return;
        }
        const t = window.setTimeout(() => setLongThinking(true), 10_000);
        return () => window.clearTimeout(t);
    }, [loading]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && open) closeHelp();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open, closeHelp]);

    const send = useCallback(async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || loading) return;
        const epoch = chatEpochRef.current;
        setInput('');
        const userMsg: HelpMessage = { role: 'user', content: trimmed };
        setMessages(prev => [...prev, userMsg]);
        setLoading(true);
        try {
            const history = messages.map(m => ({ role: m.role, content: m.content }));
            const res = await fetch('/api/help/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: trimmed, history }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as { answer: string; source: string };
            if (epoch !== chatEpochRef.current) return;
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: data.answer,
                source: data.source as HelpMessage['source'],
            }]);
        } catch {
            if (epoch !== chatEpochRef.current) return;
            let serverReachable = false;
            try {
                const health = await fetch('/api/external-mode');
                serverReachable = health.ok;
            } catch {
                serverReachable = false;
            }
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: serverReachable
                    ? 'That help request was interrupted. The SDLC Framework server is reachable now, so try sending it again.'
                    : 'Could not reach the SDLC Framework server. Check that it is running (`npm run server`) and try again.',
            }]);
        } finally {
            if (epoch === chatEpochRef.current) setLoading(false);
        }
    }, [loading, messages]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void send(input);
    };

    const SOURCE_LABEL: Record<string, string> = {
        kb: 'docs',
        ollama: 'ollama',
        driver: 'claude',
        offline: 'offline',
    };

    const canClear = messages.length > 0 || input.trim().length > 0 || loading;

    return (
        <>
            {/* Floating ? button */}
            <button
                style={{ ...s.fab, background: open ? 'var(--teakwood)' : 'var(--bg-card)' }}
                onClick={() => { if (open) closeHelp(); else setOpen(true); }}
                title={open ? 'Close help' : 'Open help'}
                aria-label={open ? 'Close SDLC Framework help' : 'Open SDLC Framework help'}
                aria-expanded={open}
            >
                {open ? '✕' : '?'}
            </button>

            {/* Slide-out drawer */}
            <div
                ref={panelRef}
                style={{ ...s.drawer, transform: open ? 'translateX(0)' : 'translateX(100%)' }}
                role="dialog"
                aria-modal="true"
                aria-label="SDLC Framework Help"
            >
                <div style={s.header}>
                    <div style={s.headerTitle}>
                        <span style={s.headerDot} />
                        <span style={s.headerName}>SDLC Framework Help</span>
                        <span style={s.headerSub}>Ask anything</span>
                    </div>
                    <div style={s.headerActions}>
                        <button
                            type="button"
                            style={{ ...s.clearBtn, opacity: canClear ? 1 : 0.45 }}
                            onClick={clearChat}
                            disabled={!canClear}
                            aria-label="Clear chat history"
                        >
                            Clear
                        </button>
                        <button type="button" style={s.closeBtn} onClick={closeHelp} aria-label="Close help">✕</button>
                    </div>
                </div>

                <div style={s.messages} role="log" aria-live="polite">
                    {messages.length === 0 && !loading && (
                        <div style={s.empty}>
                            <div style={s.emptyTitle}>How can I help?</div>
                            <div style={s.emptyHint}>Ask about the GUI, TUI, step mode, config, agents — anything SDLC Framework.</div>
                            <div style={s.chips}>
                                {SUGGESTIONS.map(q => (
                                    <button
                                        key={q}
                                        style={s.chip}
                                        onClick={() => void send(q)}
                                    >
                                        {q}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {messages.map((msg, i) => (
                        <div
                            key={i}
                            style={{
                                ...s.bubble,
                                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                                background: msg.role === 'user' ? 'var(--accent-dim)' : 'var(--bg-secondary)',
                                border: `1px solid ${msg.role === 'user' ? 'var(--accent)44' : 'var(--border)'}`,
                            }}
                        >
                            <div style={s.bubbleFrom}>
                                {msg.role === 'user' ? 'You' : 'SDLC Framework'}
                                {msg.source && msg.role === 'assistant' && (
                                    <span style={s.sourceTag}>[{SOURCE_LABEL[msg.source] ?? msg.source}]</span>
                                )}
                            </div>
                            <div style={s.bubbleMarkdown}>
                                <HelpMarkdown text={msg.content} inlineCodeStyle={s.inlineCode} />
                            </div>
                        </div>
                    ))}
                    {loading && (
                        <div style={{ ...s.bubble, alignSelf: 'flex-start', background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                            <div style={s.bubbleFrom}>SDLC Framework</div>
                            <div style={{ ...s.bubbleText, color: 'var(--text-tertiary)' }}>
                                {longThinking
                                    ? 'Still thinking... (AI model may be loading)'
                                    : 'Thinking…'}
                            </div>
                        </div>
                    )}
                    <div ref={bottomRef} />
                </div>

                {messages.length > 0 && (
                    <div style={s.quickChips}>
                        {SUGGESTIONS.slice(0, 3).map(q => (
                            <button key={q} style={s.chip} onClick={() => void send(q)}>{q}</button>
                        ))}
                    </div>
                )}

                <form style={s.inputBar} onSubmit={handleSubmit}>
                    <input
                        ref={inputRef}
                        style={s.input}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        placeholder="Ask about SDLC Framework…"
                        disabled={loading}
                        aria-label="Help question"
                    />
                    <button
                        type="button"
                        style={{
                            ...s.voiceBtn,
                            borderColor: voice.listening ? 'var(--error)' : 'var(--border)',
                            color: voice.listening ? 'var(--error)' : 'var(--text-secondary)',
                            background: voice.listening ? 'rgba(239, 68, 68, 0.14)' : 'var(--bg-secondary)',
                            opacity: voice.supported && !loading ? 1 : 0.45,
                        }}
                        onClick={() => {
                            voiceBaseRef.current = input;
                            voice.toggle();
                        }}
                        disabled={!voice.supported || loading}
                        aria-label={voice.listening ? 'Stop voice input' : 'Start voice input'}
                        title={voice.error ?? (voice.supported ? 'Start voice input' : 'Voice input is not supported in this browser')}
                    >
                        🎙
                    </button>
                    <button
                        type="submit"
                        style={{ ...s.sendBtn, opacity: loading || !input.trim() ? 0.5 : 1 }}
                        disabled={loading || !input.trim()}
                        aria-label="Send"
                    >
                        →
                    </button>
                </form>
            </div>
        </>
    );
}
HelpChat.displayName = 'HelpChat';

const s: Record<string, CSSProperties> = {
    fab: {
        position: 'fixed',
        bottom: 56,
        right: 12,
        zIndex: 8500,
        border: '1px solid var(--border)',
        borderRadius: '50%',
        width: 36,
        height: 36,
        fontSize: 16,
        fontWeight: 700,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-secondary)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        transition: 'background 0.2s, color 0.2s',
        fontFamily: 'var(--font-mono)',
    },

    drawer: {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 400,
        maxWidth: '100vw',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-card)',
        borderLeft: '1px solid var(--border)',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.2)',
        zIndex: 8000,
        transition: 'transform 0.25s ease',
        willChange: 'transform',
    },

    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
    },
    headerTitle: { display: 'flex', alignItems: 'center', gap: 8 },
    headerDot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: 'var(--accent)',
        flexShrink: 0,
    },
    headerName: { fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' },
    headerSub: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
    headerActions: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
    clearBtn: {
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        color: 'var(--text-secondary)',
        fontSize: 11,
        fontWeight: 700,
        cursor: 'pointer',
        padding: '5px 10px',
        lineHeight: 1,
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase' as const,
        letterSpacing: '0.04em',
    },
    closeBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--text-secondary)',
        fontSize: 18,
        cursor: 'pointer',
        padding: '2px 6px',
        lineHeight: 1,
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
    },

    messages: {
        flex: 1,
        overflowY: 'auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
    },

    empty: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '24px 8px',
    },
    emptyTitle: {
        fontSize: 16,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
    },
    emptyHint: {
        fontSize: 13,
        color: 'var(--text-tertiary)',
        lineHeight: 1.5,
    },
    chips: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 4,
    },
    chip: {
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '7px 12px',
        fontSize: 12,
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'var(--font-mono)',
        transition: 'border-color 0.15s, color 0.15s',
    },

    bubble: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 14px',
        borderRadius: 8,
        maxWidth: '92%',
    },
    bubbleFrom: {
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: 'var(--accent)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
    },
    sourceTag: {
        fontSize: 9,
        color: 'var(--text-tertiary)',
        textTransform: 'none',
        letterSpacing: 0,
    },
    bubbleMarkdown: {
        fontSize: 13,
        color: 'var(--text-primary)',
        lineHeight: 1.55,
        fontFamily: 'var(--font-mono)',
        wordBreak: 'break-word',
    },
    bubbleText: {
        fontSize: 13,
        color: 'var(--text-primary)',
        lineHeight: 1.55,
        fontFamily: 'var(--font-mono)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
    },
    inlineCode: {
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        borderRadius: 3,
        padding: '1px 5px',
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
    },

    quickChips: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '8px 16px',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
    },

    inputBar: {
        display: 'flex',
        gap: 8,
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
    },
    input: {
        flex: 1,
        padding: '9px 12px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        fontSize: 13,
        fontFamily: 'var(--font-mono)',
        outline: 'none',
    },
    voiceBtn: {
        width: 36,
        height: 36,
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
        padding: '8px 14px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        fontSize: 16,
        fontWeight: 700,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        transition: 'opacity 0.15s',
    },
};
