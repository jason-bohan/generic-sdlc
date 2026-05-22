import { describe, it, expect } from 'vitest';
import { phaseWatcherTransition } from '../server/ado-bridge';

describe('phaseWatcherTransition', () => {
    it('returns null when status is null', () => {
        const map = new Map<string, string>();
        expect(phaseWatcherTransition('frontend', null, map)).toBeNull();
    });

    it('returns null when currentPhase is missing or not a string', () => {
        const map = new Map<string, string>();
        expect(phaseWatcherTransition('frontend', {}, map)).toBeNull();
        expect(phaseWatcherTransition('frontend', { currentPhase: undefined }, map)).toBeNull();
        expect(phaseWatcherTransition('frontend', { currentPhase: null as unknown as string }, map)).toBeNull();
        expect(phaseWatcherTransition('frontend', { currentPhase: 1 as unknown as string }, map)).toBeNull();
    });

    it('returns null when phase is unchanged', () => {
        const map = new Map<string, string>();
        map.set('frontend', 'planning');
        expect(phaseWatcherTransition('frontend', { currentPhase: 'planning' }, map)).toBeNull();
    });

    it('returns transition when phase changes', () => {
        const map = new Map<string, string>();
        map.set('frontend', 'planning');
        expect(phaseWatcherTransition('frontend', { currentPhase: 'validating' }, map)).toEqual({
            prevLabel: 'planning',
            phase: 'validating',
        });
    });

    it('uses (none) on first observation for an agent', () => {
        const map = new Map<string, string>();
        expect(phaseWatcherTransition('frontend', { currentPhase: 'reading-story' }, map)).toEqual({
            prevLabel: '(none)',
            phase: 'reading-story',
        });
    });
});
