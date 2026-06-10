import { describe, expect, it } from 'vitest';
import { classifyCiRollup } from '../server/agent-runner/tools';

describe('classifyCiRollup', () => {
  it('failed when any check concluded in failure', () => {
    expect(classifyCiRollup([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failed');
    expect(classifyCiRollup([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    ])).toBe('failed');
    expect(classifyCiRollup([{ __typename: 'StatusContext', state: 'FAILURE' }])).toBe('failed');
  });

  it('pending when a check is still running and none failed', () => {
    expect(classifyCiRollup([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS', conclusion: '' },
    ])).toBe('pending');
    expect(classifyCiRollup([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('pending');
  });

  it('passed when all checks completed successfully', () => {
    expect(classifyCiRollup([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', state: 'SUCCESS' },
    ])).toBe('passed');
  });

  it('unknown when there are no checks (absence must not block)', () => {
    expect(classifyCiRollup([])).toBe('unknown');
  });

  it('a real failed run (Tests & type check FAILURE) is failed, not pending', () => {
    expect(classifyCiRollup([
      { __typename: 'CheckRun', name: 'Tests & type check', status: 'COMPLETED', conclusion: 'FAILURE' },
    ])).toBe('failed');
  });
});
