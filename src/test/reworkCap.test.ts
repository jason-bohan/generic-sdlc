import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { bumpReworkRound, resetReworkRound, reworkAction, markReworkStuck, REWORK_CAP } from '../server/rework-cap';

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
