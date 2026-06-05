import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { closeDb, initDb } from '../server/db';
import { startWorkflow } from '../server/orchestrator';
import { applyReviewComplete } from '../server/handoff';

const TMP = resolve(__dirname, '.bug6-devops-register-tmp');

const writeJson = (p: string, v: unknown) => writeFileSync(resolve(TMP, p), JSON.stringify(v, null, 2));
const readJson = (p: string) => JSON.parse(readFileSync(resolve(TMP, p), 'utf-8'));

beforeEach(() => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    initDb(TMP);
    writeJson('.sdlc-framework.config.json', { externalMode: 'mock', scheduler: { mode: 'notify', agents: {} } });
});

afterEach(() => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
});

describe('bug #6: review approval registers the devops workflow item', () => {
    it('writes the story workflow item id into .devops-status.json so devops complete_phase is accepted', () => {
        const story = 'LOCAL-B-3001';
        const prId = 4242;
        const started = startWorkflow({ externalMode: 'mock', story: { number: story, backend: 'Add a GET /api/healthz endpoint' } });
        const itemId = started.value!.item.id;

        // Story owner desk holding the open PR — applyReviewComplete finds the owner by PR id.
        writeJson('.backend-status.json', {
            storyNumber: story, currentPhase: 'watching-reviews',
            prs: [{ id: prId, status: 'active' }], events: [],
        });

        const result = applyReviewComplete(TMP, { prId, verdict: 'approved', storyNumber: story, branch: `fix/${story}` });
        expect(result.target).toBe('devops');

        const devops = readJson('.devops-status.json');
        expect(devops.currentPhase).toBe('pending-build');
        // The crux of bug #6: without this id, devops complete_phase is rejected.
        expect(devops.workflowItemId).toBe(itemId);
    });

    it('is idempotent: a re-fired approval does not reset an already-advanced devops desk', () => {
        const story = 'LOCAL-B-3002';
        const prId = 5252;
        startWorkflow({ externalMode: 'mock', story: { number: story, backend: 'Add a GET /api/healthz endpoint' } });
        writeJson('.backend-status.json', {
            storyNumber: story, currentPhase: 'watching-reviews',
            prs: [{ id: prId, status: 'active' }], events: [],
        });

        // First approval dispatches devops.
        const first = applyReviewComplete(TMP, { prId, verdict: 'approved', storyNumber: story, branch: `fix/${story}` });
        expect(first.alreadyDispatched).toBeFalsy();

        // Devops has since advanced to build-passed.
        const devops = readJson('.devops-status.json');
        devops.currentPhase = 'build-passed';
        writeJson('.devops-status.json', devops);

        // The review handoff re-fires (reviewer keeps writing its status). It must be a no-op.
        const second = applyReviewComplete(TMP, { prId, verdict: 'approved', storyNumber: story, branch: `fix/${story}` });
        expect(second.alreadyDispatched).toBe(true);
        expect(readJson('.devops-status.json').currentPhase).toBe('build-passed'); // NOT reset to pending-build
    });

    it('still writes the devops desk gracefully when the story has no workflow item', () => {
        const prId = 4243;
        writeJson('.backend-status.json', {
            storyNumber: 'LOCAL-B-9999', currentPhase: 'watching-reviews',
            prs: [{ id: prId, status: 'active' }], events: [],
        });

        const result = applyReviewComplete(TMP, { prId, verdict: 'approved', storyNumber: 'LOCAL-B-9999', branch: 'fix/x' });
        expect(result.target).toBe('devops');

        const devops = readJson('.devops-status.json');
        expect(devops.currentPhase).toBe('pending-build');
        expect(devops.workflowItemId).toBeUndefined(); // no item → field omitted, no crash
    });
});
