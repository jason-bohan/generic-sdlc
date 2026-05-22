import { describe, it, expect } from 'vitest';
import { resolveAdoPatForAgent } from '../server/ado-bridge';

describe('resolveAdoPatForAgent', () => {
    const base = {
        workspaceDir: '/tmp',
        organization: 'o',
        azureProject: 'p',
        repositoryId: 'r',
        prUrlBase: 'u',
        reviewerIds: [],
        pat: 'global-pat',
    };

    it('returns global PAT when agent has no override', () => {
        expect(resolveAdoPatForAgent(base, 'frontend')).toBe('global-pat');
    });

    it('returns per-agent PAT when set', () => {
        const cfg = { ...base, agentPats: { frontend: 'agent-pat' } };
        expect(resolveAdoPatForAgent(cfg, 'frontend')).toBe('agent-pat');
    });

    it('falls back for unknown agent id', () => {
        const cfg = { ...base, agentPats: { frontend: 'agent-pat' } };
        expect(resolveAdoPatForAgent(cfg, 'reviewer')).toBe('global-pat');
    });
});
