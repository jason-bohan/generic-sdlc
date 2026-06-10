import { describe, expect, it } from 'vitest';
import { storyNumberFromDesk } from '../server/reset-agents';

describe('storyNumberFromDesk', () => {
  it('prefers the desk own storyNumber', () => {
    expect(storyNumberFromDesk({ storyNumber: 'LOCAL-B-0064', assignedPR: { branch: 'x-LOCAL-B-9999' } })).toBe('LOCAL-B-0064');
  });

  it('falls back to the assigned PR storyNumber', () => {
    expect(storyNumberFromDesk({ storyNumber: null as unknown as string, assignedPR: { storyNumber: 'UNW-122' } })).toBe('UNW-122');
  });

  it('parses the story number from the PR branch (the devops case: no story_number)', () => {
    expect(storyNumberFromDesk({ assignedPR: { branch: 'backend-LOCAL-B-0064' } })).toBe('LOCAL-B-0064');
    expect(storyNumberFromDesk({ assignedPR: { branch: 'reviewer-UNW-122' } })).toBe('UNW-122');
  });

  it('returns empty when nothing is derivable', () => {
    expect(storyNumberFromDesk({})).toBe('');
    expect(storyNumberFromDesk({ assignedPR: { branch: 'main' } })).toBe('');
    expect(storyNumberFromDesk({ assignedPR: null })).toBe('');
  });
});
