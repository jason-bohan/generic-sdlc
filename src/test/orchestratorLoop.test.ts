import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { shouldTick } from '../server/orchestrator-loop';
import { setLoopState } from '../server/loop-control';

let root: string;
const writeMode = (mode: string) => writeFileSync(join(root, '.sdlc-framework.config.json'), JSON.stringify({ scheduler: { mode } }));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orch-loop-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('shouldTick', () => {
  it('ticks only when autonomous AND the loop is running', () => {
    writeMode('autonomous');
    expect(shouldTick(root)).toBe(true); // loop defaults to running
  });

  it('does not tick when the loop is paused/stopped (the brake wins)', () => {
    writeMode('autonomous');
    setLoopState(root, 'paused');
    expect(shouldTick(root)).toBe(false);
    setLoopState(root, 'stopped');
    expect(shouldTick(root)).toBe(false);
    setLoopState(root, 'running');
    expect(shouldTick(root)).toBe(true);
  });

  it('does not tick when the scheduler is not autonomous', () => {
    writeMode('notify');
    expect(shouldTick(root)).toBe(false);
  });
});
