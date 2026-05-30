// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        watchFile: vi.fn(),
        unwatchFile: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
    };
});
vi.mock('../server/spawn-agent', () => ({ getActiveAgents: vi.fn().mockReturnValue({}) }));
vi.mock('../server/agent-runner/registry', () => ({ getActiveSessionId: vi.fn().mockReturnValue(undefined), isRunnerActive: vi.fn().mockReturnValue(false) }));
vi.mock('../server/route-shared', () => ({ getAgentModel: vi.fn().mockReturnValue('cloud') }));
vi.mock('../server/json-file', () => ({ parseJsonUtf8File: vi.fn().mockReturnValue({}) }));
vi.mock('../server/status-normalize', () => ({
    normalizeStatus: vi.fn().mockImplementation((_raw: unknown, agentId: string) => ({ agentId, phase: 'idle' })),
    getDefaultStatus: vi.fn().mockImplementation((agentId: string) => ({ agentId, phase: 'idle' })),
}));

import { watchFile, unwatchFile } from 'fs';
import {
    emitChatMessage,
    emitStatusChange,
    onAgentStatusChange,
    onChatMessage,
    onStatusChange,
    startStatusFileWatcher,
    stopStatusFileWatcher,
    type ChatMessageEvent,
    type StatusChangeEvent,
} from '../server/status-events';

const AGENT_IDS = ['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops', 'aiqa'];

// Ensure each test starts and ends with a clean watcher state and clear mock history.
beforeEach(() => {
    stopStatusFileWatcher();
    vi.mocked(watchFile).mockClear();
    vi.mocked(unwatchFile).mockClear();
});
afterEach(() => {
    stopStatusFileWatcher();
    vi.mocked(watchFile).mockClear();
    vi.mocked(unwatchFile).mockClear();
});

// ── Event bus — status ────────────────────────────────────────────────────────

describe('emitStatusChange / onStatusChange', () => {
    it('delivers event to a global subscriber', () => {
        const received: StatusChangeEvent[] = [];
        const unsub = onStatusChange((ev) => received.push(ev));
        emitStatusChange('frontend', { phase: 'coding' });
        unsub();
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ agentId: 'frontend', status: { phase: 'coding' } });
    });

    it('populates timestamp as ISO string', () => {
        let ev: StatusChangeEvent | undefined;
        const unsub = onStatusChange((e) => { ev = e; });
        emitStatusChange('backend', {});
        unsub();
        expect(ev?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('unsubscribe stops delivery', () => {
        const received: StatusChangeEvent[] = [];
        const unsub = onStatusChange((ev) => received.push(ev));
        unsub();
        emitStatusChange('frontend', {});
        expect(received).toHaveLength(0);
    });

    it('multiple subscribers all receive the event', () => {
        const a: StatusChangeEvent[] = [];
        const b: StatusChangeEvent[] = [];
        const unsubA = onStatusChange((ev) => a.push(ev));
        const unsubB = onStatusChange((ev) => b.push(ev));
        emitStatusChange('qa', { phase: 'testing' });
        unsubA();
        unsubB();
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
    });
});

describe('onAgentStatusChange', () => {
    it('receives events for the subscribed agentId', () => {
        const received: StatusChangeEvent[] = [];
        const unsub = onAgentStatusChange('frontend', (ev) => received.push(ev));
        emitStatusChange('frontend', { phase: 'coding' });
        unsub();
        expect(received).toHaveLength(1);
        expect(received[0].agentId).toBe('frontend');
    });

    it('does NOT receive events for a different agentId', () => {
        const received: StatusChangeEvent[] = [];
        const unsub = onAgentStatusChange('frontend', (ev) => received.push(ev));
        emitStatusChange('backend', { phase: 'coding' });
        unsub();
        expect(received).toHaveLength(0);
    });

    it('global onStatusChange fires for any agent; per-agent does not cross-fire', () => {
        const global: string[] = [];
        const perAgent: string[] = [];
        const unsubGlobal = onStatusChange((ev) => global.push(ev.agentId));
        const unsubPerAgent = onAgentStatusChange('reviewer', (ev) => perAgent.push(ev.agentId));
        emitStatusChange('frontend', {});
        emitStatusChange('reviewer', {});
        emitStatusChange('devops', {});
        unsubGlobal();
        unsubPerAgent();
        expect(global).toEqual(['frontend', 'reviewer', 'devops']);
        expect(perAgent).toEqual(['reviewer']);
    });

    it('unsubscribe stops per-agent delivery', () => {
        const received: StatusChangeEvent[] = [];
        const unsub = onAgentStatusChange('ux', (ev) => received.push(ev));
        unsub();
        emitStatusChange('ux', {});
        expect(received).toHaveLength(0);
    });
});

// ── Event bus — chat ─────────────────────────────────────────────────────────

describe('emitChatMessage / onChatMessage', () => {
    const msg = { id: 'msg-1', from: 'user', message: 'hello', timestamp: new Date().toISOString() };

    it('delivers message to the per-agent subscriber', () => {
        const received: ChatMessageEvent[] = [];
        const unsub = onChatMessage('frontend', (ev) => received.push(ev));
        emitChatMessage('frontend', msg);
        unsub();
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ agentId: 'frontend', message: msg });
    });

    it('does NOT deliver to a subscriber on a different agentId', () => {
        const received: ChatMessageEvent[] = [];
        const unsub = onChatMessage('backend', (ev) => received.push(ev));
        emitChatMessage('frontend', msg);
        unsub();
        expect(received).toHaveLength(0);
    });

    it('unsubscribe stops delivery', () => {
        const received: ChatMessageEvent[] = [];
        const unsub = onChatMessage('frontend', (ev) => received.push(ev));
        unsub();
        emitChatMessage('frontend', msg);
        expect(received).toHaveLength(0);
    });

    it('includes optional status field when provided', () => {
        let ev: ChatMessageEvent | undefined;
        const unsub = onChatMessage('qa', (e) => { ev = e; });
        emitChatMessage('qa', { ...msg, status: 'sent' });
        unsub();
        expect(ev?.message.status).toBe('sent');
    });
});

