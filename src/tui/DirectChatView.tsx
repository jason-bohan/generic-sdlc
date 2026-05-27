import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { API_BASE } from './workspace';

interface Message { role: 'user' | 'assistant'; content: string }
interface Props { agent: string; onBack?: () => void }

export function DirectChatView({ agent, onBack }: Props) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [model, setModel] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch(`${API_BASE}/api/agent/model?agentId=${encodeURIComponent(agent)}`)
            .then(r => r.json())
            .then((d: { model: string | null }) => setModel(d.model || 'auto'))
            .catch(() => setModel('auto'));
    }, [agent]);

    async function send(text: string) {
        if (!text.trim() || loading) return;
        const userMsg: Message = { role: 'user', content: text };
        const next = [...messages, userMsg];
        setMessages(next);
        setInput('');
        setLoading(true);
        setError(null);
        try {
            const r = await fetch(`${API_BASE}/api/chat/direct`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent, messages: next }),
            });
            const data = await r.json() as { reply?: string; error?: string };
            if (!r.ok || data.error) { setError(data.error ?? `Error ${r.status}`); }
            else { setMessages([...next, { role: 'assistant', content: data.reply ?? '' }]); }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
    }

    const recent = messages.slice(-20);

    return (
        <Box flexDirection="column" padding={1}>
            <Box gap={2}>
                <Text bold color="yellow">Chat — {agent}</Text>
                {model && <Text dimColor>[{model}]</Text>}
            </Box>
            <Text dimColor>Direct AI chat · [Esc] back</Text>

            <Box flexDirection="column" marginTop={1} marginBottom={1}>
                {recent.length === 0 && <Text dimColor>Send a message to start chatting.</Text>}
                {recent.map((m, i) => (
                    <Box key={i} flexDirection="column" marginBottom={m.role === 'assistant' ? 1 : 0}>
                        <Text color={m.role === 'user' ? 'cyan' : 'green'} bold>
                            {m.role === 'user' ? 'You' : agent}:
                        </Text>
                        <Text wrap="wrap">{m.content}</Text>
                    </Box>
                ))}
                {error && <Text color="red">Error: {error}</Text>}
            </Box>

            <Box gap={1}>
                <Text color="cyan" bold>{'>'}</Text>
                {loading ? (
                    <Text><Spinner type="dots" /> Waiting...</Text>
                ) : (
                    <TextInput value={input} onChange={setInput} onSubmit={send} />
                )}
            </Box>
        </Box>
    );
}
DirectChatView.displayName = 'DirectChatView';
