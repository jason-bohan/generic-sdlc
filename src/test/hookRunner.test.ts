// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/status-events', () => ({
    startStatusFileWatcher: vi.fn(),
    onStatusChange: vi.fn(),
}));
vi.mock('../server/logger', () => ({
    serverLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { startStatusFileWatcher, onStatusChange } from '../server/status-events';
import { startHookRunner, stopHookRunner, isHookRunnerActive } from '../server/hook-runner';
import type { StatusChangeEvent } from '../server/status-events';

const ROOT_DIR = '/tmp/sdlc-framework-hook-runner-test';

function makeUnsub(): () => void {
    return vi.fn();
}

function setupOnStatusChange(): { emit: (ev: StatusChangeEvent) => void; unsub: ReturnType<typeof makeUnsub> } {
    const unsub = makeUnsub();
    let captured: ((ev: StatusChangeEvent) => void) | null = null;
    vi.mocked(onStatusChange).mockImplementation((handler) => {
        captured = handler;
        return unsub;
    });
    return {
        emit: (ev: StatusChangeEvent) => { captured?.(ev); },
        unsub,
    };
}

function makeEvent(agentId: string, phase: string): StatusChangeEvent {
    return {
        agentId,
        status: { currentPhase: phase },
        timestamp: new Date().toISOString(),
    };
}

beforeEach(() => {
    stopHookRunner();
    vi.mocked(startStatusFileWatcher).mockClear();
    vi.mocked(onStatusChange).mockClear();
});

afterEach(() => {
    stopHookRunner();
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe('startHookRunner', () => {
    it('calls startStatusFileWatcher with rootDir', () => {
        setupOnStatusChange();
        startHookRunner({ rootDir: ROOT_DIR });
        expect(vi.mocked(startStatusFileWatcher)).toHaveBeenCalledWith(ROOT_DIR);
    });

    it('subscribes to onStatusChange', () => {
        setupOnStatusChange();
        startHookRunner({ rootDir: ROOT_DIR });
        expect(vi.mocked(onStatusChange)).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — calling twice with the same rootDir does not re-subscribe', () => {
        setupOnStatusChange();
        startHookRunner({ rootDir: ROOT_DIR });
        startHookRunner({ rootDir: ROOT_DIR });
        expect(vi.mocked(onStatusChange)).toHaveBeenCalledTimes(1);
    });

    it('isHookRunnerActive returns true after start', () => {
        setupOnStatusChange();
        startHookRunner({ rootDir: ROOT_DIR });
        expect(isHookRunnerActive()).toBe(true);
    });
});

describe('stopHookRunner', () => {
    it('calls the unsubscribe function returned by onStatusChange', () => {
        const { unsub } = setupOnStatusChange();
        startHookRunner({ rootDir: ROOT_DIR });
        stopHookRunner();
        expect(unsub).toHaveBeenCalledTimes(1);
    });

    it('isHookRunnerActive returns false after stop', () => {
        setupOnStatusChange();
        startHookRunner({ rootDir: ROOT_DIR });
        stopHookRunner();
        expect(isHookRunnerActive()).toBe(false);
    });

    it('is a no-op when the hook-runner is not active', () => {
        const { unsub } = setupOnStatusChange();
        stopHookRunner();
        expect(unsub).not.toHaveBeenCalled();
    });

    it('allows re-registration after stop', () => {
        setupOnStatusChange();
        startHookRunner({ rootDir: ROOT_DIR });
        stopHookRunner();
        vi.mocked(onStatusChange).mockClear();
        vi.mocked(startStatusFileWatcher).mockClear();
        setupOnStatusChange();
        startHookRunner({ rootDir: ROOT_DIR });
        expect(vi.mocked(onStatusChange)).toHaveBeenCalledTimes(1);
    });
});

// ── Event forwarding and idempotency ─────────────────────────────────────────

describe('onEvent callback', () => {
    it('fires onEvent when a new phase is seen for an agent', () => {
        const { emit } = setupOnStatusChange();
        const received: StatusChangeEvent[] = [];
        startHookRunner({ rootDir: ROOT_DIR, onEvent: (ev) => received.push(ev) });

        emit(makeEvent('backend', 'analyzing'));
        expect(received).toHaveLength(1);
        expect(received[0].agentId).toBe('backend');
    });

    it('does NOT fire onEvent for the same agent+phase twice', () => {
        const { emit } = setupOnStatusChange();
        const received: StatusChangeEvent[] = [];
        startHookRunner({ rootDir: ROOT_DIR, onEvent: (ev) => received.push(ev) });

        emit(makeEvent('backend', 'analyzing'));
        emit(makeEvent('backend', 'analyzing'));
        expect(received).toHaveLength(1);
    });

    it('fires onEvent again when the phase changes', () => {
        const { emit } = setupOnStatusChange();
        const received: StatusChangeEvent[] = [];
        startHookRunner({ rootDir: ROOT_DIR, onEvent: (ev) => received.push(ev) });

        emit(makeEvent('backend', 'analyzing'));
        emit(makeEvent('backend', 'generating-code'));
        expect(received).toHaveLength(2);
    });

    it('tracks each agent independently', () => {
        const { emit } = setupOnStatusChange();
        const received: StatusChangeEvent[] = [];
        startHookRunner({ rootDir: ROOT_DIR, onEvent: (ev) => received.push(ev) });

        emit(makeEvent('backend', 'analyzing'));
        emit(makeEvent('frontend', 'analyzing'));
        expect(received).toHaveLength(2);
    });

    it('does not fire onEvent when onEvent is not provided', () => {
        const { emit } = setupOnStatusChange();
        expect(() => {
            startHookRunner({ rootDir: ROOT_DIR });
            emit(makeEvent('backend', 'analyzing'));
        }).not.toThrow();
    });

    it('clears phase tracking on stopHookRunner so re-start fires for the same phase', () => {
        const { emit: emit1 } = setupOnStatusChange();
        const received: StatusChangeEvent[] = [];
        startHookRunner({ rootDir: ROOT_DIR, onEvent: (ev) => received.push(ev) });
        emit1(makeEvent('backend', 'analyzing'));
        expect(received).toHaveLength(1);

        stopHookRunner();
        const { emit: emit2 } = setupOnStatusChange();
        startHookRunner({ rootDir: ROOT_DIR, onEvent: (ev) => received.push(ev) });
        emit2(makeEvent('backend', 'analyzing'));
        expect(received).toHaveLength(2);
    });
});
