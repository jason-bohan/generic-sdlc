import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { bumpReworkRound, resetReworkRound, reworkAction, markReworkStuck, REWORK_CAP, devLoopAction, markDevLoopStuck, VALIDATION_ESCALATE_AT, VALIDATION_PAUSE_AT, isReworkStuck, escalatedRespawnModel, markEscalated } from '../server/rework-cap';

const TMP = resolve(__dirname, '.rework-cap-tmp');

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
});

describe('rework cap counter', () => {
    it('counts per-PR and persists across calls', () => {
        expect(bumpReworkRound(TMP, 5)).toBe(1);
        expect(bumpReworkRound(TMP, 5)).toBe(2);
        expect(bumpReworkRound(TMP, 7)).toBe(1); // independent PR
        expect(bumpReworkRound(TMP, 5)).toBe(3);
    });

    it('resets a PR counter (e.g. on approval)', () => {
        bumpReworkRound(TMP, 5);
        bumpReworkRound(TMP, 5);
        resetReworkRound(TMP, 5);
        expect(bumpReworkRound(TMP, 5)).toBe(1);
    });
});

describe('reworkAction — local → cloud escalation → human pause', () => {
    it('stays local below the cap, escalates at the cap, pauses beyond it', () => {
        expect(reworkAction(1)).toBe('local');
        expect(reworkAction(REWORK_CAP - 1)).toBe('local');
        expect(reworkAction(REWORK_CAP)).toBe('escalate-cloud');
        expect(reworkAction(REWORK_CAP + 1)).toBe('pause-human');
    });
});

describe('markReworkStuck', () => {
    it('flags the dev desk and appends a warning event', () => {
        writeFileSync(resolve(TMP, '.backend-status.json'), JSON.stringify({ currentPhase: 'addressing-feedback', events: [] }));
        markReworkStuck(TMP, 9, 'backend', REWORK_CAP + 1);
        const s = JSON.parse(readFileSync(resolve(TMP, '.backend-status.json'), 'utf-8'));
        expect(s.reworkStuck).toBe(true);
        expect(s.events.at(-1).type).toBe('warning');
        expect(s.events.at(-1).message).toMatch(/paused for human/i);
    });

    it('no-ops when the dev status file does not exist', () => {
        expect(() => markReworkStuck(TMP, 9, 'frontend', 4)).not.toThrow();
    });
});

describe('devLoopAction — validating-loop (generating↔validating) escalation', () => {
    it('stays local for a clean first pass, escalates when grinding, pauses when hopeless', () => {
        expect(devLoopAction(3)).toBe('local'); // analyzing→generating-code→validating
        expect(devLoopAction(VALIDATION_ESCALATE_AT - 1)).toBe('local');
        expect(devLoopAction(VALIDATION_ESCALATE_AT)).toBe('escalate-cloud');
        expect(devLoopAction(VALIDATION_PAUSE_AT)).toBe('pause-human');
    });
});

describe('Step 3 coordination — shared desk flags every spawn path reads', () => {
    it('isReworkStuck reflects the desk flag markReworkStuck sets', () => {
        writeFileSync(resolve(TMP, '.backend-status.json'), JSON.stringify({ currentPhase: 'addressing-feedback', events: [] }));
        expect(isReworkStuck(TMP, 'backend')).toBe(false);
        markReworkStuck(TMP, 7, 'backend', REWORK_CAP + 1);
        expect(isReworkStuck(TMP, 'backend')).toBe(true);
    });

    it('markEscalated makes escalation sticky (escalatedRespawnModel returns cloud)', () => {
        writeFileSync(resolve(TMP, '.backend-status.json'), JSON.stringify({ currentPhase: 'addressing-feedback', events: [] }));
        expect(escalatedRespawnModel(TMP, 'backend')).toBeUndefined();
        markEscalated(TMP, 'backend', 'rework round 3');
        expect(escalatedRespawnModel(TMP, 'backend')).toBe('cloud');
    });

    it('markEscalated is idempotent (does not re-append the event when already escalated)', () => {
        writeFileSync(resolve(TMP, '.backend-status.json'), JSON.stringify({ currentPhase: 'addressing-feedback', events: [] }));
        markEscalated(TMP, 'backend', 'first');
        markEscalated(TMP, 'backend', 'second');
        const s = JSON.parse(readFileSync(resolve(TMP, '.backend-status.json'), 'utf-8'));
        expect(s.events.filter((e: { message: string }) => /Escalated to cloud/.test(e.message)).length).toBe(1);
    });

    it('both flags return false/undefined when the desk file is absent', () => {
        expect(isReworkStuck(TMP, 'frontend')).toBe(false);
        expect(escalatedRespawnModel(TMP, 'frontend')).toBeUndefined();
    });
});

describe('markDevLoopStuck', () => {
    it('flags the dev desk with a validation-stuck warning', () => {
        writeFileSync(resolve(TMP, '.backend-status.json'), JSON.stringify({ currentPhase: 'generating-code', events: [] }));
        markDevLoopStuck(TMP, 'backend', 'LOCAL-B-0031', VALIDATION_PAUSE_AT);
        const s = JSON.parse(readFileSync(resolve(TMP, '.backend-status.json'), 'utf-8'));
        expect(s.reworkStuck).toBe(true);
        expect(s.events.at(-1).message).toMatch(/validating loop stuck/i);
    });
});
