import { describe, it, expect } from 'vitest';
import {
    getSchedulerWorkflowMode,
    isValidSchedulerWorkflowMode,
    resolveAgentAssignmentPhase,
} from '../server/schedulerMode';

describe('schedulerMode', () => {
    it('defaults to notify when mode missing or unknown', () => {
        expect(getSchedulerWorkflowMode(null)).toBe('notify');
        expect(getSchedulerWorkflowMode({})).toBe('notify');
        expect(getSchedulerWorkflowMode({ scheduler: {} })).toBe('notify');
        expect(getSchedulerWorkflowMode({ scheduler: { mode: 'turbo' } })).toBe('notify');
    });

    it('reads autonomous', () => {
        expect(getSchedulerWorkflowMode({ scheduler: { mode: 'autonomous' } })).toBe('autonomous');
    });

    it('validates mode strings', () => {
        expect(isValidSchedulerWorkflowMode('notify')).toBe(true);
        expect(isValidSchedulerWorkflowMode('autonomous')).toBe(true);
        expect(isValidSchedulerWorkflowMode('foo')).toBe(false);
    });

    it('resolveAgentAssignmentPhase — notify without autoStart waits', () => {
        expect(resolveAgentAssignmentPhase('notify', false)).toEqual({
            phase: 'pending-approval',
            startedAt: null,
        });
    });

    it('resolveAgentAssignmentPhase — notify with autoStart starts', () => {
        const r = resolveAgentAssignmentPhase('notify', true);
        expect(r.phase).toBe('reading-story');
        expect(r.startedAt).toMatch(/^\d{4}-/);
    });

    it('resolveAgentAssignmentPhase — autonomous starts without autoStart', () => {
        const r = resolveAgentAssignmentPhase('autonomous', false);
        expect(r.phase).toBe('reading-story');
        expect(r.startedAt).toMatch(/^\d{4}-/);
    });
});
