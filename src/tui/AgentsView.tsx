import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { resolve } from 'path';
import Spinner from 'ink-spinner';
import { discoverAgentsFromStatusFiles } from './workspace';

const API_BASE = 'http://localhost:3847';
const require = createRequire(import.meta.url);
const { AGENT_DISPLAY_NAME_DEFAULTS } = require('../shared/agentDisplayDefaults.ts') as typeof import('../shared/agentDisplayDefaults');

const KNOWN_AGENTS: Record<string, { name: string; role: string }> = {
    frontend: { name: AGENT_DISPLAY_NAME_DEFAULTS.frontend, role: 'Frontend Engineer' },
    backend: { name: AGENT_DISPLAY_NAME_DEFAULTS.backend, role: 'Backend Engineer' },
    qa: { name: AGENT_DISPLAY_NAME_DEFAULTS.qa, role: 'QA Engineer' },
    ux: { name: AGENT_DISPLAY_NAME_DEFAULTS.ux, role: 'UX Designer' },
    reviewer: { name: AGENT_DISPLAY_NAME_DEFAULTS.reviewer, role: 'PR Reviewer' },
    devops: { name: AGENT_DISPLAY_NAME_DEFAULTS.devops, role: 'DevOps Engineer' },
    aiqa: { name: AGENT_DISPLAY_NAME_DEFAULTS.aiqa ?? 'AIQA', role: 'AI QA Engineer' },
    orchestrator: { name: AGENT_DISPLAY_NAME_DEFAULTS.orchestrator ?? 'Orchestrator', role: 'Workflow Orchestrator' },
};

type Action = 'continue' | 'stop' | 'pause' | null;

interface Props { dir: string; onBack?: () => void }

