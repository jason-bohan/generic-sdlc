import { describe, expect, it, vi } from 'vitest';
import {
  parseAuthoredStories, authorStories, buildAuthoringPrompt,
  buildGoalFromFindings, severityRank, selectFindingsForAuthoring,
  type ModelCall, type FindingSummary,
} from '../server/orchestrator-author';

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

describe('buildGoalFromFindings', () => {
  const findings: FindingSummary[] = [
    { title: 'Low thing', severity: 'low', evidence: 'minor' },
    { title: 'Build broken', severity: 'high', evidence: 'tsc fails on main', suggestedOwner: 'backend' },
    { title: 'Medium thing', severity: 'medium' },
  ];

  it('severityRank orders critical > high > medium > low > unknown', () => {
    expect(severityRank('critical')).toBeGreaterThan(severityRank('high'));
    expect(severityRank('high')).toBeGreaterThan(severityRank('medium'));
    expect(severityRank('medium')).toBeGreaterThan(severityRank('low'));
    expect(severityRank('nonsense')).toBe(0);
  });

  it('frames findings most-severe-first and includes evidence + owner', () => {
    const goal = buildGoalFromFindings(findings);
    expect(goal).toMatch(/AI-QA audit/);
    // high-severity "Build broken" should appear before the low one
    expect(goal.indexOf('Build broken')).toBeLessThan(goal.indexOf('Low thing'));
    expect(goal).toContain('tsc fails on main');
    expect(goal).toContain('suggested owner: backend');
  });

  it('caps at max findings', () => {
    const many: FindingSummary[] = Array.from({ length: 9 }, (_, i) => ({ title: `F${i}`, severity: 'high' }));
    const goal = buildGoalFromFindings(many, 3);
    expect(goal.match(/^\d+\. /gm)).toHaveLength(3);
  });

  it('returns empty string for no findings', () => {
    expect(buildGoalFromFindings([])).toBe('');
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

describe('selectFindingsForAuthoring', () => {
  const findings: FindingSummary[] = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'c', title: 'C' },
  ];

  it('returns all findings when no ids are given', () => {
    expect(selectFindingsForAuthoring(findings)).toHaveLength(3);
    expect(selectFindingsForAuthoring(findings, [])).toHaveLength(3);
  });

  it('restricts to the requested ids (per-finding authoring)', () => {
    const out = selectFindingsForAuthoring(findings, ['b']);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('b');
  });

  it('ignores unknown ids and findings without an id', () => {
    expect(selectFindingsForAuthoring(findings, ['zzz'])).toHaveLength(0);
    const noId: FindingSummary[] = [{ title: 'no id' }];
    expect(selectFindingsForAuthoring(noId, ['anything'])).toHaveLength(0);
  });
});
