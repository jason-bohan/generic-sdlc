/**
 * Single source for built-in agent **display names** when config does not set
 * `scheduler.agents.<id>.displayName`. Prefer `defaultAgentDisplayName(id)` in code;
 * the dashboard still overrides via profile / API.
 */
export const AGENT_DISPLAY_NAME_DEFAULTS: Readonly<Record<string, string>> = {
    frontend: 'Lasair',
    backend: 'Cairn',
    qa: 'Vigil',
    ux: 'Prism',
    reviewer: 'Brehon',
    devops: 'Cairde',
    aiqa: 'AI Quality Engineer',
};

export function defaultAgentDisplayName(agentId: string): string {
    return AGENT_DISPLAY_NAME_DEFAULTS[agentId] || agentId;
}
