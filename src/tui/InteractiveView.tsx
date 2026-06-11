import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { AssignView } from './AssignView';
import { ChatView } from './ChatView';
import { DirectChatView } from './DirectChatView';
import { ApproveView } from './ApproveView';
import { StatusView } from './StatusView';
import { AgentsView } from './AgentsView';
import { TasksView } from './TasksView';
import { CreateStoryView } from './CreateStoryView';
import { TerminalView } from './TerminalView';
import { ProvidersView } from './ProvidersView';
import App from './App';
import { getEnabledAgents, resolveWorkspaceForAgent, discoverAgentsFromStatusFiles } from './workspace';
import type { ExecMode } from './executionMode';
import { MODE_LABELS } from './executionMode';

interface Props { agent: string | null; dir: string }

type SchedulerWorkflowMode = 'notify' | 'autonomous';
type Screen = 'menu' | 'assign' | 'chat' | 'direct-chat' | 'dashboard' | 'approve' | 'status' | 'agents' | 'tasks' | 'terminal' | 'create-story' | 'switch-agent' | 'set-mode' | 'set-scheduler-mode' | 'toggle-cursor-ai' | 'toggle-claude-ai' | 'toggle-opencode' | 'set-loop-provider' | 'set-agent-model' | 'providers';

const API_BASE = 'http://localhost:3847';
const MAINFRAME_ID = 'sdlc-framework';

const SCHEDULER_LABELS: Record<SchedulerWorkflowMode, string> = {
    notify: 'Notify — approve before workflow unless agent auto-starts',
    autonomous: 'Autonomous — start workflow on assign / design handoff',
};

const AGENT_MENU_ITEMS = [
    { label: 'Chat with AI', value: 'direct-chat' as const },
    { label: 'Set model', value: 'set-agent-model' as const },
    { label: 'Watch dashboard', value: 'dashboard' as const },
    { label: 'View tasks', value: 'tasks' as const },
    { label: 'View agent log', value: 'terminal' as const },
    { label: 'Pick up a story', value: 'assign' as const },
    { label: 'Create a story', value: 'create-story' as const },
    { label: 'Chat with agent (/btw)', value: 'chat' as const },
    { label: 'Approve workflow', value: 'approve' as const },
    { label: 'Check status', value: 'status' as const },
    { label: 'View all agents', value: 'agents' as const },
    { label: 'View providers', value: 'providers' as const },
    { label: 'Switch agent', value: 'switch-agent' as const },
];

const MAINFRAME_MENU_ITEMS = [
    { label: 'Create a story', value: 'create-story' as const },
    { label: 'View all agents', value: 'agents' as const },
    { label: 'Watch dashboard', value: 'dashboard' as const },
    { label: 'Assign story to agent', value: 'assign' as const },
    { label: 'Execution mode', value: 'set-mode' as const },
    { label: 'Scheduler mode', value: 'set-scheduler-mode' as const },
    { label: 'View providers', value: 'providers' as const },
    { label: 'Switch to agent', value: 'switch-agent' as const },
];

function getAvailableAgents(dir: string): string[] {
    const configured = getEnabledAgents();
    if (configured.length > 0) return configured;
    return discoverAgentsFromStatusFiles(dir);
}

