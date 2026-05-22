import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

const API_BASE = 'http://localhost:3001';

interface HelpMessage {
    role: 'user' | 'assistant';
    content: string;
    source?: string;
}

interface HelpViewProps {
    onClose: () => void;
}

type State = 'input' | 'loading' | 'answer';

export function HelpView({ onClose }: HelpViewProps) {
    const [query, setQuery] = useState('');
    const [state, setState] = useState<State>('input');
    const [messages, setMessages] = useState<HelpMessage[]>([]);
    const [lastAnswer, setLastAnswer] = useState('');
    const [source, setSource] = useState('');

    const submit = useCallback(async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        setQuery('');
        setState('loading');
        const history = messages.map(m => ({ role: m.role, content: m.content }));
        try {
            const res = await fetch(`${API_BASE}/api/help/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: trimmed, history }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as { answer: string; source: string };
            const newMessages: HelpMessage[] = [
                ...messages,
                { role: 'user', content: trimmed },
                { role: 'assistant', content: data.answer, source: data.source },
            ];
            setMessages(newMessages);
            setLastAnswer(data.answer);
            setSource(data.source ?? '');
            setState('answer');
        } catch {
            setLastAnswer('Could not reach the SDLC Framework server. Make sure `npm run server` is running.');
            setSource('offline');
            setState('answer');
        }
    }, [messages]);

    useInput((input, key) => {
        if (key.escape || input === 'q') { onClose(); return; }
        if (state === 'answer' && (input === 'n' || key.return)) {
            setState('input');
        }
    });

    const cols = process.stdout.columns ?? 100;
    const answerLines = lastAnswer.split('\n');

    if (state === 'loading') {
        return (
            <Box flexDirection="column" padding={1} borderStyle="round" borderColor="yellow" width={Math.min(cols - 2, 80)}>
                <Text bold color="yellow">SDLC Framework Help</Text>
                <Text dimColor>Thinking…</Text>
            </Box>
        );
    }

    if (state === 'answer') {
        return (
            <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" width={Math.min(cols - 2, 80)}>
                <Box gap={2} marginBottom={1}>
                    <Text bold color="cyan">SDLC Framework Help</Text>
                    {source && <Text dimColor>[{source}]</Text>}
                </Box>
                <Box flexDirection="column">
                    {answerLines.map((line, i) => (
                        <Text key={i} wrap="wrap">{line || ' '}</Text>
                    ))}
                </Box>
                <Text dimColor>{'\n'}[n/Enter] ask another  [q/Esc] close</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="yellow" width={Math.min(cols - 2, 80)}>
            <Text bold color="yellow">SDLC Framework Help</Text>
            <Text dimColor>Ask anything about SDLC Framework — GUI, TUI, agents, config, step mode…</Text>
            {messages.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                    {messages.slice(-2).map((m, i) => (
                        <Box key={i} gap={1}>
                            <Text color={m.role === 'user' ? 'green' : 'cyan'} bold>
                                {m.role === 'user' ? 'You:' : 'AI: '}
                            </Text>
                            <Text wrap="wrap" dimColor={m.role === 'assistant'}>{m.content.slice(0, 120)}{m.content.length > 120 ? '…' : ''}</Text>
                        </Box>
                    ))}
                </Box>
            )}
            <Box marginTop={1} gap={1}>
                <Text color="green">{'>'}</Text>
                <TextInput
                    value={query}
                    onChange={setQuery}
                    onSubmit={(v) => void submit(v)}
                    placeholder="Type your question and press Enter…"
                />
            </Box>
            <Text dimColor>[Esc/q] close</Text>
        </Box>
    );
}
HelpView.displayName = 'HelpView';
