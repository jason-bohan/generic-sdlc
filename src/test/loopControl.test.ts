import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getLoopState, setLoopState, isLoopActive } from '../server/loop-control';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'loop-ctl-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('loop-control', () => {
  it('defaults to running (loop on) when no state file exists', () => {
    expect(getLoopState(root)).toBe('running');
    expect(isLoopActive(root)).toBe(true);
  });

  it('pause and stop both freeze the loop; resume re-activates it', () => {
    setLoopState(root, 'paused');
    expect(getLoopState(root)).toBe('paused');
    expect(isLoopActive(root)).toBe(false);

    setLoopState(root, 'stopped');
    expect(isLoopActive(root)).toBe(false);

    setLoopState(root, 'running');
    expect(getLoopState(root)).toBe('running');
    expect(isLoopActive(root)).toBe(true);
  });

  it('treats an unknown/garbage state as running (fail-open, never wedges the loop)', () => {
    setLoopState(root, 'bogus' as unknown as 'running');
    expect(getLoopState(root)).toBe('running');
    expect(isLoopActive(root)).toBe(true);
  });
});
