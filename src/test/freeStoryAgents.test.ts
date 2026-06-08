import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { freeStoryAgents } from '../server/reset-agents';

const TMP = resolve(__dirname, '.free-story-agents-tmp');
const writeDesk = (agent: string, v: unknown) => writeFileSync(resolve(TMP, `.${agent}-status.json`), JSON.stringify(v, null, 2));
const readDesk = (agent: string) => JSON.parse(readFileSync(resolve(TMP, `.${agent}-status.json`), 'utf-8'));

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    writeFileSync(resolve(TMP, '.sdlc-framework.config.json'), JSON.stringify({ externalMode: 'mock' }));
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
});

describe('freeStoryAgents — story-scoped completion', () => {
    it('frees the desk matching by storyNumber and leaves other stories untouched', () => {
        writeDesk('backend', { storyNumber: 'LOCAL-B-0033', currentPhase: 'watching-reviews', events: [] });
        writeDesk('frontend', { storyNumber: 'LOCAL-B-0099', currentPhase: 'generating-code', events: [] });

        const { freed } = freeStoryAgents(TMP, 'LOCAL-B-0033');
        expect(freed).toContain('.backend-status.json');
        expect(freed).not.toContain('.frontend-status.json');

        expect(readDesk('backend')).toMatchObject({ currentPhase: 'idle', storyNumber: null, assignedPR: null });
        // The other story's desk is fully preserved.
        expect(readDesk('frontend')).toMatchObject({ storyNumber: 'LOCAL-B-0099', currentPhase: 'generating-code' });
    });

    it('frees reviewer/devops desks that reference the story via assignedPR (by story or PR id)', () => {
        writeDesk('reviewer', { currentPhase: 'approved', assignedPR: { id: 34, storyNumber: 'LOCAL-B-0033' }, events: [] });
        writeDesk('devops', { currentPhase: 'monitoring-build', assignedPR: { id: 34, storyNumber: 'LOCAL-B-0033' }, events: [] });

        const { freed } = freeStoryAgents(TMP, 'LOCAL-B-0033', 34);
        expect(freed).toEqual(expect.arrayContaining(['.reviewer-status.json', '.devops-status.json']));
        expect(readDesk('reviewer')).toMatchObject({ currentPhase: 'idle', assignedPR: null });
        expect(readDesk('devops')).toMatchObject({ currentPhase: 'idle', assignedPR: null });
    });

    it('does not free a desk holding a DIFFERENT PR', () => {
        writeDesk('reviewer', { currentPhase: 'pending-review', assignedPR: { id: 99, storyNumber: 'OTHER-1' }, events: [] });
        const { freed } = freeStoryAgents(TMP, 'LOCAL-B-0033', 34);
        expect(freed).not.toContain('.reviewer-status.json');
        expect(readDesk('reviewer')).toMatchObject({ currentPhase: 'pending-review', assignedPR: { id: 99 } });
    });

    it('clears reworkStuck and handoffDispatched flags on freed desks', () => {
        writeDesk('backend', { storyNumber: 'LOCAL-B-0033', currentPhase: 'addressing-feedback', reworkStuck: true, handoffDispatched: true, events: [] });
        freeStoryAgents(TMP, 'LOCAL-B-0033');
        expect(readDesk('backend')).toMatchObject({ reworkStuck: false, handoffDispatched: false, currentPhase: 'idle' });
    });
});