// ── File watcher lifecycle ────────────────────────────────────────────────────

describe('startStatusFileWatcher', () => {
    it('registers watchFile for every agent status file', () => {
        startStatusFileWatcher('/tmp/sdlc-framework');
        const watched = vi.mocked(watchFile).mock.calls.map(([file]) => file as string);
        for (const id of AGENT_IDS) {
            expect(watched.some((f) => f.includes(`.${id}-status.json`))).toBe(true);
        }
        expect(vi.mocked(watchFile)).toHaveBeenCalledTimes(AGENT_IDS.length);
    });

    it('is idempotent — calling twice with the same dir does not re-register', () => {
        startStatusFileWatcher('/tmp/sdlc-framework');
        startStatusFileWatcher('/tmp/sdlc-framework');
        expect(vi.mocked(watchFile)).toHaveBeenCalledTimes(AGENT_IDS.length);
    });

    it('switching to a new dir calls unwatchFile for the old dir first', () => {
        startStatusFileWatcher('/tmp/dir-a');
        vi.mocked(watchFile).mockClear();
        vi.mocked(unwatchFile).mockClear();
        startStatusFileWatcher('/tmp/dir-b');
        expect(vi.mocked(unwatchFile)).toHaveBeenCalledTimes(AGENT_IDS.length);
        expect(vi.mocked(watchFile)).toHaveBeenCalledTimes(AGENT_IDS.length);
    });
});

describe('stopStatusFileWatcher', () => {
    it('calls unwatchFile for every agent', () => {
        startStatusFileWatcher('/tmp/sdlc-framework');
        vi.mocked(unwatchFile).mockClear();
        stopStatusFileWatcher();
        expect(vi.mocked(unwatchFile)).toHaveBeenCalledTimes(AGENT_IDS.length);
    });

    it('is a no-op when no watcher is active', () => {
        stopStatusFileWatcher();
        expect(vi.mocked(unwatchFile)).not.toHaveBeenCalled();
    });

    it('allows re-registration after stop', () => {
        startStatusFileWatcher('/tmp/sdlc-framework');
        stopStatusFileWatcher();
        vi.mocked(watchFile).mockClear();
        startStatusFileWatcher('/tmp/sdlc-framework');
        expect(vi.mocked(watchFile)).toHaveBeenCalledTimes(AGENT_IDS.length);
    });
});

// ── File change debounce ──────────────────────────────────────────────────────

describe('file watcher debounce', () => {
    // Start the watcher first, then fake timers — so watchFile registration
    // is recorded before the fake-timer environment is active.
    beforeEach(() => {
        startStatusFileWatcher('/tmp/sdlc-framework');
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function getWatcherCallback(agentId: string): () => void {
        const calls = vi.mocked(watchFile).mock.calls as unknown as Array<[string, object, () => void]>;
        const call = calls.find(([file]) => (file as string).includes(`.${agentId}-status.json`));
        if (!call) throw new Error(`No watchFile call found for ${agentId}`);
        return call[2];
    }

    it('does not emit before the 150ms debounce window elapses', () => {
        const received: StatusChangeEvent[] = [];
        const unsub = onAgentStatusChange('frontend', (ev) => received.push(ev));

        getWatcherCallback('frontend')();
        vi.advanceTimersByTime(149);
        expect(received).toHaveLength(0);
        unsub();
    });

    it('emits exactly once after the debounce window', () => {
        const received: StatusChangeEvent[] = [];
        const unsub = onAgentStatusChange('frontend', (ev) => received.push(ev));

        getWatcherCallback('frontend')();
        vi.advanceTimersByTime(150);
        expect(received).toHaveLength(1);
        unsub();
    });

    it('coalesces rapid successive changes into a single emit', () => {
        const received: StatusChangeEvent[] = [];
        const unsub = onAgentStatusChange('backend', (ev) => received.push(ev));
        const trigger = getWatcherCallback('backend');

        trigger();
        vi.advanceTimersByTime(50);
        trigger();
        vi.advanceTimersByTime(50);
        trigger();
        vi.advanceTimersByTime(150);
        expect(received).toHaveLength(1);
        unsub();
    });

    it('emitted event carries the correct agentId', () => {
        let ev: StatusChangeEvent | undefined;
        const unsub = onAgentStatusChange('qa', (e) => { ev = e; });

        getWatcherCallback('qa')();
        vi.advanceTimersByTime(150);
        expect(ev?.agentId).toBe('qa');
        unsub();
    });
});
