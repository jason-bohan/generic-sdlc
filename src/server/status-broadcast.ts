import { normalizeStatus } from './status-normalize';
import { resolveChatCapability } from './chat-capability';
import { getAgentModel } from './route-shared';

/** Normalize status file JSON and attach runtime fields for SSE / API / emitStatusChange. */
export function buildStatusBroadcast(
    raw: Record<string, unknown>,
    agentId: string,
    isRunning: boolean,
    rootDir: string,
): Record<string, unknown> {
    const status = normalizeStatus(raw, agentId, rootDir) as Record<string, unknown>;
    return {
        ...status,
        isRunning,
        chatCapability: resolveChatCapability(raw, agentId, isRunning, rootDir),
        model: getAgentModel(agentId, rootDir),
    };
}
