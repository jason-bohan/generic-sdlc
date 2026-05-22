import { describe, expect, it } from 'vitest';
import {
    SDLC_PHASE_CONTRACTS,
    SDLC_WORKFLOW_GRAPHS,
    getSdlcPhaseContract,
    isAllowedSdlcTransition,
    validateSdlcPhaseOutput,
    type SdlcPhaseId,
} from '../shared/sdlcContracts';

describe('SDLC phase contracts', () => {
    it('defines every workflow phase used by every agent graph', () => {
        const known = new Set(Object.keys(SDLC_PHASE_CONTRACTS));

        for (const graph of Object.values(SDLC_WORKFLOW_GRAPHS)) {
            expect(known.has(graph.start), `${graph.agentId} start phase is missing a contract`).toBe(true);
            for (const phase of graph.phases) {
                expect(known.has(phase), `${graph.agentId} phase ${phase} is missing a contract`).toBe(true);
            }
            for (const [from, next] of Object.entries(graph.transitions) as Array<[SdlcPhaseId, readonly SdlcPhaseId[]]>) {
                expect(graph.phases.includes(from), `${graph.agentId} transition source ${from} is not in phases`).toBe(true);
                for (const to of next) {
                    expect(known.has(to), `${graph.agentId} transition target ${to} is missing a contract`).toBe(true);
                }
            }
        }
    });

    it('requires story reading to produce tasks, branch plan, test matrix, risks, and questions', () => {
        const contract = getSdlcPhaseContract('reading-story');
        expect(contract.produces).toEqual(expect.arrayContaining([
            'tasks',
            'taskIds',
            'branchPlan',
            'testMatrix',
            'risks',
            'openQuestions',
        ]));

        const result = validateSdlcPhaseOutput('reading-story', {
            tasks: [{ name: 'Implement API endpoint' }],
            taskIds: ['TK-LOCAL-1'],
            branchPlan: { branch: 'ninjas/dev/b-17001_endpoint' },
            testMatrix: { unit: true, automation: false },
            risks: [],
            openQuestions: [],
            auditEvent: { type: 'phase-complete' },
        });

        expect(result).toEqual({ ok: true, missing: [] });
    });

    it('rejects incomplete phase outputs', () => {
        const result = validateSdlcPhaseOutput('validating', {
            validationResults: { build: 'passed' },
        });

        expect(result.ok).toBe(false);
        expect(result.missing).toEqual(expect.arrayContaining(['staticAnalysis', 'testResults', 'risks', 'auditEvent']));
    });

    it('separates implementer, reviewer, devops, qa, and ux workflows', () => {
        expect(isAllowedSdlcTransition('frontend', 'creating-pr', 'watching-reviews')).toBe(true);
        expect(isAllowedSdlcTransition('frontend', 'creating-pr', 'pending-build')).toBe(false);
        expect(isAllowedSdlcTransition('reviewer', 'commenting', 'changes-requested')).toBe(true);
        expect(isAllowedSdlcTransition('devops', 'pending-build', 'monitoring-build')).toBe(true);
        expect(isAllowedSdlcTransition('qa', 'running-cypress', 'addressing-feedback')).toBe(true);
        expect(isAllowedSdlcTransition('ux', 'designing', 'spec-ready')).toBe(true);
    });
});
