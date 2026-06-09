import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createLocalStory,
    updateLocalStory,
    findLocalStory,
    loadLocalPlanningState,
    LOCAL_STORY_PREFIX,
    LOCAL_TASK_PREFIX,
} from '../server/local-planning';

const roots: string[] = [];

function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-local-planning-'));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('local planning default state', () => {
    it('seeds the hook-runner migration stories without number gaps or duplicate IDs', () => {
        const root = tempRoot();

        const state = loadLocalPlanningState(root);
        const numbers = state.stories.map((story) => story.number);

        expect(numbers).toEqual([
            'LOCAL-B-0001',
            'LOCAL-B-0002',
            'LOCAL-B-0003',
            'LOCAL-B-0004',
            'LOCAL-B-0005',
            'LOCAL-B-0006',
            'LOCAL-B-0007',
            'LOCAL-B-0008',
            'LOCAL-B-0009',
            'LOCAL-B-0010',
        ]);
        expect(new Set(state.stories.map((story) => story.id)).size).toBe(state.stories.length);
        expect(state.nextStoryId).toBe(11);
        expect(state.nextTaskId).toBe(1);
        expect(existsSync(join(root, '.sdlc-framework', 'local-planning', 'state.json'))).toBe(true);
    });

    it('creates the next local story after the seeded backlog', () => {
        const root = tempRoot();

        const story = createLocalStory(root, { name: 'Regression test story' });

        expect(story.number).toBe(`${LOCAL_STORY_PREFIX}0011`);
        expect(story.id).toBe(`LocalStory:${LOCAL_STORY_PREFIX}0011`);
        expect(LOCAL_TASK_PREFIX).toBe('LOCAL-TK-');
    });
});

describe('updateLocalStory sourceFindingId', () => {
    it('sets sourceFindingId on a story that lacks one (backfill), and preserves it across unrelated updates', () => {
        const root = tempRoot();
        const story = createLocalStory(root, { name: 'Add deterministic money-path tests' });
        expect(story.sourceFindingId).toBeUndefined();

        // Backfill the link.
        updateLocalStory(root, story.number, { sourceFindingId: 'financial-control:aiqa:Money path tests:evidence' });
        expect(findLocalStory(root, story.number)?.sourceFindingId).toBe('financial-control:aiqa:Money path tests:evidence');

        // An unrelated update must not wipe the link.
        updateLocalStory(root, story.number, { status: 'In Progress' });
        const after = findLocalStory(root, story.number);
        expect(after?.status).toBe('In Progress');
        expect(after?.sourceFindingId).toBe('financial-control:aiqa:Money path tests:evidence');
    });
});
