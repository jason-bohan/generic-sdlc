import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

interface Props { agent: string; dir: string; onBack?: () => void }

const API_BASE = 'http://localhost:3847';

export function ApproveView({ agent, dir, onBack }: Props) {
    const { exit } = useApp();
    const [status, setStatus] = useState<'checking' | 'approving' | 'done' | 'error' | 'not-pending'>('checking');
    const [message, setMessage] = useState('');

    useEffect(() => { checkAndApprove(); }, []);

    async function checkAndApprove() {
        const file = resolve(dir, `.${agent}-status.json`);
        if (!existsSync(file)) {
            setStatus('error');
            setMessage(`No status file for ${agent}`);
            return;
        }

        try {
            const data = JSON.parse(readFileSync(file, 'utf-8'));
            if (data.currentPhase !== 'pending-approval') {
                setStatus('not-pending');
                setMessage(`${agent} is in phase "${data.currentPhase}", not pending-approval`);
                return;
            }
        } catch {
            setStatus('error');
            setMessage('Failed to read status file');
            return;
        }

        setStatus('approving');
        try {
            const res = await fetch(`${API_BASE}/api/scheduler/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setStatus('done');
            setMessage(`Approved workflow for ${agent}`);
        } catch (e: any) {
            setStatus('error');
            setMessage(e.message);
        }
    }

    const color = status === 'done' ? 'green' : status === 'error' ? 'red' : status === 'not-pending' ? 'yellow' : 'white';
    const icon = status === 'done' ? '✓' : status === 'error' ? '✖' : status === 'not-pending' ? '⚠' : '';

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="yellow">sdlc-framework approve {agent}</Text>
            {(status === 'checking' || status === 'approving') && (
                <Box gap={1}>
                    <Text color="green"><Spinner type="dots" /></Text>
                    <Text>{status === 'checking' ? 'Checking status...' : 'Approving...'}</Text>
                </Box>
            )}
            {message && <Text color={color} bold>{icon} {message}</Text>}
            {status === 'done' && (
                <Box marginTop={1} flexDirection="column">
                    <Text bold color="yellow">⚡ Next step: Start the agent</Text>
                    <Text dimColor>  The agent needs a Cursor session to run. Pick one:</Text>
                    <Text> </Text>
                    <Text dimColor>  1. Open a new Cursor agent window and say:</Text>
                    <Text color="cyan">     "start {agent}"</Text>
                    <Text> </Text>
                    <Text dimColor>  2. Or run from the terminal:</Text>
                    <Text color="cyan">     agent "Check .{agent}-status.json and follow the agent-autostart rule"</Text>
                    {onBack && <Box marginTop={1}><Text dimColor>[Esc] back to menu</Text></Box>}
                </Box>
            )}
        </Box>
    );
}
ApproveView.displayName = 'ApproveView';
