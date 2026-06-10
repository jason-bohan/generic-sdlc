import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseStoryNumber, applyDeployResult } from '../server/deploy-gate';
import { createLocalStory, findLocalStory } from '../server/local-planning';

describe('parseStoryNumber', () => {
  it('extracts the story number from PR titles / commit messages', () => {
    expect(parseStoryNumber('LOCAL-B-0064: Add GET /api/ping/now endpoint (#54)')).toBe('LOCAL-B-0064');
    expect(parseStoryNumber('Merge UNW-122: fix thing')).toBe('UNW-122');
    expect(parseStoryNumber('no story here')).toBeUndefined();
  });
});

describe('applyDeployResult', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'deploy-gate-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('failed deploy requeues the story to Backlog with the reason attached', () => {
    const s = createLocalStory(root, { name: 'Add endpoint', description: 'original', status: 'Done' });
    const out = applyDeployResult(root, s.number, 'failed', 'build step exited 1');
    expect(out).toMatchObject({ ok: true, action: 'requeued' });
    const after = findLocalStory(root, s.number)!;
    expect(after.status).toBe('Backlog');
    expect(after.description).toMatch(/^\[Deploy failed: build step exited 1\]/);
  });

  it('does not double-tag the description on repeated failures', () => {
    const s = createLocalStory(root, { name: 'X', description: 'orig' });
    applyDeployResult(root, s.number, 'failed', 'r1');
    applyDeployResult(root, s.number, 'failed', 'r2');
    const after = findLocalStory(root, s.number)!;
    expect((after.description.match(/\[Deploy failed/g) || []).length).toBe(1);
  });

  it('success is acknowledged without changing the story', () => {
    const s = createLocalStory(root, { name: 'X', description: 'orig', status: 'Done' });
    const out = applyDeployResult(root, s.number, 'success');
    expect(out).toMatchObject({ ok: true, action: 'acknowledged' });
    expect(findLocalStory(root, s.number)!.status).toBe('Done');
  });

  it('unknown story → not-found, never throws', () => {
    expect(applyDeployResult(root, 'LOCAL-B-9999', 'failed', 'x')).toMatchObject({ ok: false, action: 'not-found' });
  });
});
