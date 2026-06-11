import { describe, it, expect, beforeEach } from 'vitest';
import { withinAutoContinueCap, resetAutoContinueCap, AUTO_CONTINUE_CAP } from '../server/auto-continue';

describe('auto-continue cap (stops subprocess-driver spawn storms)', () => {
    beforeEach(() => resetAutoContinueCap());

    it('allows up to the cap, then blocks on the same (agent, phase, story)', () => {
        for (let i = 0; i < AUTO_CONTINUE_CAP; i++) {
            expect(withinAutoContinueCap('backend', 'reading-story', 'LOCAL-B-0070')).toBe(true);
        }
        // The (cap+1)th attempt is blocked — this is what would have stopped the 1,143× storm.
        expect(withinAutoContinueCap('backend', 'reading-story', 'LOCAL-B-0070')).toBe(false);
        expect(withinAutoContinueCap('backend', 'reading-story', 'LOCAL-B-0070')).toBe(false);
    });

    it('resets naturally when the phase advances (healthy progression is never capped)', () => {
        for (let i = 0; i < AUTO_CONTINUE_CAP + 2; i++) withinAutoContinueCap('backend', 'reading-story', 'S1');
        // A new phase is a different key → fresh budget.
        expect(withinAutoContinueCap('backend', 'analyzing', 'S1')).toBe(true);
    });

    it('is scoped per story', () => {
        for (let i = 0; i < AUTO_CONTINUE_CAP + 2; i++) withinAutoContinueCap('backend', 'reading-story', 'S1');
        expect(withinAutoContinueCap('backend', 'reading-story', 'S2')).toBe(true);
    });

    it('resetAutoContinueCap(agentId) clears only that agent', () => {
        for (let i = 0; i < AUTO_CONTINUE_CAP + 2; i++) withinAutoContinueCap('backend', 'p', 'S');
        for (let i = 0; i < AUTO_CONTINUE_CAP + 2; i++) withinAutoContinueCap('reviewer', 'p', 'S');
        resetAutoContinueCap('backend');
        expect(withinAutoContinueCap('backend', 'p', 'S')).toBe(true);   // cleared
        expect(withinAutoContinueCap('reviewer', 'p', 'S')).toBe(false); // untouched (still over cap)
    });
});
