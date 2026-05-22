import { describe, it, expect } from 'vitest';
import { storyCreationRouteForMode } from '../server/modes';

describe('storyCreationRouteForMode', () => {
    it('routes local to Goose (Ollama)', () => {
        expect(storyCreationRouteForMode('local')).toBe('goose');
    });

    it('routes balanced to REST balanced path', () => {
        expect(storyCreationRouteForMode('balanced')).toBe('balanced');
    });

    it('routes speed to REST speed path', () => {
        expect(storyCreationRouteForMode('speed')).toBe('speed');
    });
});
