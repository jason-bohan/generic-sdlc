import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { closeDb, initDb } from '../server/db';
import { completePhase, startWorkflow, getWorkflowAudit } from '../server/orchestrator';

const TMP = resolve(__dirname, '.forward-progress-guard-tmp');

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

/** Drive a fresh backend story through reading-story → analyzing → generating-code → validating. */
function startAtValidating(storyNumber: string): number {
    const started = startWorkflow({
        externalMode: 'mock',
        story: { number: storyNumber, backend: 'Add a GET /health endpoint returning JSON status' },
    });
    const id = started.value!.item.id;

    expect(completePhase({
        workflowItemId: id, agentId: 'backend', phase: 'reading-story', nextPhase: 'analyzing',
        outputs: {
            tasks: [{ name: 'Add /health route' }], taskIds: ['TK-1'],
            branchPlan: { branch: `feat/${storyNumber}-health` }, testMatrix: { unit: ['health route'] },
            risks: [], openQuestions: [], auditEvent: { phase: 'reading-story' },
        },
    }).ok).toBe(true);

    expect(completePhase({
        workflowItemId: id, agentId: 'backend', phase: 'analyzing', nextPhase: 'generating-code',
        outputs: { codeChanges: { files: ['src/routes/health.ts'] }, risks: [], auditEvent: { phase: 'analyzing' } },
    }).ok).toBe(true);

    expect(completePhase({
        workflowItemId: id, agentId: 'backend', phase: 'generating-code', nextPhase: 'validating',
        outputs: { codeChanges: { files: ['src/routes/health.ts'] }, auditEvent: { phase: 'generating-code' } },
    }).ok).toBe(true);

    return id;
}

const PASSED_REPORT = 'RUN_VALIDATION\n- static_analysis (tsc --noEmit): PASSED\n- test_results (npm test): PASSED\nOVERALL: PASSED';
const FAILED_REPORT = 'RUN_VALIDATION\n- static_analysis (tsc --noEmit): FAILED (exit 2)\nOVERALL: FAILED';

function completeValidating(id: number, nextPhase: 'generating-code' | 'creating-pr' | 'committing', report: string | undefined) {
    return completePhase({
        workflowItemId: id, agentId: 'backend', phase: 'validating', nextPhase,
        outputs: {
            validationResults: report, testResults: report, staticAnalysis: report,
            risks: [], auditEvent: { phase: 'validating' },
        },
    });
}

describe('forward-progress guard (validating must not bounce backward when it passed)', () => {
    it('coerces a PASSED validating -> generating-code into -> committing', () => {
        const id = startAtValidating('LOCAL-B-1001');
        const result = completeValidating(id, 'generating-code', PASSED_REPORT);

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ active_phase: 'committing', status: 'active' });

        const audit = getWorkflowAudit(id);
        const transition = audit.reverse().find(e => e.event_type === 'transitioned');
        expect(transition?.message).toContain('forward-progress guard');
    });

    it('respects a genuine FAILED validating -> generating-code (no coercion)', () => {
        const id = startAtValidating('LOCAL-B-1002');
        const result = completeValidating(id, 'generating-code', FAILED_REPORT);

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ active_phase: 'generating-code' });
    });

    it('does not coerce when the evidence carries no clear PASSED/FAILED verdict', () => {
        const id = startAtValidating('LOCAL-B-1003');
        // Contract-satisfying but verdict-free text → guard stays conservative.
        const result = completeValidating(id, 'generating-code', 'validation ran; see worktree logs for details');

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ active_phase: 'generating-code' });
    });

    it('leaves a normal forward transition (validating -> creating-pr) untouched', () => {
        const id = startAtValidating('LOCAL-B-1004');
        const result = completeValidating(id, 'creating-pr', PASSED_REPORT);

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ active_phase: 'creating-pr' });
        const transition = getWorkflowAudit(id).reverse().find(e => e.event_type === 'transitioned');
        expect(transition?.message).not.toContain('forward-progress guard');
    });
});
