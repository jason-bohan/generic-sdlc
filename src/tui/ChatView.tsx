import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { checkServer, API_BASE } from './workspace';

type DeliveryStatus = 'pending' | 'read' | 'acted';
interface Message { from: string; message: string; timestamp?: string; status?: DeliveryStatus }
interface Props { agent: string; dir: string; onBack?: () => void }

export function ChatView({ agent, dir, onBack }: Props) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [serverDown, setServerDown] = useState(false);

    useEffect(() => {
        let intervalId: ReturnType<typeof setInterval> | null = null;
        checkServer().then(ok => {
            if (!ok) {
                setServerDown(true);
                setLoading(false);
                return;
            }
            loadMessages();
            intervalId = setInterval(loadMessages, 3000);
        });
        return () => { if (intervalId) clearInterval(intervalId); };
    }, []);

    async function loadMessages() {
        try {
            const res = await fetch(`${API_BASE}/api/chat/messages?agentId=${agent}`);
            const data = await res.json();
            setMessages(Array.isArray(data) ? data : data.messages ?? []);
        } catch { /* ignore polling errors */ }
        setLoading(false);
    }

    async function sendMessage(text: string) {
        if (!text.trim()) return;
        setSending(true);
        try {
            await fetch(`${API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent, message: { from: 'user', message: text } }),
            });
            setInput('');
            await loadMessages();
        } catch { /* ignore */ }
        setSending(false);
    }

    if (serverDown) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="red">Cannot connect to server at localhost:3847. Start it with `npm run dev`.</Text>
                {onBack && <Box marginTop={1}><Text dimColor>[Esc] back to menu</Text></Box>}
            </Box>
        );
    }

    if (loading) {
        return (
            <Box padding={1} gap={1}>
                <Text color="green"><Spinner type="dots" /></Text>
                <Text>Loading chat with {agent}...</Text>
            </Box>
        );
    }

    const recent = messages.slice(-15);

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="yellow">Chat with {agent}</Text>
            <Text dimColor>Type a message and press Enter. [Esc] back to menu.</Text>

            <Box flexDirection="column" marginTop={1} marginBottom={1}>
                {recent.length === 0 && <Text dimColor>No messages yet</Text>}
                {recent.map((m, i) => {
                    const isUser = m.from === 'user';
                    const statusIcon = isUser && m.status
                        ? m.status === 'acted' ? '\u2713\u2713' : m.status === 'read' ? '\u2713' : '\u25CB'
                        : '';
                    const statusColor = m.status === 'acted' ? 'green' : m.status === 'read' ? 'blue' : 'gray';
                    return (
                        <Box key={i} gap={1}>
                            <Text color={isUser ? 'cyan' : 'green'} bold>
                                {isUser ? 'You' : agent}:
                            </Text>
                            <Text wrap="wrap">{m.message}</Text>
                            {isUser && statusIcon && (
                                <Text color={statusColor} dimColor={m.status === 'pending'}>
                                    {statusIcon}
                                </Text>
                            )}
                        </Box>
                    );
                })}
            </Box>

            <Box gap={1}>
                <Text color="cyan" bold>{'>'}</Text>
                {sending ? (
                    <Text><Spinner type="dots" /> Sending...</Text>
                ) : (
                    <TextInput value={input} onChange={setInput} onSubmit={sendMessage} />
                )}
            </Box>
        </Box>
    );
}
ChatView.displayName = 'ChatView';
