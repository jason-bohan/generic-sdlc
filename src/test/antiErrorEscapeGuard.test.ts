import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { closeDb, initDb } from '../server/db';
import { completePhase, startWorkflow, getWorkflowAudit } from '../server/orchestrator';

const TMP = resolve(__dirname, '.anti-error-escape-guard-tmp');

beforeEach(() => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    initDb(TMP);
});

afterEach(() => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
});

function startStory(storyNumber: string): number {
    const started = startWorkflow({
        externalMode: 'mock',
        story: { number: storyNumber, backend: 'Add a GET /api/ping endpoint returning {pong:true}' },
    });
    return started.value!.item.id;
}

const READING_STORY_OUTPUTS = {
    tasks: [{ name: 'Add /api/ping route' }], taskIds: ['TK-1'],
    branchPlan: { branch: 'fix/ping' }, testMatrix: { unit: ['ping route'] },
    risks: [], openQuestions: [], auditEvent: { phase: 'reading-story' },
};

function advanceToAnalyzing(id: number) {
    expect(completePhase({
        workflowItemId: id, agentId: 'backend', phase: 'reading-story', nextPhase: 'analyzing',
        outputs: READING_STORY_OUTPUTS,
    }).ok).toBe(true);
}

function advanceToGeneratingCode(id: number) {
    advanceToAnalyzing(id);
    expect(completePhase({
        workflowItemId: id, agentId: 'backend', phase: 'analyzing', nextPhase: 'generating-code',
        outputs: { codeChanges: { files: ['src/server/index.ts'] }, risks: [], auditEvent: { phase: 'analyzing' } },
    }).ok).toBe(true);
}

function lastTransition(id: number) {
    return getWorkflowAudit(id).reverse().find(e => e.event_type === 'transitioned');
}

describe('anti-error-escape guard (dev agent may not self-terminate an early phase to error)', () => {
    it('coerces reading-story -> error into reading-story -> analyzing', () => {
        const id = startStory('LOCAL-B-2001');
        const result = completePhase({
            workflowItemId: id, agentId: 'backend', phase: 'reading-story', nextPhase: 'error',
            outputs: READING_STORY_OUTPUTS,
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ active_phase: 'analyzing', status: 'active' });
        expect(lastTransition(id)?.message).toContain('anti-error guard');
    });

    it('coerces analyzing -> error into analyzing -> generating-code', () => {
        const id = startStory('LOCAL-B-2002');
        advanceToAnalyzing(id);
        const result = completePhase({
            workflowItemId: id, agentId: 'backend', phase: 'analyzing', nextPhase: 'error',
            outputs: { codeChanges: { files: ['src/server/index.ts'] }, risks: [], auditEvent: { phase: 'analyzing' } },
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ active_phase: 'generating-code' });
    });

    it('coerces generating-code -> error into generating-code -> validating', () => {
        const id = startStory('LOCAL-B-2003');
        advanceToGeneratingCode(id);
        const result = completePhase({
            workflowItemId: id, agentId: 'backend', phase: 'generating-code', nextPhase: 'error',
            outputs: { codeChanges: { files: ['src/server/index.ts'] }, auditEvent: { phase: 'generating-code' } },
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ active_phase: 'validating' });
    });

    it('leaves a normal forward transition (reading-story -> analyzing) untouched', () => {
        const id = startStory('LOCAL-B-2004');
        const result = completePhase({
            workflowItemId: id, agentId: 'backend', phase: 'reading-story', nextPhase: 'analyzing',
            outputs: READING_STORY_OUTPUTS,
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ active_phase: 'analyzing' });
        expect(lastTransition(id)?.message).not.toContain('anti-error guard');
    });

    it('does NOT coerce error from a non-guarded phase (validating -> error stays error)', () => {
        const id = startStory('LOCAL-B-2005');
        advanceToGeneratingCode(id);
        expect(completePhase({
            workflowItemId: id, agentId: 'backend', phase: 'generating-code', nextPhase: 'validating',
            outputs: { codeChanges: { files: ['src/server/index.ts'] }, auditEvent: { phase: 'generating-code' } },
        }).ok).toBe(true);

        const result = completePhase({
            workflowItemId: id, agentId: 'backend', phase: 'validating', nextPhase: 'error',
            outputs: {
                validationResults: 'OVERALL: FAILED', testResults: 'OVERALL: FAILED', staticAnalysis: 'OVERALL: FAILED',
                risks: [], auditEvent: { phase: 'validating' },
            },
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ active_phase: 'error' });
    });
});
