import { describe, expect, it } from 'vitest';
import { linkAuthoredStories } from '../server/routes/aiqa';

// Minimal finding/story shapes — linkAuthoredStories only reads id (finding) and
// sourceFindingId/number/externalRef/externalUrl/deleted (story).
type F = Parameters<typeof linkAuthoredStories>[0][number];
type S = Parameters<typeof linkAuthoredStories>[1][number];

const finding = (id: string): F => ({ id } as F);

describe('linkAuthoredStories', () => {
  it('attaches the external ref/url when a story mirrored to the tracker', () => {
    const findings = [finding('a'), finding('b')];
    const stories: S[] = [
      { number: 'LOCAL-B-0044', sourceFindingId: 'a', externalRef: 'UNW-124', externalUrl: 'https://linear.app/x/UNW-124' },
    ];
    linkAuthoredStories(findings, stories);
    expect(findings[0].authoredStory).toEqual({ number: 'UNW-124', url: 'https://linear.app/x/UNW-124' });
    expect(findings[1].authoredStory).toBeUndefined();
  });

  it('falls back to the local number when not yet mirrored', () => {
    const findings = [finding('a')];
    linkAuthoredStories(findings, [{ number: 'LOCAL-B-0044', sourceFindingId: 'a' }]);
    expect(findings[0].authoredStory).toEqual({ number: 'LOCAL-B-0044', url: undefined });
  });

  it('skips deleted stories and stories with no sourceFindingId', () => {
    const findings = [finding('a'), finding('b')];
    linkAuthoredStories(findings, [
      { number: 'X', sourceFindingId: 'a', deleted: true },
      { number: 'Y' },
    ]);
    expect(findings[0].authoredStory).toBeUndefined();
    expect(findings[1].authoredStory).toBeUndefined();
  });

  it('first non-deleted story wins per finding', () => {
    const findings = [finding('a')];
    linkAuthoredStories(findings, [
      { number: 'FIRST', sourceFindingId: 'a' },
      { number: 'SECOND', sourceFindingId: 'a' },
    ]);
    expect(findings[0].authoredStory?.number).toBe('FIRST');
  });
});
