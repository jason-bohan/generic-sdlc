import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { autoMergePr, executeToolCall, devopsBuildChainNextPhase, DEVOPS_BUILD_CHAIN } from '../server/agent-runner/tools';

const TMP = resolve(__dirname, '.devops-build-gate-tmp');
const CONFIG = () => resolve(TMP, '.sdlc-framework.config.json');

const writeJson = (p: string, v: unknown) => writeFileSync(resolve(TMP, p), JSON.stringify(v, null, 2));

// Stub the `gh` binary on PATH so the conflict path runs without a network call. `autoMergePr`
// shells out via execFileSync('gh', ...), which resolves through PATH — prepending a temp dir
// with a fake `gh` script lets us drive the mergeStateStatus the code branches on.
function withFakeGh(script: string, fn: () => void) {
    const binDir = resolve(TMP, 'bin');
    mkdirSync(binDir, { recursive: true });
    const ghPath = resolve(binDir, 'gh');
    writeFileSync(ghPath, script);
    chmodSync(ghPath, 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    try { fn(); } finally { process.env.PATH = prevPath; }
}

// Reports the PR as DIRTY (conflicting); supplies head/base on the second view call. Any other
// gh subcommand (e.g. a merge attempt) exits non-zero so a regression that tries to merge fails.
const DIRTY_GH = `#!/bin/sh
for a in "$@"; do
  case "$a" in
    mergeStateStatus,state) echo '{"mergeStateStatus":"DIRTY","state":"OPEN"}'; exit 0;;
    headRefName,baseRefName) echo '{"headRefName":"feature-x","baseRefName":"main"}'; exit 0;;
  esac
done
echo "unexpected gh call: $@" >&2
exit 1
`;

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

    it('does NOT merge or arm auto-merge on a DIRTY (conflicting) PR — returns a DIRTY: directive', () => {
        // Regression for flowboard PR #46: a conflicting PR was completing the story because
        // `gh pr merge --auto` arms auto-merge on a DIRTY PR even though it can never land.
        writeJson('.sdlc-framework.config.json', { externalMode: 'live', scheduler: {} });
        writeJson('.devops-status.json', { currentPhase: 'build-passed', assignedPR: { id: 46, url: 'https://github.com/o/r/pull/46' } });
        withFakeGh(DIRTY_GH, () => {
            const r = autoMergePr(TMP, CONFIG());
            expect(r.ok).toBe(false);
            expect(r.merged).toBe(false);
            // DIRTY:-prefixed so the build-gate routes to agent-driven conflict resolution
            // (and the fake `gh` never received a merge subcommand — it would have exited 1).
            expect(r.note).toMatch(/^DIRTY:/);
            expect(r.note).toContain('#46');
            expect(r.note).toContain('feature-x');
        });
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
