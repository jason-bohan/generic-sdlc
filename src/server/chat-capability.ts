import { getActiveSessionId } from './agent-runner/registry';
import { getAgentModel } from './route-shared';

export type ChatCapability = 'live' | 'auto-reply' | 'unavailable';

/** Prefer stored chatCapability (E2E seeding); otherwise derive from runner/model state. */
export function resolveChatCapability(
    raw: Record<string, unknown>,
    agentId: string,
    isRunning: boolean,
    rootDir: string,
): ChatCapability {
    const stored = raw.chatCapability;
    if (stored === 'live' || stored === 'auto-reply' || stored === 'unavailable') {
        return stored;
    }
    if (getActiveSessionId(agentId)) return 'live';
    if (isRunning && getAgentModel(agentId, rootDir) === 'local') return 'unavailable';
    return 'auto-reply';
}
