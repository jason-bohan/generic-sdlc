import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { loadConfig, checkServer, API_BASE } from './workspace';

interface Story { number: string; name: string; status: string }
interface Props { agent: string; story?: string; dir: string; onBack?: () => void }

export function AssignView({ agent, story, dir, onBack }: Props) {
    const { exit } = useApp();
    const [stories, setStories] = useState<Story[]>([]);
    const [loading, setLoading] = useState(!story);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        checkServer().then(ok => {
            if (!ok) {
                setError('Cannot connect to server at localhost:3847. Start it with `npm run dev`.');
                setLoading(false);
                return;
            }
            if (story) {
                doAssign(story);
                return;
            }
            const team = loadConfig()?.project?.team ?? 'Ninja Turtles';
            fetch(`${API_BASE}/api/agility/stories?team=${encodeURIComponent(team)}`)
            .then(r => r.json())
            .then(data => {
                setStories(data.stories ?? []);
                setLoading(false);
            })
            .catch(e => { setError(e.message); setLoading(false); });
        });
    }, []);

    async function doAssign(storyNumber: string) {
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE}/api/scheduler/assign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent, storyNumber, storyName: stories.find(s => s.number === storyNumber)?.name }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setResult(`Assigned ${storyNumber} to ${agent}`);
        } catch (e: any) {
            setError(e.message);
        }
        setLoading(false);
    }

    if (error) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="red">Error: {error}</Text>
                {onBack && <Box marginTop={1}><Text dimColor>[Esc] back to menu</Text></Box>}
            </Box>
        );
    }

    if (result) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="green">✓ {result}</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text bold color="yellow">⚡ Next step: Approve the workflow</Text>
                    <Text dimColor>  Run:  <Text color="cyan">sdlc-framework approve --agent {agent}</Text></Text>
                    <Text dimColor>  Or select "Approve workflow" from the interactive menu</Text>
                </Box>
                {onBack && <Box marginTop={1}><Text dimColor>[Esc] back to menu</Text></Box>}
            </Box>
        );
    }

    if (loading) {
        return (
            <Box padding={1} gap={1}>
                <Text color="green"><Spinner type="dots" /></Text>
                <Text>{story ? `Assigning ${story}...` : 'Loading stories...'}</Text>
            </Box>
        );
    }

    if (stories.length === 0) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text color="yellow">No stories available</Text>
                {onBack && <Box marginTop={1}><Text dimColor>[Esc] back to menu</Text></Box>}
            </Box>
        );
    }

    const items = stories.map(s => ({
        label: `${s.number} — ${s.name} [${s.status}]`,
        value: s.number,
    }));

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="yellow">Assign a story to {agent}</Text>
            <Text dimColor>Use arrow keys to select, Enter to confirm</Text>
            <SelectInput items={items} onSelect={(item) => doAssign(item.value)} />
            {onBack && <Text dimColor>[Esc] back to menu</Text>}
        </Box>
    );
}
AssignView.displayName = 'AssignView';
