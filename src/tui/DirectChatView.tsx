import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { API_BASE } from './workspace';

type MessageRole = 'user' | 'assistant' | 'notice';
interface Message { role: MessageRole; content: string }
interface Props { agent: string; onBack?: () => void }

const COMMANDS = [
    { cmd: '/help',   desc: 'show this list',            args: false },
    { cmd: '/clear',  desc: 'clear conversation',         args: false },
    { cmd: '/models', desc: 'list available models',      args: false },
    { cmd: '/model',  desc: 'show or switch model',       args: true  },
    { cmd: '/system', desc: 'show or set system prompt',  args: true  },
    { cmd: '/exit',   desc: 'back to menu',               args: false },
];

function SlashMenu({ items, selectedIndex }: { items: typeof COMMANDS; selectedIndex: number }) {
    if (items.length === 0) return null;
    return (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" marginBottom={1}>
            {items.map((item, i) => (
                <Box key={item.cmd} gap={1} paddingX={1}>
                    <Text color={i === selectedIndex ? 'cyan' : 'white'} bold={i === selectedIndex}>
                        {item.cmd.padEnd(10)}
                    </Text>
                    <Text color={i === selectedIndex ? 'white' : 'gray'}>
                        {item.desc}
                    </Text>
                </Box>
            ))}
        </Box>
    );
}

function splitMarkdown(content: string): Array<{ kind: 'text'; value: string } | { kind: 'code'; lang: string; value: string }> {
    const parts: Array<{ kind: 'text'; value: string } | { kind: 'code'; lang: string; value: string }> = [];
    const fence = /```(\w+)?\n([\s\S]*?)```/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = fence.exec(content)) !== null) {
        if (match.index > last) parts.push({ kind: 'text', value: content.slice(last, match.index) });
        parts.push({ kind: 'code', lang: match[1] ?? '', value: match[2].replace(/\n$/, '') });
        last = match.index + match[0].length;
    }
    if (last < content.length) parts.push({ kind: 'text', value: content.slice(last) });
    return parts;
}

