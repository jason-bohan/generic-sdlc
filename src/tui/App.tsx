import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, Newline, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { resolve } from 'path';

import { PhaseProgress } from './PhaseProgress';
import { TokenUsage } from './TokenUsage';
import { TaskList } from './TaskList';
import { EventLog } from './EventLog';
import { getDefaultStepModePhases } from '../shared/agentPhases';
import { HelpView } from './HelpView';

const API_BASE = 'http://localhost:3847';

interface AppProps { dir?: string; agent?: string }

interface AgentStatus {
    storyNumber: string | null;
    storyName: string | null;
    currentPhase: string;
    currentTask: string | null;
    startedAt: string | null;
    tokens: {
        cloud: { input: number; output: number };
        meshllm?: { input: number; output: number };
        ollama: { input: number; output: number };
        mlx?: { input: number; output: number };
    };
    tasks: Array<{ number: string; name: string; status: string }>;
    prs: Array<{ id: number; title: string; status: string; url?: string }>;
    events: Array<{ timestamp: string; type: string; message: string }>;
}

function getStatusFile(dir?: string, agent?: string) {
    const id = agent ?? 'frontend';
    return resolve(dir ?? process.cwd(), `.${id}-status.json`);
}

function loadStatus(file: string): AgentStatus | null {
    if (!existsSync(file)) return null;
    try {
        return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}

function elapsed(startedAt: string | null): string {
    if (!startedAt) return '--';
    const diff = Date.now() - new Date(startedAt).getTime();
    const m = Math.floor(diff / 60_000);
    const s = Math.floor((diff % 60_000) / 1000);
    if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${m}m ${s}s`;
}

export default function App({ dir, agent = 'frontend' }: AppProps) {
    const statusFile = getStatusFile(dir, agent);
    const [status, setStatus] = useState<AgentStatus | null>(() => loadStatus(statusFile));
    const [tick, setTick] = useState(0);
    const [stepMode, setStepMode] = useState(false);
    const [stepModePhases, setStepModePhases] = useState<string[]>(() => [...getDefaultStepModePhases(agent)]);
    const [continuing, setContinuing] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);

    useEffect(() => {
        const refresh = () => setStatus(loadStatus(statusFile));
        watchFile(statusFile, { interval: 1000 }, refresh);
        return () => unwatchFile(statusFile, refresh);
    }, [statusFile]);

    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        fetch(`${API_BASE}/api/agent/step-mode/${agent}`)
            .then(r => r.json())
            .then(d => {
                setStepMode(!!d.stepMode);
                setStepModePhases(Array.isArray(d.stepModePhases) ? d.stepModePhases : [...getDefaultStepModePhases(agent)]);
            })
            .catch(() => setStepModePhases([...getDefaultStepModePhases(agent)]));
    }, [agent]);

    const toggleStepMode = useCallback(() => {
        fetch(`${API_BASE}/api/agent/step-mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: agent, stepMode: !stepMode }),
        })
            .then(r => r.json())
            .then(d => {
                setStepMode(!!d.stepMode);
                if (Array.isArray(d.stepModePhases)) setStepModePhases(d.stepModePhases);
            })
            .catch(() => {});
    }, [agent, stepMode]);

    const handleContinue = useCallback(() => {
        if (continuing) return;
        setContinuing(true);
        fetch(`${API_BASE}/api/agent/continue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: agent }),
        }).catch(() => {});
        setTimeout(() => setContinuing(false), 3000);
    }, [agent, continuing]);

    const isPausedAtStep = stepMode && status && stepModePhases.includes(status.currentPhase);

    useInput((input, key) => {
        if (helpOpen) return;
        if (input === 's') toggleStepMode();
        if (input === 'n' && isPausedAtStep) handleContinue();
        if (input === '?' || (key.shift && input === '/')) setHelpOpen(true);
    });

    if (helpOpen) {
        return <HelpView onClose={() => setHelpOpen(false)} />;
    }

    if (!status) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">SDLC Framework TUI</Text>
                <Text dimColor>Waiting for .{agent}-status.json...</Text>
                <Text><Spinner type="dots" /> Watching for file</Text>
            </Box>
        );
    }

    const working = status.currentPhase !== 'idle' && status.currentPhase !== 'complete';
    const narrow = (process.stdout.columns ?? 120) < 80;

    return (
        <Box flexDirection="column" padding={1}>
            <Box gap={2}>
                <Text bold color="yellow">SDLC Framework TUI</Text>
                <Text dimColor>{agent}</Text>
                {working && <Text color="green"><Spinner type="dots" /></Text>}
            </Box>

            <Box marginTop={1} gap={1}>
                <Text bold>Story:</Text>
                <Text color="cyan">{status.storyNumber ?? 'None'}</Text>
                <Text>{status.storyName ?? ''}</Text>
            </Box>

            {status.startedAt && (
                <Box gap={1}>
                    <Text dimColor>Elapsed:</Text>
                    <Text>{elapsed(status.startedAt)}</Text>
                </Box>
            )}

            <Newline />

            <Box flexDirection={narrow ? 'column' : 'row'} gap={narrow ? 1 : 4}>
                <PhaseProgress currentPhase={status.currentPhase} />

                <Box flexDirection="column" gap={1}>
                    <TokenUsage cloud={status.tokens.cloud} meshllm={status.tokens.meshllm} ollama={status.tokens.ollama} mlx={status.tokens.mlx} />

                    {status.prs.length > 0 && (
                        <Box flexDirection="column">
                            <Text bold>PRs</Text>
                            {status.prs.map(pr => (
                                <Box key={pr.id} gap={1}>
                                    <Text color="magenta">#{pr.id}</Text>
                                    <Text>{pr.status}</Text>
                                    <Text dimColor>{pr.title}</Text>
                                </Box>
                            ))}
                        </Box>
                    )}
                </Box>
            </Box>

            <Newline />
            <TaskList tasks={status.tasks} currentTask={status.currentTask} />

            <Newline />
            <EventLog events={status.events} />

            <Newline />
            <Box gap={2}>
                <Text dimColor>[s] step mode: <Text color={stepMode ? 'green' : 'gray'}>{stepMode ? 'ON' : 'OFF'}</Text></Text>
                {isPausedAtStep && (
                    <Text color="magenta" bold>{continuing ? 'Spawning...' : '[n] next step'}</Text>
                )}
                <Text dimColor>[?] help</Text>
            </Box>
            <Text dimColor>Auto-refreshing • Ctrl+C to exit</Text>
        </Box>
    );
}
App.displayName = 'TuiApp';
