import { describe, expect, it, vi } from 'vitest';
import { parseAuthoredStories, authorStories, buildAuthoringPrompt, type ModelCall } from '../server/orchestrator-author';

describe('parseAuthoredStories', () => {
  it('parses a bare JSON array', () => {
    const raw = JSON.stringify([
      { name: 'Add ping/version', description: 'Return version', acceptanceCriteria: 'returns 1.0', estimate: 2, agentHint: 'backend' },
    ]);
    const out = parseAuthoredStories(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Add ping/version', estimate: 2, agentHint: 'backend' });
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const raw = 'Here are the stories:\n```json\n[{"name":"A","description":"d"}]\n```\nDone.';
    expect(parseAuthoredStories(raw).map((s) => s.name)).toEqual(['A']);
  });

  it('drops elements without a name and lowercases agentHint', () => {
    const raw = JSON.stringify([{ description: 'no name' }, { name: 'Keep', agentHint: 'BACKEND' }]);
    const out = parseAuthoredStories(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Keep', agentHint: 'backend' });
  });

  it('returns [] for malformed or array-less output', () => {
    expect(parseAuthoredStories('not json at all')).toEqual([]);
    expect(parseAuthoredStories('[ {bad json ')).toEqual([]);
    expect(parseAuthoredStories('')).toEqual([]);
  });
});

describe('buildAuthoringPrompt', () => {
  it('includes the goal and project key and asks for a JSON array', () => {
    const p = buildAuthoringPrompt('add health checks', 'flowboard');
    expect(p).toContain('add health checks');
    expect(p).toContain('flowboard');
    expect(p).toMatch(/JSON array/i);
  });
});

describe('authorStories', () => {
  const okModel = (stories: unknown): (p: string) => Promise<ModelCall> =>
    async () => ({ ok: true, text: JSON.stringify(stories) });

  it('creates a story per authored item and returns their numbers', async () => {
    const createStory = vi.fn((s: { name: string }) => ({ number: `LOCAL-${s.name[0]}`, name: s.name }));
    const result = await authorStories({
      goal: 'do things',
      projectKey: 'flowboard',
      callModel: okModel([{ name: 'Alpha', description: 'a' }, { name: 'Beta', description: 'b' }]),
      createStory,
    });
    expect(result.ok).toBe(true);
    expect(createStory).toHaveBeenCalledTimes(2);
    expect(result.authored.map((a) => a.name)).toEqual(['Alpha', 'Beta']);
  });

  it('rejects an empty goal without calling the model', async () => {
    const callModel = vi.fn();
    const result = await authorStories({ goal: '  ', projectKey: 'x', callModel, createStory: () => ({ number: 'n', name: 'n' }) });
    expect(result.ok).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });

  it('surfaces a usage limit as limited (pause-and-retry) and creates nothing', async () => {
    const createStory = vi.fn();
    const result = await authorStories({
      goal: 'g', projectKey: 'x',
      callModel: async () => ({ ok: false, limited: true }),
      createStory,
    });
    expect(result).toMatchObject({ ok: false, limited: true });
    expect(createStory).not.toHaveBeenCalled();
  });

  it('caps the number of stories at maxStories', async () => {
    const createStory = vi.fn((s: { name: string }) => ({ number: s.name, name: s.name }));
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `S${i}`, description: 'd' }));
    const result = await authorStories({ goal: 'g', projectKey: 'x', callModel: okModel(many), createStory, maxStories: 3 });
    expect(result.authored).toHaveLength(3);
  });

  it('fails cleanly when the model returns no parseable stories', async () => {
    const result = await authorStories({
      goal: 'g', projectKey: 'x',
      callModel: async () => ({ ok: true, text: 'sorry, I cannot' }),
      createStory: () => ({ number: 'n', name: 'n' }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no valid stories/i);
  });
});