export function AgentsView({ dir, onBack }: Props) {
    const discovered = discoverAgentsFromStatusFiles(dir);
    const knownIds = Object.keys(KNOWN_AGENTS);
    const allIds = [...new Set([...knownIds, ...discovered])].sort();
    const [stepModes, setStepModes] = useState<Record<string, boolean>>({});
    const [agentModels, setAgentModels] = useState<Record<string, string>>({});
    const [cursor, setCursor] = useState(0);
    const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
    const [action, setAction] = useState<Action>(null);
    const [actionResult, setActionResult] = useState<{ ok: boolean; message: string } | null>(null);
    const [showActions, setShowActions] = useState(false);

    useEffect(() => {
        allIds.forEach(id => {
            fetch(`${API_BASE}/api/agent/step-mode/${id}`)
                .then(r => r.json())
                .then(d => setStepModes(prev => ({ ...prev, [id]: !!d.stepMode })))
                .catch(() => {});
            fetch(`${API_BASE}/api/agent/model/${id}`)
                .then(r => r.json())
                .then(d => { if (d.model) setAgentModels(prev => ({ ...prev, [id]: d.model })); })
                .catch(() => {});
        });
    }, []);

    const agentStatus = useCallback((id: string) => {
        const file = resolve(dir, `.${id}-status.json`);
        if (!existsSync(file)) return { phase: 'idle', story: '', isRunning: false, handoffDispatched: false, tasks: [], requests: [] };
        try {
            const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
            return {
                phase: String(data.currentPhase ?? 'idle'),
                story: String(data.storyNumber ?? ''),
                isRunning: data.isRunning as boolean | undefined,
                handoffDispatched: data.handoffDispatched as boolean | undefined,
                tasks: Array.isArray(data.tasks) ? (data.tasks as string[]) : [],
                requests: Array.isArray(data.requests) ? (data.requests as string[]) : [],
            };
        } catch {
            return { phase: 'idle', story: '', isRunning: false, handoffDispatched: false, tasks: [], requests: [] };
        }
    }, [dir]);

    const isPaused = (id: string): boolean => {
        const st = agentStatus(id);
        const stepOn = stepModes[id] ?? false;
        return stepOn && !st.isRunning && st.handoffDispatched !== false && st.phase !== 'idle' && st.phase !== 'complete';
    };

    const doAction = useCallback(async (id: string, act: Action) => {
        if (!act) return;
        setAction(act);
        setActionResult(null);
        try {
            if (act === 'continue') {
                const res = await fetch(`${API_BASE}/api/agent/continue`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentId: id }),
                });
                const data = await res.json();
                setActionResult({ ok: res.ok, message: data.error || data.followup_message || 'Agent continued' });
            } else if (act === 'stop') {
                const res = await fetch(`${API_BASE}/api/agent/stop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentId: id }),
                });
                const data = await res.json();
                setActionResult({ ok: res.ok, message: data.message || data.error || 'Agent stopped' });
            } else if (act === 'pause') {
                const res = await fetch(`${API_BASE}/api/agent/pause`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentId: id }),
                });
                const data = await res.json();
                setActionResult({ ok: res.ok, message: data.error || 'Agent paused' });
            }
        } catch (e: unknown) {
            setActionResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
        }
    }, []);

    useInput((input, key) => {
        if (key.escape) {
            if (showActions) { setShowActions(false); setActionResult(null); return; }
            if (selectedAgent) { setSelectedAgent(null); return; }
            onBack?.();
            return;
        }
        if (key.return || input === '\r') {
            if (showActions) return;
            if (selectedAgent) { setShowActions(true); setActionResult(null); return; }
            setSelectedAgent(allIds[cursor]);
            return;
        }
        if (showActions) {
            if (input === 'c' || input === 'C') { void doAction(selectedAgent!, 'continue'); return; }
            if (input === 's' || input === 'S') { void doAction(selectedAgent!, 'stop'); return; }
            if (input === 'p' || input === 'P') { void doAction(selectedAgent!, 'pause'); return; }
            return;
        }
        if (selectedAgent) {
            setSelectedAgent(null);
            return;
        }
        if (key.upArrow) { setCursor(i => Math.max(0, i - 1)); }
        if (key.downArrow) { setCursor(i => Math.min(allIds.length - 1, i + 1)); }
    });

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="yellow">sdlc-framework agents</Text>
            <Text dimColor>{showActions ? 'Select action' : 'Use ↑↓ to navigate, Enter to select'}</Text>

            {allIds.map((id, i) => {
                const st = agentStatus(id);
                const info = KNOWN_AGENTS[id] ?? { name: id, role: 'Agent' };
                const active = st.isRunning !== false && st.phase !== 'idle' && st.phase !== 'complete' && st.phase !== 'build-passed';
                const inStepMode = stepModes[id] ?? false;
                const paused = isPaused(id);
                const isCursor = i === cursor && !selectedAgent && !showActions;
                const isSelected = selectedAgent === id && !showActions;
                const color = active ? 'green' : paused ? 'magenta' : 'gray';

                return (
                    <Box key={id} gap={1}>
                        <Text color={color} bold={active || paused}>
                            {isCursor ? '❯' : isSelected ? '•' : ' '}
                        </Text>
                        <Text color={color} bold={isCursor || isSelected}>
                            {(active ? '●' : paused ? '◆' : '○')}
                        </Text>
                        <Text bold color={isCursor || isSelected ? 'white' : color}>
                            {info.name.padEnd(12)}
                        </Text>
                        <Text dimColor>{info.role.padEnd(20)}</Text>
                        <Text color={active ? 'green' : paused ? 'magenta' : 'gray'}>{st.phase.padEnd(18)}</Text>
                        {inStepMode && <Text color="magenta" bold>[step]</Text>}
                        {paused && !inStepMode && <Text color="yellow">[paused]</Text>}
                        {st.story && <Text color="cyan">{st.story}</Text>}
                        {agentModels[id] && agentModels[id] !== 'auto' && (
                            <Text color={agentModels[id] === 'local' ? 'green' : 'blue'}> [{agentModels[id]}]</Text>
                        )}
                    </Box>
                );
            })}

            {selectedAgent && !showActions && (() => {
                const st = agentStatus(selectedAgent);
                const info = KNOWN_AGENTS[selectedAgent] ?? { name: selectedAgent, role: 'Agent' };
                return (
                    <Box marginTop={1} flexDirection="column" borderStyle="round" padding={1}>
                        <Text bold color="white">{info.name}</Text>
                        <Text dimColor>Phase: {st.phase} | Story: {st.story || '—'} | Running: {String(st.isRunning)}</Text>
                        {st.tasks.length > 0 && (
                            <Box marginTop={1} flexDirection="column">
                                <Text bold color="cyan">Tasks</Text>
                                {st.tasks.map((t, i) => (
                                    <Text key={i} dimColor>{i + 1}. {t.slice(0, 100)}</Text>
                                ))}
                            </Box>
                        )}
                        {st.requests.length > 0 && (
                            <Box marginTop={1} flexDirection="column">
                                <Text bold color="yellow">Requests</Text>
                                {st.requests.map((r, i) => (
                                    <Text key={i} dimColor>{i + 1}. {r.slice(0, 100)}</Text>
                                ))}
                            </Box>
                        )}
                        <Box marginTop={1}><Text dimColor>Enter for actions • Esc back</Text></Box>
                    </Box>
                );
            })()}

            {showActions && selectedAgent && (
                <Box marginTop={1} flexDirection="column" borderStyle="round" padding={1}>
                    <Text bold color="yellow">Actions for {selectedAgent}</Text>
                    <Text dimColor>Phase: {agentStatus(selectedAgent).phase} | Story: {agentStatus(selectedAgent).story || '—'}</Text>
                    <Box marginTop={1} gap={2}>
                        <Text bold color="cyan">[C]</Text><Text>Continue agent</Text>
                        <Text bold color="red">[S]</Text><Text>Stop agent</Text>
                        <Text bold color="magenta">[P]</Text><Text>Pause agent</Text>
                        <Text dimColor>[Esc] back</Text>
                    </Box>
                    {action && actionResult === null && (
                        <Box gap={1}><Spinner type="dots" /><Text>{action === 'continue' ? 'Continuing...' : 'Stopping...'}</Text></Box>
                    )}
                    {actionResult && (
                        <Box>
                            <Text color={actionResult.ok ? 'green' : 'red'}>
                                {actionResult.ok ? '✓' : '✖'} {actionResult.message}
                            </Text>
                        </Box>
                    )}
                </Box>
            )}

            {onBack && !selectedAgent && !showActions && (
                <Box marginTop={1}>
                    <Text dimColor>[Esc] back to menu</Text>
                </Box>
            )}
        </Box>
    );
}
AgentsView.displayName = 'AgentsView';
