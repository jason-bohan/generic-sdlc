import type { AgentStatus } from '../types';
import { formatTokens } from '../agent-detail-utils';
import { StatCard } from './DetailHelpers';
import { agentDetailStyles as s } from './AgentDetail.styles';

export interface AgentDetailStatsProps {
    elapsed: string;
    status: AgentStatus;
}

export function AgentDetailStats({ elapsed, status }: AgentDetailStatsProps) {
    const cloud = status.tokens?.cloud ?? { input: 0, output: 0 };
    const meshllm = status.tokens?.meshllm ?? { input: 0, output: 0 };
    const ollama = status.tokens?.ollama ?? { input: 0, output: 0 };
    const cloudTotal = cloud.input + cloud.output;
    const meshllmTotal = meshllm.input + meshllm.output;
    const ollamaTotal = ollama.input + ollama.output;
    const localLikeTotal = meshllmTotal + ollamaTotal;
    const tokensSaved = localLikeTotal > 0 ? Math.round((localLikeTotal / (cloudTotal + localLikeTotal)) * 100) : 0;

    const tasks = status.tasks ?? [];
    const prs = status.prs ?? [];
    const tasksCompleted = tasks.filter((t) => t.status === 'completed').length;
    const totalHours = tasks.reduce((sum, t) => sum + (t.hours ?? 0), 0);
    const completedHours = tasks
        .filter((t) => t.status === 'completed')
        .reduce((sum, t) => sum + (t.hours ?? 0), 0);

    return (
        <div style={s.statsGrid}>
            <StatCard label="Elapsed" value={elapsed} />
            <StatCard
                label="Cloud Tokens"
                value={formatTokens(cloudTotal)}
                sub={`In: ${formatTokens(cloud.input)} / Out: ${formatTokens(cloud.output)}`}
            />
            <StatCard
                label="MeshLLM Tokens"
                value={formatTokens(meshllmTotal)}
                sub={`In: ${formatTokens(meshllm.input)} / Out: ${formatTokens(meshllm.output)}`}
                tone="accent"
            />
            <StatCard
                label="Ollama Tokens"
                value={formatTokens(ollamaTotal)}
                sub={`In: ${formatTokens(ollama.input)} / Out: ${formatTokens(ollama.output)}`}
            />
            <StatCard
                label="Tokens Saved"
                value={`${tokensSaved}%`}
                tone={tokensSaved > 30 ? 'success' : undefined}
            />
            <StatCard
                label="Tasks"
                value={`${tasksCompleted}/${tasks.length}`}
                sub={`${completedHours}h / ${totalHours}h`}
            />
            <StatCard
                label="PRs Open"
                value={String(prs.filter((p) => p.status === 'active').length)}
            />
        </div>
    );
}
AgentDetailStats.displayName = 'AgentDetailStats';
