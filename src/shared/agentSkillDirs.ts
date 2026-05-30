/**
 * Canonical agent IDs match `skills/<id>/`. Optional aliases kept for tooling.
 */
export const AGENT_SKILL_SUBDIR_BY_ID: Record<string, string> = {
    frontend: 'frontend',
    backend: 'backend',
    qa: 'qa',
    ux: 'ux',
    reviewer: 'reviewer',
    devops: 'devops',
    aiqa: 'aiqa',
};

export function skillSubdirForAgentId(agentId: string): string {
    return AGENT_SKILL_SUBDIR_BY_ID[agentId] ?? agentId;
}
