import { describe, expect, it } from 'vitest';
import { selectBacklogCandidates, planAssignments } from '../server/orchestrator-tick';
import type { LocalPlanningStory } from '../server/local-planning';
import type { SdlcAgentId } from '../shared/sdlcContracts';

function story(over: Partial<LocalPlanningStory>): LocalPlanningStory {
  return {
    id: over.number ?? 'x', number: over.number ?? 'X-1', name: over.name ?? 'Story', description: over.description ?? '',
    status: over.status ?? 'Backlog', teamId: 't', team: 'T', estimate: 1, priority: 'Medium', scope: '', classOfService: '',
    acceptanceCriteria: '', frontend: over.frontend ?? '', backend: over.backend ?? '', qa: over.qa ?? '',
    deleted: over.deleted, sortOrder: over.sortOrder, createdAt: '', updatedAt: '', ...over,
  };
}

describe('selectBacklogCandidates', () => {
  it('keeps only non-deleted Backlog stories, in sortOrder', () => {
    const stories = [
      story({ number: 'B-3', status: 'Backlog', sortOrder: 3 }),
      story({ number: 'B-1', status: 'Backlog', sortOrder: 1 }),
      story({ number: 'IP', status: 'In Progress', sortOrder: 0 }),
      story({ number: 'CL', status: 'Closed', sortOrder: 0 }),
      story({ number: 'DEL', status: 'Backlog', sortOrder: 0, deleted: true }),
      story({ number: 'B-2', status: 'backlog', sortOrder: 2 }), // case-insensitive
    ];
    expect(selectBacklogCandidates(stories).map((s) => s.number)).toEqual(['B-1', 'B-2', 'B-3']);
  });
});

describe('planAssignments', () => {
  const route = (agent: SdlcAgentId) => async () => agent;

  it('assigns a free agent its routed story', async () => {
    const { assigned, skipped } = await planAssignments(
      [story({ number: 'B-1', name: 'API change' })],
      route('backend'),
      () => false,
      'flowboard',
    );
    expect(skipped).toHaveLength(0);
    expect(assigned).toEqual([{ storyNumber: 'B-1', storyName: 'API change', storyDescription: '', agentId: 'backend' }]);
  });

  it('skips a story whose target agent is busy', async () => {
    const { assigned, skipped } = await planAssignments(
      [story({ number: 'B-1' })],
      route('devops'),
      (a) => a === 'devops',
      'flowboard',
    );
    expect(assigned).toHaveLength(0);
    expect(skipped).toEqual([{ storyNumber: 'B-1', reason: 'devops busy' }]);
  });

  it('assigns at most one story per agent per tick', async () => {
    const { assigned, skipped } = await planAssignments(
      [story({ number: 'B-1' }), story({ number: 'B-2' })],
      route('backend'), // both route to backend
      () => false,
      'flowboard',
    );
    expect(assigned.map((a) => a.storyNumber)).toEqual(['B-1']);
    expect(skipped).toEqual([{ storyNumber: 'B-2', reason: 'backend already assigned this tick' }]);
  });

  it('routes different stories to different free agents', async () => {
    const byNumber: Record<string, SdlcAgentId> = { 'B-1': 'backend', 'F-1': 'frontend' };
    const { assigned } = await planAssignments(
      [story({ number: 'B-1' }), story({ number: 'F-1' })],
      async (s) => byNumber[s.number],
      () => false,
      'flowboard',
    );
    expect(assigned.map((a) => `${a.storyNumber}:${a.agentId}`)).toEqual(['B-1:backend', 'F-1:frontend']);
  });
});
