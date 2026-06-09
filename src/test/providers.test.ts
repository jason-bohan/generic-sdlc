import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import {
    resolveNotifications,
    resolveProjectTracker,
    notify,
    MockNotifications,
    MockProjectTracker,
} from '../server/providers';
import { LinearProjectTracker } from '../server/providers/linear';

const TMP = resolve(tmpdir(), `providers-test-${Date.now()}`);

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.NOTIFY_PROVIDER;
    delete process.env.PM_PROVIDER;
});

// ── MockNotifications ──────────────────────────────────────────────────────

describe('MockNotifications', () => {
    it('captures sent payloads in .sent array', async () => {
        const n = new MockNotifications();
        await n.send({ title: 'PR Created', body: 'frontend opened PR #42', color: 'D97706' });
        await n.send({ title: 'Build Passed', body: 'CI green', color: '22c55e' });

        expect(n.sent).toHaveLength(2);
        expect(n.sent[0].title).toBe('PR Created');
        expect(n.sent[0].color).toBe('D97706');
        expect(n.sent[1].title).toBe('Build Passed');
    });

    it('returns true', async () => {
        const n = new MockNotifications();
        const result = await n.send({ title: 'x', body: 'y' });
        expect(result).toBe(true);
    });

    it('has providerName mock', () => {
        expect(new MockNotifications().providerName).toBe('mock');
    });
});

// ── resolveNotifications factory ───────────────────────────────────────────

describe('resolveNotifications', () => {
    it('returns MockNotifications when NOTIFY_PROVIDER=mock', async () => {
        process.env.NOTIFY_PROVIDER = 'mock';
        const n = await resolveNotifications(TMP);
        expect(n.providerName).toBe('mock');
    });

    it('returns MockNotifications when NOTIFY_PROVIDER=none', async () => {
        process.env.NOTIFY_PROVIDER = 'none';
        const n = await resolveNotifications(TMP);
        expect(n.providerName).toBe('mock');
    });

    it('returns TeamsNotifications when NOTIFY_PROVIDER=teams', async () => {
        process.env.NOTIFY_PROVIDER = 'teams';
        const n = await resolveNotifications(TMP);
        expect(n.providerName).toBe('teams');
    });

    it('defaults to TeamsNotifications when env var is unset', async () => {
        const n = await resolveNotifications(TMP);
        expect(n.providerName).toBe('teams');
    });
});

// ── notify() convenience helper ────────────────────────────────────────────

describe('notify()', () => {
    it('sends via mock provider and returns true', async () => {
        process.env.NOTIFY_PROVIDER = 'mock';
        const result = await notify(TMP, { title: 'Story Assigned', body: 'WI-1001 → frontend', color: '6366f1' });
        expect(result).toBe(true);
    });

    it('does not throw when NOTIFY_PROVIDER=none', async () => {
        process.env.NOTIFY_PROVIDER = 'none';
        await expect(notify(TMP, { title: 'x', body: 'y' })).resolves.toBe(true);
    });
});

// ── MockProjectTracker ─────────────────────────────────────────────────────

describe('MockProjectTracker', () => {
    it('has providerName mock', () => {
        expect(new MockProjectTracker().providerName).toBe('mock');
    });

    it('returns seeded teams', async () => {
        const tracker = new MockProjectTracker();
        const teams = await tracker.getTeams();
        expect(teams.length).toBeGreaterThan(0);
        expect(teams[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    });

    it('returns seeded stories', async () => {
        const tracker = new MockProjectTracker();
        const stories = await tracker.getStories();
        expect(stories.length).toBeGreaterThan(0);
        expect(stories[0]).toMatchObject({ number: expect.any(String), title: expect.any(String), source: 'mock' });
    });

    it('filters stories by team', async () => {
        const tracker = new MockProjectTracker();
        const all = await tracker.getStories();
        const firstTeam = all[0].team!;
        const filtered = await tracker.getStories({ team: firstTeam });
        expect(filtered.every(s => s.team === firstTeam)).toBe(true);
    });

    it('filters stories by text', async () => {
        const tracker = new MockProjectTracker();
        const results = await tracker.getStories({ text: 'pagination' });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].title.toLowerCase()).toContain('pagination');
    });

    it('fetches a work item by number', async () => {
        const tracker = new MockProjectTracker();
        const item = await tracker.getWorkItem('WI-1001');
        expect(item).not.toBeNull();
        expect(item!.number).toBe('WI-1001');
        expect(item!.lanes).toBeDefined();
    });

    it('returns null for an unknown work item', async () => {
        const tracker = new MockProjectTracker();
        expect(await tracker.getWorkItem('WI-9999')).toBeNull();
    });

    it('updates status', async () => {
        const tracker = new MockProjectTracker();
        const ok = await tracker.updateStatus('WI-1001', 'In Progress');
        expect(ok).toBe(true);
        const item = await tracker.getWorkItem('WI-1001');
        expect(item!.status).toBe('In Progress');
    });

    it('creates a new work item and returns it in subsequent getStories', async () => {
        const tracker = new MockProjectTracker();
        const created = await tracker.createWorkItem({ title: 'New test story', team: 'Alpha' });
        expect(created.id).toBeTruthy();
        expect(created.number).toMatch(/^WI-/);

        const stories = await tracker.getStories();
        expect(stories.some(s => s.title === 'New test story')).toBe(true);
    });
});

// ── resolveProjectTracker factory ──────────────────────────────────────────

describe('resolveProjectTracker', () => {
    it('returns MockProjectTracker when PM_PROVIDER=mock', async () => {
        process.env.PM_PROVIDER = 'mock';
        const tracker = await resolveProjectTracker(TMP, resolve(TMP, '.sdlc-framework.config.json'));
        expect(tracker.providerName).toBe('mock');
    });
});

// ── LinearProjectTracker.createWorkItem — teamId resolution ─────────────────
describe('LinearProjectTracker.createWorkItem', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.LINEAR_TEAM_ID;
    });

    it('sends the env LINEAR_TEAM_ID in the mutation input (regression: was undefined)', async () => {
        // Bug: when teamId came from process.env (not fields), the mutation sent
        // teamId: undefined → Linear 400 → swallowed mirror → local-only stories.
        process.env.LINEAR_TEAM_ID = 'team-123';
        let sentInput: Record<string, unknown> | undefined;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            sentInput = (JSON.parse(String((init as RequestInit).body)).variables as { input: Record<string, unknown> }).input;
            return new Response(JSON.stringify({
                data: { issueCreate: { success: true, issue: {
                    id: 'i1', identifier: 'UNW-200', number: 200, title: 'X', url: 'http://x',
                    description: '', state: { name: 'Backlog' }, team: { id: 'team-123', name: 'T' },
                    priority: 3, labels: { nodes: [] },
                } } },
            }), { status: 200 });
        });

        const tracker = new LinearProjectTracker('key');
        const item = await tracker.createWorkItem({ title: 'Mirror me', description: 'd' });

        expect(sentInput?.teamId).toBe('team-123');
        expect(item.number).toBe('UNW-200');
    });
});
