import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { readFileSync, existsSync, readdirSync, statSync, watchFile, unwatchFile } from 'fs';
import { resolve } from 'path';

const MAX_LINES = 25;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b[^[\w]|[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

const TOKEN_COLORS: Record<string, string> = {
    spawn:     'magenta',
    session:   'gray',
    prompt:    'gray',
    tool:      'blue',
    result:    'green',
    message:   'white',
    nudge:     'yellow',
    injection: 'yellow',
    error:     'red',
    complete:  'green',
    exit:      'green',
};

function latestLog(outputDir: string, agentId: string): string | null {
    if (!existsSync(outputDir)) return null;
    const prefix = `${agentId}-`;
    const files = readdirSync(outputDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.log') && /\d{4}-\d{2}-\d{2}T/.test(f))
        .map(f => ({ f, mtime: statSync(resolve(outputDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return files.length ? resolve(outputDir, files[0].f) : null;
}

interface Props { agent: string; dir: string; onBack?: () => void }

export function TerminalView({ agent, dir, onBack }: Props) {
    const outputDir = resolve(dir, '.agent-output');
    const [lines, setLines] = useState<string[]>([]);
    const [logFile, setLogFile] = useState<string | null>(null);

    function load(path: string | null) {
        if (!path) { setLines([]); return; }
        try {
            const raw = stripAnsi(readFileSync(path, 'utf-8'));
            const all = raw.split('\n').filter(l => l.trim());
            setLines(all.slice(-MAX_LINES));
        } catch { setLines([]); }
    }

    useEffect(() => {
        const path = latestLog(outputDir, agent);
        setLogFile(path);
        load(path);
        if (!path) return;
        const refresh = () => load(path);
        watchFile(path, { interval: 1000 }, refresh);
        return () => unwatchFile(path, refresh);
    }, [outputDir, agent]);

    return (
        <Box flexDirection="column" padding={1}>
            <Box gap={2}>
                <Text bold color="yellow">Agent Log</Text>
                <Text color="cyan">{agent}</Text>
                {logFile && <Text dimColor>{logFile.split('/').pop()}</Text>}
            </Box>
            <Box flexDirection="column" marginTop={1}>
                {lines.length === 0
                    ? <Text dimColor>No log found for {agent}</Text>
                    : lines.map((line, i) => {
                        const m = line.match(/^\[(\w+)\]\s+(\S+)\s*(.*)/s);
                        if (m) {
                            const [, token, timestamp, rest] = m;
                            const color = TOKEN_COLORS[token.toLowerCase()] ?? 'white';
                            return (
                                <Box key={i} gap={1}>
                                    <Text color={color} bold>{`[${token}]`}</Text>
                                    <Text dimColor>{timestamp}</Text>
                                    {rest && <Text color={color}>{rest.slice(0, 100)}</Text>}
                                </Box>
                            );
                        }
                        return <Text key={i} dimColor>{line.slice(0, 120)}</Text>;
                    })
                }
            </Box>
            <Box marginTop={1}>
                <Text dimColor>Last {MAX_LINES} lines · refreshes every 1s{onBack ? '  [Esc] back' : ''}</Text>
            </Box>
        </Box>
    );
}
TerminalView.displayName = 'TerminalView';
