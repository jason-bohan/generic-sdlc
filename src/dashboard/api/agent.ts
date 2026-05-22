import type { AgentStatus } from '../types';

export async function fetchAgentStatus(agentId: string): Promise<AgentStatus> {
    const res = await fetch(`/api/agent/status/${agentId}`);
    if (!res.ok) throw new Error(`Failed to fetch agent status: ${res.status}`);
    return res.json() as Promise<AgentStatus>;
}