export function InteractiveView({ agent: initialAgent, dir: initialDir }: Props) {
    const [agent, setAgent] = useState<string | null>(initialAgent);
    const [screen, setScreen] = useState<Screen>('menu');
    const [needsAgentPick, setNeedsAgentPick] = useState(!initialAgent);
    const [pickingAgentFor, setPickingAgentFor] = useState<Screen | null>(null);
    const [execMode, setExecMode] = useState<ExecMode>('balanced');
    const [schedulerMode, setSchedulerMode] = useState<SchedulerWorkflowMode>('notify');
    const [cursorAiEnabled, setCursorAiEnabled] = useState(true);
    const [claudeEnabled, setClaudeEnabled] = useState(true);
    const [opencodeEnabled, setOpenCodeEnabled] = useState(true);
    const [lpCurrentKey, setLpCurrentKey] = useState<string | null>(null);
    const [lpKeyInput, setLpKeyInput] = useState('');
    const [lpModelInput, setLpModelInput] = useState('');
    const [lpStep, setLpStep] = useState<'key' | 'model' | 'done'>('key');
    const [lpFetchedModels, setLpFetchedModels] = useState<Array<{ id: string; label: string }>>([]);
    const [lpSaving, setLpSaving] = useState(false);
    const [agentModels, setAgentModels] = useState<Array<{ id: string; label: string }>>([]);
    const [agentModelsLoading, setAgentModelsLoading] = useState(false);

    useEffect(() => {
        fetch(`${API_BASE}/api/execution-mode`)
            .then(r => r.json())
            .then(d => { if (d.mode) setExecMode(d.mode); })
            .catch(() => {});
        fetch(`${API_BASE}/api/scheduler-mode`)
            .then(r => r.json())
            .then(d => { if (d.mode === 'notify' || d.mode === 'autonomous') setSchedulerMode(d.mode); })
            .catch(() => {});
        fetch(`${API_BASE}/api/cursor-ai`)
            .then(r => r.json())
            .then(d => { if (typeof d.enabled === 'boolean') setCursorAiEnabled(d.enabled); })
            .catch(() => {});
        fetch(`${API_BASE}/api/claude-ai`)
            .then(r => r.json())
            .then(d => { if (typeof d.enabled === 'boolean') setClaudeEnabled(d.enabled); })
            .catch(() => {});
        fetch(`${API_BASE}/api/opencode-ai`)
            .then(r => r.json())
            .then(d => { if (typeof d.enabled === 'boolean') setOpenCodeEnabled(d.enabled); })
            .catch(() => {});
        fetch(`${API_BASE}/api/loop-provider`)
            .then(r => r.json())
            .then((d: { apiKey: string | null }) => { setLpCurrentKey(d.apiKey); })
            .catch(() => {});
    }, []);

    const saveLpProvider = useCallback(async (key: string, model: string) => {
        setLpSaving(true);
        try {
            await fetch(`${API_BASE}/api/loop-provider`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey: key || undefined, model: model || undefined }),
            });
            const d = await fetch(`${API_BASE}/api/loop-provider`).then(r => r.json()) as { apiKey: string | null };
            setLpCurrentKey(d.apiKey);
        } catch { /* silent */ } finally {
            setLpSaving(false);
        }
    }, []);

    useEffect(() => {
        if (screen !== 'set-agent-model') return;
        setAgentModelsLoading(true);
        fetch(`${API_BASE}/api/agent/models`)
            .then(r => r.json())
            .then((d: { models?: Array<{ id: string; label: string }> }) => setAgentModels(d.models ?? []))
            .catch(() => setAgentModels([]))
            .finally(() => setAgentModelsLoading(false));
    }, [screen]);

    const isMainframe = initialAgent === MAINFRAME_ID || agent === MAINFRAME_ID;
    const agentDir = (agent && agent !== MAINFRAME_ID)
        ? (resolveWorkspaceForAgent(agent) ?? initialDir)
        : initialDir;

    useInput((_, key) => {
        if (key.escape) {
            if (pickingAgentFor) {
                setPickingAgentFor(null);
                if (isMainframe) setAgent(MAINFRAME_ID);
                return;
            }
            if (screen !== 'menu') {
                if (isMainframe) setAgent(MAINFRAME_ID);
                setScreen('menu');
            }
        }
    });

    if (needsAgentPick) {
        const agents = getAvailableAgents(initialDir);
        if (agents.length === 0) {
            return (
                <Box flexDirection="column" padding={1}>
                    <Text bold color="red">No agents found.</Text>
                    <Text dimColor>No .sdlc-framework.config.json and no *-status.json files in {initialDir}</Text>
                </Box>
            );
        }

        const items = [
            { label: 'SDLC Framework (Mainframe)', value: MAINFRAME_ID },
            ...agents.filter(a => a !== MAINFRAME_ID).map(a => ({ label: a, value: a })),
        ];

        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">SDLC Framework</Text>
                <Text dimColor>Select an agent or the Mainframe:</Text>
                <SelectInput
                    items={items}
                    onSelect={(item) => {
                        setAgent(item.value);
                        setNeedsAgentPick(false);
                        setScreen(item.value === MAINFRAME_ID ? 'menu' : 'status');
                    }}
                />
            </Box>
        );
    }

    const goBack = () => {
        if (isMainframe) setAgent(MAINFRAME_ID);
        setScreen('menu');
    };

    const mainframeMenuItems = [
        ...MAINFRAME_MENU_ITEMS,
        { label: `Cursor AI: ${cursorAiEnabled ? 'ON' : 'OFF'}`, value: 'toggle-cursor-ai' as const },
        { label: `Anthropic: ${claudeEnabled ? 'ON' : 'OFF'}`, value: 'toggle-claude-ai' as const },
        { label: `OpenCode: ${opencodeEnabled ? 'ON' : 'OFF'}`, value: 'toggle-opencode' as const },
        { label: `OpenRouter${lpCurrentKey ? ` (${lpCurrentKey})` : ' — not configured'}`, value: 'set-loop-provider' as const },
    ];
    const menuItems = isMainframe ? mainframeMenuItems : AGENT_MENU_ITEMS;

    if (pickingAgentFor) {
        const agents = getAvailableAgents(initialDir).filter(a => a !== MAINFRAME_ID);
        const items = agents.map(a => ({ label: a, value: a }));
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">SDLC Framework</Text>
                <Text dimColor>Select an agent for this action:</Text>
                <SelectInput
                    items={items}
                    onSelect={(item) => {
                        setAgent(item.value);
                        setScreen(pickingAgentFor);
                        setPickingAgentFor(null);
                    }}
                />
                <Text dimColor>Press Escape to go back.</Text>
            </Box>
        );
    }

    if (screen === 'set-scheduler-mode') {
        const schedItems: { label: string; value: SchedulerWorkflowMode }[] = [
            { label: SCHEDULER_LABELS.notify, value: 'notify' },
            { label: SCHEDULER_LABELS.autonomous, value: 'autonomous' },
        ];
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Scheduler mode</Text>
                <Text dimColor>Controls whether agents wait for dashboard approval after assignment.</Text>
                <Text dimColor>Current: <Text color="cyan">{schedulerMode}</Text></Text>
                <Box marginTop={1}>
                    <SelectInput
                        items={schedItems}
                        initialIndex={schedItems.findIndex(m => m.value === schedulerMode)}
                        onSelect={(item) => {
                            setSchedulerMode(item.value);
                            fetch(`${API_BASE}/api/scheduler-mode`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ mode: item.value }),
                            }).catch(() => {});
                            setScreen('menu');
                        }}
                    />
                </Box>
                <Text dimColor>[Esc] back</Text>
            </Box>
        );
    }

    if (screen === 'set-mode') {
        const modeItems: { label: string; value: ExecMode }[] = [
            { label: 'Efficiency — Goose CLI + Ollama (zero cloud tokens)', value: 'local' },
            { label: 'Balanced — Ollama enrichment + direct API', value: 'balanced' },
            { label: 'Speed — no enrichment, create immediately', value: 'speed' },
        ];
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Execution Mode</Text>
                <Text dimColor>Current: <Text color="cyan">{MODE_LABELS[execMode]}</Text></Text>
                <Box marginTop={1}>
                    <SelectInput
                        items={modeItems}
                        initialIndex={modeItems.findIndex(m => m.value === execMode)}
                        onSelect={(item) => {
                            setExecMode(item.value);
                            fetch(`${API_BASE}/api/execution-mode`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ mode: item.value }),
                            }).catch(() => {});
                            setScreen('menu');
                        }}
                    />
                </Box>
                <Text dimColor>[Esc] back</Text>
            </Box>
        );
    }

    if (screen === 'menu') {
        return (
            <Box flexDirection="column" padding={1}>
                <Box gap={2}>
                    <Text bold color="yellow">SDLC Framework</Text>
                    {isMainframe
                        ? <Text dimColor>Mainframe</Text>
                        : <Text dimColor>Agent: <Text color="cyan">{agent}</Text></Text>
                    }
                    <Text dimColor>[<Text color="magenta">{MODE_LABELS[execMode]}</Text>] [<Text color="green">{schedulerMode}</Text> scheduler]</Text>
                </Box>
                <Text dimColor>What would you like to do?</Text>
                <SelectInput
                    items={menuItems}
                    onSelect={(item) => {
                        if (item.value === 'switch-agent') {
                            setNeedsAgentPick(true);
                        } else if (item.value === 'set-mode') {
                            setScreen('set-mode');
                        } else if (item.value === 'set-scheduler-mode') {
                            setScreen('set-scheduler-mode');
                        } else if (item.value === 'set-loop-provider') {
                            setLpStep('key');
                            setLpKeyInput('');
                            setLpModelInput('');
                            setLpFetchedModels([]);
                            setScreen('set-loop-provider');
                        } else if (item.value === 'toggle-cursor-ai') {
                            const next = !cursorAiEnabled;
                            setCursorAiEnabled(next);
                            fetch(`${API_BASE}/api/cursor-ai`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) }).catch(() => {});
                        } else if (item.value === 'toggle-claude-ai') {
                            const next = !claudeEnabled;
                            setClaudeEnabled(next);
                            fetch(`${API_BASE}/api/claude-ai`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) }).catch(() => {});
                        } else if (item.value === 'toggle-opencode') {
                            const next = !opencodeEnabled;
                            setOpenCodeEnabled(next);
                            fetch(`${API_BASE}/api/opencode-ai`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) }).catch(() => {});
                        } else if (isMainframe && (item.value === 'assign' || item.value === 'chat' || item.value === 'approve' || item.value === 'tasks')) {
                            setPickingAgentFor(item.value);
                        } else {
                            setScreen(item.value);
                        }
                    }}
                />
                <Text dimColor>Press Escape from any screen to return here.</Text>
            </Box>
        );
    }

    if (screen === 'set-loop-provider') {
        if (lpStep === 'key') {
            return (
                <Box flexDirection="column" padding={1}>
                    <Text bold color="yellow">OpenRouter API key</Text>
                    {lpCurrentKey && <Text dimColor>Current: <Text color="cyan">{lpCurrentKey}</Text></Text>}
                    <Text dimColor>Paste your sk-or-v1-… key (Enter to continue, blank to skip):</Text>
                    <TextInput
                        value={lpKeyInput}
                        onChange={setLpKeyInput}
                        onSubmit={key => {
                            if (key.startsWith('sk-or-')) {
                                fetch(`${API_BASE}/api/loop-provider/models`)
                                    .then(r => { if (!r.ok) throw new Error(`Models request failed (${r.status})`); return r.json(); })
                                    .then((d: { models: Array<{ id: string; label: string }> }) => {
                                        if (d.models?.length) setLpFetchedModels(d.models);
                                    }).catch(() => {});
                            }
                            setLpStep('model');
                        }}
                        mask={lpKeyInput.length > 12 ? '*' : undefined}
                    />
                    <Text dimColor>[Enter] next  [Esc] cancel</Text>
                </Box>
            );
        }

        if (lpStep === 'model') {
            if (lpFetchedModels.length > 0) {
                const modelItems = lpFetchedModels.map(m => ({ label: m.label, value: m.id }));
                return (
                    <Box flexDirection="column" padding={1}>
                        <Text bold color="yellow">Select model</Text>
                        <SelectInput
                            items={modelItems}
                            onSelect={item => {
                                void saveLpProvider(lpKeyInput, item.value).then(() => {
                                    setLpStep('done');
                                    setTimeout(() => { setScreen('menu'); }, 1200);
                                });
                            }}
                        />
                        <Text dimColor>[Esc] back</Text>
                    </Box>
                );
            }
            return (
                <Box flexDirection="column" padding={1}>
                    <Text bold color="yellow">Model name</Text>
                    <Text dimColor>e.g. deepseek/deepseek-v3.2  (Enter to save)</Text>
                    <TextInput
                        value={lpModelInput}
                        onChange={setLpModelInput}
                        onSubmit={model => {
                            void saveLpProvider(lpKeyInput, model).then(() => {
                                setLpStep('done');
                                setTimeout(() => { setScreen('menu'); }, 1200);
                            });
                        }}
                    />
                    <Text dimColor>[Esc] cancel</Text>
                </Box>
            );
        }

        return (
            <Box padding={1}>
                <Text color="green">{lpSaving ? 'Saving…' : 'Saved ✓'}</Text>
            </Box>
        );
    }

    if (screen === 'direct-chat') return <DirectChatView agent={agent!} onBack={goBack} />;

    if (screen === 'set-agent-model') {
        if (agentModelsLoading) {
            return (
                <Box flexDirection="column" padding={1}>
                    <Text bold color="yellow">Set model — {agent}</Text>
                    <Text><Spinner type="dots" /> Loading models...</Text>
                </Box>
            );
        }
        if (agentModels.length === 0) {
            return (
                <Box flexDirection="column" padding={1}>
                    <Text bold color="yellow">Set model — {agent}</Text>
                    <Text color="red">No models available. Is the server running?</Text>
                    <Text dimColor>[Esc] back</Text>
                </Box>
            );
        }
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Set model — {agent}</Text>
                <Text dimColor>Select the model this agent will use:</Text>
                <SelectInput
                    items={agentModels.map(m => ({ label: m.label, value: m.id }))}
                    onSelect={item => {
                        fetch(`${API_BASE}/api/agent/model`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ agentId: agent, model: item.value }),
                        }).catch(() => {});
                        setScreen('menu');
                    }}
                />
                <Text dimColor>[Esc] back</Text>
            </Box>
        );
    }

    if (screen === 'assign') return <AssignView agent={agent!} dir={agentDir} onBack={goBack} />;
    if (screen === 'chat') return <ChatView agent={agent!} dir={agentDir} onBack={goBack} />;
    if (screen === 'approve') return <ApproveView agent={agent!} dir={agentDir} onBack={goBack} />;
    if (screen === 'status') return <StatusView agent={agent ?? undefined} dir={agentDir} onBack={goBack} />;
    if (screen === 'providers') return <ProvidersView onBack={goBack} />;
    if (screen === 'agents') return <AgentsView dir={agentDir} onBack={goBack} />;
    if (screen === 'tasks') return <TasksView agent={agent!} dir={agentDir} />;
    if (screen === 'terminal') return <TerminalView agent={agent!} dir={agentDir} onBack={goBack} />;
    if (screen === 'create-story') return <CreateStoryView dir={agentDir} agent={agent ?? undefined} onBack={goBack} />;
    return <App dir={agentDir} agent={agent === MAINFRAME_ID ? 'frontend' : (agent ?? undefined)} />;
}
InteractiveView.displayName = 'InteractiveView';
