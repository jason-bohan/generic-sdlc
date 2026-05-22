import { useState } from 'react';
import type { AgentProfile, AgentStatus } from '../types';

interface UseAgentResult {
    agent: AgentProfile | null;
    agentState: AgentStatus | null;
    setAgentState: (s: AgentStatus) => void;
}

export function useAgent(_agentId: string): UseAgentResult {
    const [agentState, setAgentState] = useState<AgentStatus | null>(null);
    return { agent: null, agentState, setAgentState };
}
