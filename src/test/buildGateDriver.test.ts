import { describe, expect, it } from 'vitest';
import { shouldDriveBuildGate } from '../server/build-gate-driver';

const GH = 'https://github.com/jason-bohan/flowboard/pull/48';

describe('shouldDriveBuildGate', () => {
  it('drives only in build-chain phases on a GitHub PR with step mode off', () => {
    expect(shouldDriveBuildGate('pending-build', GH, false)).toBe(true);
    expect(shouldDriveBuildGate('monitoring-build', GH, false)).toBe(true);
    expect(shouldDriveBuildGate('build-passed', GH, false)).toBe(true);
  });

  it('skips non-build-chain phases', () => {
    expect(shouldDriveBuildGate('idle', GH, false)).toBe(false);
    expect(shouldDriveBuildGate('complete', GH, false)).toBe(false);
    expect(shouldDriveBuildGate('reading-story', GH, false)).toBe(false);
  });

  it('skips when step mode is on (manual merge wanted)', () => {
    expect(shouldDriveBuildGate('pending-build', GH, true)).toBe(false);
  });

  it('skips non-GitHub or missing PR urls (other hosts finalize themselves)', () => {
    expect(shouldDriveBuildGate('pending-build', 'https://dev.azure.com/o/p/_git/r/pullrequest/8', false)).toBe(false);
    expect(shouldDriveBuildGate('pending-build', '', false)).toBe(false);
    expect(shouldDriveBuildGate('pending-build', 'https://github.com/o/r/issues/5', false)).toBe(false);
  });
});
