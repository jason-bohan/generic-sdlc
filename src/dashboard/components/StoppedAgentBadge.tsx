import { useState } from 'react';
import type { AgentStatus } from '../types';

interface StoppedAgentBadgeProps {
    agent: AgentStatus;
}

export function StoppedAgentBadge({ agent }: StoppedAgentBadgeProps) {
    const [open, setOpen] = useState(false);

    const isStopped =
        agent.storyNumber &&
        agent.currentPhase !== 'idle' &&
        !agent.isRunning &&
        agent.globalStepMode;

    if (!isStopped) return null;

    return (
        <span style={{ position: 'relative', display: 'inline-block' }}>
            <span
                onClick={() => setOpen(v => !v)}
                style={{ cursor: 'pointer', background: '#c00', color: '#fff', padding: '2px 6px', borderRadius: 3, fontSize: 11 }}
            >
                STOPPED
            </span>
            {open && (
                <span style={{ position: 'absolute', top: '100%', left: 0, background: '#222', color: '#fff', padding: '4px 10px', borderRadius: 4, zIndex: 10 }}>
                    Resume
                </span>
            )}
        </span>
    );
}

interface ResumeChipProps {
    agent: AgentStatus;
    onResume: () => void;
}

export function ResumeChip({ agent, onResume }: ResumeChipProps) {
    const handleResume = async () => {
        await fetch('/api/agent/continue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agentId: (agent as AgentStatus & { id?: string }).id,
                selectedRequestIds: undefined,
                selectedTaskIds: undefined,
            }),
        });
        onResume();
    };

    return (
        <button onClick={handleResume}>Resume</button>
    );
}
