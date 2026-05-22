import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { discoverAgentsFromStatusFiles } from './workspace';
import { AGENT_DISPLAY_NAME_DEFAULTS } from '../shared/agentDisplayDefaults';

const API_BASE = 'http://localhost:3847';

const KNOWN_AGENTS: Record<string, { name: string; role: string }> = {
    frontend: { name: AGENT_DISPLAY_NAME_DEFAULTS.frontend, role: 'Frontend Engineer' },
    backend: { name: AGENT_DISPLAY_NAME_DEFAULTS.backend, role: 'Backend Engineer' },
    qa: { name: AGENT_DISPLAY_NAME_DEFAULTS.qa, role: 'QA Engineer' },
    ux: { name: AGENT_DISPLAY_NAME_DEFAULTS.ux, role: 'UX Designer' },
    reviewer: { name: AGENT_DISPLAY_NAME_DEFAULTS.reviewer, role: 'PR Reviewer' },
    devops: { name: AGENT_DISPLAY_NAME_DEFAULTS.devops, role: 'DevOps Engineer' },
};

interface Props { dir: string; onBack?: () => void }

export function AgentsView({ dir, onBack }: Props) {
    const discovered = discoverAgentsFromStatusFiles(dir);
    const knownIds = Object.keys(KNOWN_AGENTS);
    const allIds = [...new Set([...knownIds, ...discovered])].sort();
    const [stepModes, setStepModes] = useState<Record<string, boolean>>({});
    const [agentModels, setAgentModels] = useState<Record<string, string>>({});

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

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="yellow">sdlc-framework agents</Text>
            {allIds.map(id => {
                const info = KNOWN_AGENTS[id] ?? { name: id, role: 'Agent' };
                const file = resolve(dir, `.${id}-status.json`);
                let phase = 'idle';
                let story = '';
                if (existsSync(file)) {
                    try {
                        const data = JSON.parse(readFileSync(file, 'utf-8'));
                        phase = data.currentPhase ?? 'idle';
                        story = data.storyNumber ?? '';
                    } catch { /* ignore */ }
                }
                const active = phase !== 'idle' && phase !== 'complete' && phase !== 'build-passed';
                const inStepMode = stepModes[id] ?? false;
                return (
                    <Box key={id} gap={1}>
                        <Text color={active ? 'green' : 'gray'} bold={active}>
                            {active ? '●' : '○'}
                        </Text>
                        <Text bold>{info.name.padEnd(12)}</Text>
                        <Text dimColor>{info.role.padEnd(20)}</Text>
                        <Text color={active ? 'green' : 'gray'}>{phase}</Text>
                        {inStepMode && <Text color="magenta"> [step]</Text>}
                        {story && <Text color="cyan"> {story}</Text>}
                        {agentModels[id] && agentModels[id] !== 'auto' && (
                            <Text color={agentModels[id] === 'local' ? 'green' : 'blue'}> [{agentModels[id]}]</Text>
                        )}
                    </Box>
                );
            })}
            {onBack && (
                <Box marginTop={1}>
                    <Text dimColor>[Esc] back to menu</Text>
                </Box>
            )}
        </Box>
    );
}
AgentsView.displayName = 'AgentsView';