function tokenColor(token: string): string | undefined {
    if (/^(const|let|var|function|return|import|from|export|async|await|type|interface|class|if|else|for|while|try|catch|new)$/.test(token)) return 'magenta';
    if (/^(true|false|null|undefined)$/.test(token)) return 'yellow';
    if (/^["'`].*["'`]$/.test(token)) return 'green';
    if (/^\d+$/.test(token)) return 'yellow';
    if (/^\/\/|^#/.test(token)) return 'gray';
    if (/^[A-Za-z0-9_-]+:$/.test(token)) return 'cyan';
    return undefined;
}

function renderHighlightedLine(line: string, keyPrefix: string) {
    const pieces = line.split(/(\s+|[()[\]{}.,;:+\-*/=<>]+)/).filter(Boolean);
    return (
        <Text key={keyPrefix}>
            {pieces.map((piece, i) => {
                const color = tokenColor(piece);
                return color
                    ? <Text key={i} color={color}>{piece}</Text>
                    : <Text key={i}>{piece}</Text>;
            })}
        </Text>
    );
}

function MessageBody({ content }: { content: string }) {
    return (
        <Box flexDirection="column">
            {splitMarkdown(content).map((part, index) => {
                if (part.kind === 'text') {
                    return part.value.trim()
                        ? <Text key={index} wrap="wrap">{part.value.trim()}</Text>
                        : null;
                }
                const lines = part.value.split('\n');
                return (
                    <Box key={index} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1} marginBottom={1}>
                        <Text color="gray">{part.lang || 'code'}</Text>
                        {lines.map((line, lineIndex) => renderHighlightedLine(line, `${index}-${lineIndex}`))}
                    </Box>
                );
            })}
        </Box>
    );
}

function mlxBaseUrl(): string {
    const host = process.env.MLX_HOST_14B || process.env.MLX_HOST || 'http://localhost:8083';
    return host.endsWith('/v1') ? host : `${host}/v1`;
}

async function firstMlxModel(): Promise<string> {
    try {
        const res = await fetch(`${mlxBaseUrl()}/models`, { signal: AbortSignal.timeout(3_000) });
        if (res.ok) {
            const data = await res.json() as { data?: Array<{ id: string }> };
            const id = data.data?.[0]?.id;
            if (id) return id;
        }
    } catch { /* use env/default */ }
    return process.env.MLX_MODEL_14B || process.env.MLX_MODEL || 'mlx-community/Qwen2.5-Coder-14B-Instruct-4bit';
}

async function fetchAvailableModels(): Promise<string[]> {
    try {
        const res = await fetch(`${API_BASE}/api/agents/models`, { signal: AbortSignal.timeout(3_000) });
        if (res.ok) {
            const data = await res.json() as Array<{ id: string }>;
            return data.map(m => m.id);
        }
    } catch { /* fall through */ }
    try {
        const res = await fetch(`${mlxBaseUrl()}/models`, { signal: AbortSignal.timeout(3_000) });
        if (res.ok) {
            const data = await res.json() as { data?: Array<{ id: string }> };
            return (data.data ?? []).map(m => m.id);
        }
    } catch { /* fall through */ }
    return [];
}

async function sendViaMlx(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    selectedModel: string | null,
    systemPrompt: string,
): Promise<{ reply: string; model: string; provider: string }> {
    const model = selectedModel && selectedModel !== 'auto' && selectedModel !== 'local'
        ? selectedModel
        : await firstMlxModel();
    const res = await fetch(`${mlxBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages,
            ],
            max_tokens: 1024,
            temperature: 0.2,
        }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`MLX ${res.status}: ${res.statusText}`);
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { reply: data.choices?.[0]?.message?.content?.trim() ?? '', model, provider: 'mlx-14b' };
}

const DEFAULT_SYSTEM = 'You are a concise local coding assistant. When asked what model or AI you are, answer truthfully using your model name.';

const HELP_TEXT = [
    '/help          show this list',
    '/exit  /quit   back to menu',
    '/clear         clear conversation history',
    '/model         show active model',
    '/model <name>  switch model',
    '/models        list available models',
    '/system        show current system prompt',
    '/system <text> set system prompt',
].join('\n');

export function DirectChatView({ agent, onBack }: Props) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [model, setModel] = useState<string | null>(null);
    const [provider, setProvider] = useState<string | null>(null);
    const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
    const [error, setError] = useState<string | null>(null);
    const [menuIndex, setMenuIndex] = useState(-1);

    // Commands filtered by what's been typed after /
    const menuItems = input.startsWith('/')
        ? COMMANDS.filter(c => c.cmd.startsWith(input.split(' ')[0]))
        : [];
    const menuOpen = menuItems.length > 0 && !loading;

    useEffect(() => {
        fetch(`${API_BASE}/api/agent/model?agentId=${encodeURIComponent(agent)}`)
            .then(r => r.json())
            .then((d: { model: string | null }) => setModel(d.model || 'auto'))
            .catch(() => setModel('auto'));
    }, [agent]);

    // Reset menu index when filtered list changes
    useEffect(() => {
        setMenuIndex(-1);
    }, [input]);

    useInput((_ch, key) => {
        if (!menuOpen) return;

        if (key.downArrow) {
            setMenuIndex(prev => Math.min(prev + 1, menuItems.length - 1));
            return;
        }
        if (key.upArrow) {
            setMenuIndex(prev => Math.max(prev - 1, -1));
            return;
        }
        if ((key.return || key.tab) && menuIndex >= 0) {
            const selected = menuItems[menuIndex];
            setInput(selected.args ? `${selected.cmd} ` : selected.cmd);
            setMenuIndex(-1);
            return;
        }
        if (key.escape) {
            setInput('');
            setMenuIndex(-1);
        }
    }, { isActive: !loading });

    function notice(content: string) {
        setMessages(prev => [...prev, { role: 'notice', content }]);
    }

    async function handleSlashCommand(raw: string): Promise<boolean> {
        const [cmd, ...rest] = raw.trim().split(/\s+/);
        const arg = rest.join(' ');

        switch (cmd) {
            case '/exit':
            case '/quit':
                onBack?.();
                return true;

            case '/clear':
                setMessages([]);
                setError(null);
                return true;

            case '/help':
            case '/?':
                notice(HELP_TEXT);
                return true;

            case '/model':
                if (!arg) {
                    notice(`model: ${model ?? 'unknown'}\nprovider: ${provider ?? 'unknown'}`);
                } else {
                    setModel(arg);
                    notice(`model switched to: ${arg}`);
                }
                return true;

            case '/models': {
                notice('Fetching models…');
                const models = await fetchAvailableModels();
                setMessages(prev => {
                    const next = [...prev];
                    next[next.length - 1] = {
                        role: 'notice',
                        content: models.length
                            ? `Available models:\n${models.map(m => `  ${m}`).join('\n')}`
                            : 'No models found (server may be offline)',
                    };
                    return next;
                });
                return true;
            }

            case '/system':
                if (!arg) {
                    notice(`system prompt: ${systemPrompt}`);
                } else {
                    setSystemPrompt(arg);
                    notice(`system prompt updated`);
                }
                return true;

            default:
                return false;
        }
    }

    async function send(text: string) {
        if (!text.trim() || loading) return;
        // If a menu item is selected, complete it instead of submitting
        if (menuOpen && menuIndex >= 0) {
            const selected = menuItems[menuIndex];
            setInput(selected.args ? `${selected.cmd} ` : selected.cmd);
            setMenuIndex(-1);
            return;
        }
        setInput('');

        if (text.trim().startsWith('/')) {
            const handled = await handleSlashCommand(text.trim());
            if (handled) return;
        }

        const userMsg: Message = { role: 'user', content: text };
        const history = messages.filter(m => m.role !== 'notice');
        const next = [...messages, userMsg];
        const historyForApi = [...history, userMsg] as Array<{ role: 'user' | 'assistant'; content: string }>;
        setMessages(next);
        setLoading(true);
        setError(null);
        const resolvedModel = model && model !== 'auto' && model !== 'local' ? model : await firstMlxModel();
        const resolvedSystem = `${systemPrompt}\nYour model name is: ${resolvedModel}`;
        try {
            const r = await fetch(`${API_BASE}/api/chat/direct`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent, messages: historyForApi, systemPrompt: resolvedSystem }),
            });
            const data = await r.json() as { reply?: string; error?: string; model?: string; provider?: string };
            if (!r.ok || data.error) { setError(data.error ?? `Error ${r.status}`); }
            else {
                setModel(data.model ?? model);
                setProvider(data.provider ?? provider);
                setMessages([...next, { role: 'assistant', content: data.reply ?? '' }]);
            }
        } catch (e) {
            try {
                const data = await sendViaMlx(historyForApi, model, resolvedSystem);
                setModel(data.model);
                setProvider(data.provider);
                setMessages([...next, { role: 'assistant', content: data.reply }]);
            } catch (fallbackErr) {
                const primary = e instanceof Error ? e.message : String(e);
                const fallback = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                setError(`${primary}; MLX fallback failed: ${fallback}`);
            }
        }
        setLoading(false);
    }

    const recent = messages.slice(-20);

    return (
        <Box flexDirection="column" padding={1}>
            <Box gap={2}>
                <Text bold color="yellow">ChatLLM</Text>
                <Text dimColor>agent=<Text color="cyan">{agent}</Text></Text>
                {provider && <Text dimColor>provider=<Text color="green">{provider}</Text></Text>}
            </Box>
            <Text dimColor>{model ? `model=${model}` : 'model=loading'} · type / for commands · [Esc] back</Text>

            <Box flexDirection="column" marginTop={1} marginBottom={1}>
                {recent.length === 0 && (
                    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
                        <Text color="green">Ready.</Text>
                        <Text dimColor>Ask anything, or type / for slash commands.</Text>
                    </Box>
                )}
                {recent.map((m, i) => {
                    if (m.role === 'notice') {
                        return (
                            <Box key={i} marginBottom={1} paddingX={1}>
                                <Text color="gray">{m.content}</Text>
                            </Box>
                        );
                    }
                    return (
                        <Box
                            key={i}
                            flexDirection="column"
                            borderStyle={m.role === 'assistant' ? 'round' : undefined}
                            borderColor={m.role === 'assistant' ? 'green' : undefined}
                            paddingX={m.role === 'assistant' ? 1 : 0}
                            marginBottom={1}
                        >
                            <Text color={m.role === 'user' ? 'cyan' : 'green'} bold>{m.role === 'user' ? 'You' : 'LLM'}</Text>
                            <MessageBody content={m.content} />
                        </Box>
                    );
                })}
                {error && <Text color="red">Error: {error}</Text>}
            </Box>

            {menuOpen && <SlashMenu items={menuItems} selectedIndex={menuIndex} />}

            <Box gap={1}>
                <Text color="cyan" bold>{'>'}</Text>
                {loading ? (
                    <Text><Spinner type="dots" /> Waiting...</Text>
                ) : (
                    <TextInput
                        value={input}
                        onChange={setInput}
                        onSubmit={send}
                        focus={menuIndex === -1}
                    />
                )}
            </Box>
        </Box>
    );
}
DirectChatView.displayName = 'DirectChatView';
