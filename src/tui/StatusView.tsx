import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { resolve } from 'path';
import { PHASE_COLORS } from './workspace';

interface Props { agent?: string; dir: string; onBack?: () => void }

function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

export function StatusView({ agent, dir, onBack }: Props) {
    const id = agent ?? 'frontend';
    const file = resolve(dir, `.${id}-status.json`);
    const [data, setData] = useState<any>(null);
    const [err, setErr] = useState<string | null>(null);

    function load() {
        if (!existsSync(file)) { setErr(`No status file for ${id}`); return; }
        try {
            setData(JSON.parse(readFileSync(file, 'utf-8')));
            setErr(null);
        } catch { setErr(`Failed to parse ${file}`); }
    }

    useEffect(() => {
        load();
        const refresh = () => load();
        watchFile(file, { interval: 2000 }, refresh);
        return () => unwatchFile(file, refresh);
    }, [file]);

    if (err) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">sdlc-framework status</Text>
                <Text color="red">{err}</Text>
                {onBack && <Text dimColor>Press Escape for menu</Text>}
            </Box>
        );
    }

    if (!data) return <Text dimColor>Loading...</Text>;

    const tokens = {
        cloud: data.tokens?.cloud ?? { input: 0, output: 0 },
        meshllm: data.tokens?.meshllm ?? { input: 0, output: 0 },
        ollama: data.tokens?.ollama ?? { input: 0, output: 0 },
    };
    const phase = data.currentPhase ?? 'idle';
    const phaseColor = PHASE_COLORS[phase] ?? 'white';
    const tasks = data.tasks ?? [];
    const completed = tasks.filter((t: any) => t.status === 'completed' || t.status === 'complete').length;
    const events = data.events ?? [];
    const recentEvents = events.slice(-5);

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="yellow">sdlc-framework status — {id}</Text>
            <Box gap={1}><Text bold>Story:</Text><Text color="cyan">{data.storyNumber ?? 'None'}</Text><Text>{data.storyName ?? ''}</Text></Box>
            <Box gap={1}><Text bold>Phase:</Text><Text color={phaseColor}>{phase}</Text></Box>
            {data.currentTask && <Box gap={1}><Text bold>Task:</Text><Text>{data.currentTask}</Text></Box>}
            <Box gap={1}><Text bold>Cloud:</Text><Text>{fmt(tokens.cloud.input)} in / {fmt(tokens.cloud.output)} out</Text></Box>
            <Box gap={1}><Text bold>MeshLLM:</Text><Text>{fmt(tokens.meshllm.input)} in / {fmt(tokens.meshllm.output)} out</Text></Box>
            <Box gap={1}><Text bold>Ollama:</Text><Text>{fmt(tokens.ollama.input)} in / {fmt(tokens.ollama.output)} out</Text></Box>
            <Box gap={1}><Text bold>Tasks:</Text><Text>{completed}/{tasks.length} completed</Text></Box>
            <Box gap={1}><Text bold>PRs:</Text><Text>{data.prs?.length ?? 0}</Text></Box>

            {recentEvents.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                    <Text bold dimColor>Recent events:</Text>
                    {recentEvents.map((e: any, i: number) => (
                        <Box key={i} gap={1}>
                            <Text dimColor>{e.timestamp?.slice(11, 19) ?? ''}</Text>
                            <Text color={e.type === 'error' ? 'red' : e.type === 'warning' ? 'yellow' : e.type === 'success' ? 'green' : 'white'}>
                                {e.message}
                            </Text>
                        </Box>
                    ))}
                </Box>
            )}

            <Box marginTop={1}>
                <Text dimColor>Live — refreshes every 2s.{onBack ? ' Press Escape for menu.' : ''}</Text>
            </Box>
        </Box>
    );
}
StatusView.displayName = 'StatusView';
