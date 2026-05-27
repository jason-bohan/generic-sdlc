import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { resolve } from 'path';
import { checkServer, API_BASE } from './workspace';

interface Task {
    id?: string;
    number?: string;
    name: string;
    status: string;
    hours?: number;
}

interface Props { agent: string; dir: string }

const STATUS_ICONS: Record<string, string> = {
    pending: '○',
    in_progress: '▶',
    completed: '✓',
    complete: '✓',
    failed: '✖',
};

const STATUS_COLORS: Record<string, string> = {
    pending: 'gray',
    in_progress: 'yellow',
    completed: 'green',
    complete: 'green',
    failed: 'red',
};

type Mode = 'view' | 'creating' | 'syncing';

export function TasksView({ agent, dir }: Props) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [storyNumber, setStoryNumber] = useState<string | null>(null);
    const [currentTask, setCurrentTask] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>('view');
    const [createName, setCreateName] = useState('');
    const [createEstimate, setCreateEstimate] = useState('');
    const [createStep, setCreateStep] = useState<'name' | 'estimate'>('name');
    const [message, setMessage] = useState<string | null>(null);

    const statusFile = resolve(dir, `.${agent}-status.json`);

    function loadFromFile() {
        if (!existsSync(statusFile)) return;
        try {
            const data = JSON.parse(readFileSync(statusFile, 'utf-8'));
            setTasks(data.tasks ?? []);
            setStoryNumber(data.storyNumber ?? null);
            setCurrentTask(data.currentTask ?? null);
        } catch { /* ignore */ }
    }

    useEffect(() => {
        loadFromFile();
        const refresh = () => loadFromFile();
        watchFile(statusFile, { interval: 2000 }, refresh);
        return () => unwatchFile(statusFile, refresh);
    }, [statusFile]);

    async function doSync() {
        if (!storyNumber) {
            setMessage('No story assigned — nothing to sync');
            return;
        }
        const ok = await checkServer();
        if (!ok) {
            setMessage('Cannot connect to server at localhost:3847. Start it with `npm run dev`.');
            return;
        }
        setMode('syncing');
        try {
            const res = await fetch(`${API_BASE}/api/planning/tasks/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent, storyNumber }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setTasks(data.tasks ?? []);
            setMessage(`Synced ${(data.tasks ?? []).length} tasks from Agility`);
        } catch (e: any) {
            setMessage(`Sync failed: ${e.message}`);
        }
        setMode('view');
    }

    async function doCreate() {
        if (!storyNumber || !createName.trim()) return;
        const ok = await checkServer();
        if (!ok) {
            setMessage('Cannot connect to server at localhost:3847. Start it with `npm run dev`.');
            return;
        }
        setMode('syncing');
        try {
            const res = await fetch(`${API_BASE}/api/scheduler/create-task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agentId: agent,
                    storyNumber,
                    name: createName.trim(),
                    estimate: parseFloat(createEstimate) || undefined,
                }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setMessage(`Created task ${data.number}: ${data.name}`);
            loadFromFile();
        } catch (e: any) {
            setMessage(`Create failed: ${e.message}`);
        }
        setCreateName('');
        setCreateEstimate('');
        setCreateStep('name');
        setMode('view');
    }

    useInput((input, key) => {
        if (mode !== 'view') return;
        if (input === 's') doSync();
        if (input === 'c' && storyNumber) {
            setMode('creating');
            setCreateStep('name');
            setMessage(null);
        }
    });

    const completed = tasks.filter(t => t.status === 'completed' || t.status === 'complete').length;

    return (
        <Box flexDirection="column" padding={1}>
            <Box gap={2}>
                <Text bold color="yellow">Tasks</Text>
                <Text dimColor>Agent: <Text color="cyan">{agent}</Text></Text>
                {storyNumber && <Text dimColor>Story: <Text color="cyan">{storyNumber}</Text></Text>}
            </Box>
            <Text dimColor>{completed}/{tasks.length} completed</Text>

            <Box flexDirection="column" marginTop={1}>
                {tasks.length === 0 && <Text dimColor>No tasks yet</Text>}
                {tasks.map((t, i) => {
                    const key = t.number ?? t.id ?? String(i);
                    const isCurrent = currentTask && (currentTask === t.number || currentTask === t.id);
                    const icon = STATUS_ICONS[t.status] ?? '?';
                    const color = STATUS_COLORS[t.status] ?? 'white';
                    return (
                        <Box key={key} gap={1}>
                            <Text color={color} bold={!!isCurrent}>{icon}</Text>
                            <Text dimColor>{(t.number ?? t.id ?? '').padEnd(10)}</Text>
                            <Text bold={!!isCurrent}>{t.name}</Text>
                            {t.hours != null && t.hours > 0 && <Text dimColor> ({t.hours}h)</Text>}
                            {isCurrent && <Text color="yellow"> ← active</Text>}
                        </Box>
                    );
                })}
            </Box>

            {mode === 'creating' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text bold color="cyan">Create Task</Text>
                    {createStep === 'name' && (
                        <Box gap={1}>
                            <Text>Name:</Text>
                            <TextInput
                                value={createName}
                                onChange={setCreateName}
                                onSubmit={() => {
                                    if (createName.trim()) setCreateStep('estimate');
                                }}
                            />
                        </Box>
                    )}
                    {createStep === 'estimate' && (
                        <Box gap={1}>
                            <Text>Estimate (hours):</Text>
                            <TextInput
                                value={createEstimate}
                                onChange={setCreateEstimate}
                                onSubmit={() => doCreate()}
                            />
                        </Box>
                    )}
                    <Text dimColor>Press Escape to cancel</Text>
                </Box>
            )}

            {mode === 'syncing' && (
                <Box marginTop={1} gap={1}>
                    <Text color="green"><Spinner type="dots" /></Text>
                    <Text>Working...</Text>
                </Box>
            )}

            {message && (
                <Box marginTop={1}>
                    <Text color="green">{message}</Text>
                </Box>
            )}

            {mode === 'view' && (
                <Box marginTop={1}>
                    <Text dimColor>[s] sync from planner  {storyNumber ? '[c] create task  ' : ''}[Esc] back</Text>
                </Box>
            )}
        </Box>
    );
}
TasksView.displayName = 'TasksView';
