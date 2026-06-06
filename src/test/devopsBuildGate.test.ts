import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { autoMergePr, executeToolCall, devopsBuildChainNextPhase, DEVOPS_BUILD_CHAIN } from '../server/agent-runner/tools';

const TMP = resolve(__dirname, '.devops-build-gate-tmp');
const CONFIG = () => resolve(TMP, '.sdlc-framework.config.json');

const writeJson = (p: string, v: unknown) => writeFileSync(resolve(TMP, p), JSON.stringify(v, null, 2));

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
});

describe('autoMergePr — host-agnostic, GitHub-positive', () => {
    it('does not merge in mock mode', () => {
        writeJson('.sdlc-framework.config.json', { externalMode: 'mock', scheduler: {} });
        writeJson('.devops-status.json', { currentPhase: 'build-passed', assignedPR: { id: 7, url: 'https://github.com/o/r/pull/7' } });
        const r = autoMergePr(TMP, CONFIG());
        expect(r).toMatchObject({ ok: true, merged: false });
        expect(r.note).toMatch(/mock/i);
    });

    it('leaves a non-GitHub PR for its own host (no Azure special-case needed)', () => {
        writeJson('.sdlc-framework.config.json', { externalMode: 'live', scheduler: {} });
        writeJson('.devops-status.json', { currentPhase: 'build-passed', assignedPR: { id: 8, url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/8' } });
        const r = autoMergePr(TMP, CONFIG());
        expect(r).toMatchObject({ ok: true, merged: false });
        expect(r.note).toMatch(/not a GitHub PR/i);
    });

    it('reports when there is no assigned PR to merge', () => {
        writeJson('.sdlc-framework.config.json', { externalMode: 'live', scheduler: {} });
        writeJson('.devops-status.json', { currentPhase: 'build-passed', assignedPR: {} });
        const r = autoMergePr(TMP, CONFIG());
        expect(r.ok).toBe(false);
        expect(r.note).toMatch(/no assigned PR/i);
    });
});

describe('devopsBuildChainNextPhase — deterministic build-chain forward routing', () => {
    it('routes each build-chain hop forward, skipping error/failure branches', () => {
        expect(devopsBuildChainNextPhase('pending-build')).toBe('monitoring-build');
        expect(devopsBuildChainNextPhase('monitoring-build')).toBe('build-passed');
        expect(devopsBuildChainNextPhase('build-passed')).toBe('complete');
    });

    it('covers exactly the three build-chain phases', () => {
        expect([...DEVOPS_BUILD_CHAIN].sort()).toEqual(['build-passed', 'monitoring-build', 'pending-build']);
    });
});

describe('build-gate — step mode pauses the merge', () => {
    it('does NOT auto-merge or advance when devops step mode is on; surfaces a manual-merge message', async () => {
        writeJson('.sdlc-framework.config.json', { externalMode: 'live', scheduler: { agents: { devops: { stepMode: true } } } });
        writeJson('.devops-status.json', {
            workflowItemId: 123, currentPhase: 'build-passed',
            assignedPR: { id: 9, url: 'https://github.com/o/r/pull/9' }, events: [],
        });

        const out = await executeToolCall('complete_phase', { next_phase: 'analyzing' }, TMP, TMP, 'devops', CONFIG());
        // Returns the step-mode notice without ever POSTing complete-phase (no server here),
        // and never reaches the gh merge.
        expect(out).toMatch(/step mode is on/i);
        expect(out).toMatch(/merge it manually/i);
        expect(out).not.toMatch(/PHASE_COMPLETE/);
    });
});
