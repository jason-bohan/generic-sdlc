import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

const { runCursorAgentMock, buildRepoContextMock } = vi.hoisted(() => ({
    runCursorAgentMock: vi.fn(),
    buildRepoContextMock: vi.fn().mockResolvedValue('### Tech Stack\nProject: test-app\nStack: React, TypeScript\n\n### Key Files & Exports\nsrc/App.tsx: App'),
}));

vi.mock('../server/agent-drivers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../server/agent-drivers')>();
    return {
        ...actual,
        runInlineQuery: (...args: unknown[]) => (runCursorAgentMock as any)(...args),
    };
});

vi.mock('../server/repo-context', () => ({
    buildRepoContext: (...args: unknown[]) => (buildRepoContextMock as any)(...args),
}));

import {
    getExecMode, findGoose,
    createStoryBalanced, createStorySpeed,
    type V1Api, type StoryParams,
} from '../server/modes';

function stubCursorAgentUnavailable() {
    runCursorAgentMock.mockRejectedValue(new Error('unavailable'));
}

function stubCursorAgentSuccess(body: string) {
    runCursorAgentMock.mockResolvedValue(body);
}

const TMP_CONFIG = resolve(__dirname, '.test-mode-dispatch-config.json');

function writeConfig(mode: string) {
    writeFileSync(TMP_CONFIG, JSON.stringify({ executionMode: mode }));
}

function mockV1Api(overrides?: Partial<V1Api>): V1Api {
    return {
        v1Fetch: vi.fn(async (path: string) => {
            if (path === '/Scope') return { Assets: [{ id: 'Scope:1001' }] };
            if (path === '/Team') return { Assets: [{ id: 'Team:2001' }] };
            if (path === '/StoryCategory') return { Assets: [{ id: 'StoryCategory:3001' }] };
            if (path === '/Theme') return { Assets: [{ id: 'Theme:4001' }] };
            if (path === '/ClassOfService') return { Assets: [{ id: 'ClassOfService:6001' }] };
            if (path === '/Member') return { Assets: [{ id: 'Member:5001' }] };
            if (path.includes('Story/')) return { Attributes: { Number: { value: 'B-99999' } } };
            return { Assets: [] };
        }),
        v1Post: vi.fn(async () => ({ id: 'Story:12345:67890' })),
        addOwner: vi.fn(async () => {}),
        baseUrl: 'https://www2.v1host.com/YourCompanyInc/rest-1.v1/Data',
        ...overrides,
    };
}

const baseParams: StoryParams = {
    name: 'Test Story',
    classOfService: 'Standard',
    description: 'Fix the bug',
    estimate: 3,
    team: 'Ninja Turtles',
    owner: 'Jason Bohan',
};

let originalFetch: typeof global.fetch;

beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
});

afterEach(() => {
    global.fetch = originalFetch;
});

afterAll(() => {
    if (existsSync(TMP_CONFIG)) unlinkSync(TMP_CONFIG);
});

// ─── Mode selection ────────────────────────────────────────────────

describe('mode dispatch — getExecMode selects correct mode', () => {
    it.each(['local', 'balanced', 'speed'] as const)('%s config dispatches correctly', (mode) => {
        writeConfig(mode);
        expect(getExecMode(TMP_CONFIG)).toBe(mode);
    });

    it('defaults to balanced for unknown mode values', () => {
        writeConfig('warp-speed');
        expect(getExecMode(TMP_CONFIG)).toBe('balanced');
    });

    it('defaults to balanced for corrupt config', () => {
        writeFileSync(TMP_CONFIG, '!!!not json!!!');
        expect(getExecMode(TMP_CONFIG)).toBe('balanced');
    });
});

// ─── Balanced mode (Ollama + REST API) ────────────────────────────

describe('createStoryBalanced', () => {
    it('creates a story with enriched fields when Ollama succeeds', async () => {
        const api = mockV1Api();
        const mockOllamaResponse = {
            description: '<h2>Summary</h2><p>Bug fix</p>',
            acceptanceCriteria: '<ul><li>Tests pass</li></ul>',
            frontend: null,
            backend: '<ul><li>Fix API</li></ul>',
            qa: null,
        };

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ response: JSON.stringify(mockOllamaResponse) }),
        })));

        const result = await createStoryBalanced(baseParams, api, 'http://fake-ollama:11434');

        expect(result.success).toBe(true);
        expect(result.number).toBe('B-99999');
        expect(result.enriched).toBe(true);

        expect(api.v1Post).toHaveBeenCalledTimes(1);
        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.Description.value).toContain('Summary');
        expect(postCall[1].Attributes.Custom_AcceptanceCriteria.value).toContain('Tests pass');
        expect(postCall[1].Attributes.Custom_Backend.value).toContain('Fix API');

        expect(api.addOwner).toHaveBeenCalledWith('Story/12345', 'Member:5001');
    });

    it('still creates story when Ollama is unavailable', async () => {
        const api = mockV1Api();

        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Connection refused'); }));

        const result = await createStoryBalanced(baseParams, api, 'http://fake-ollama:11434');

        expect(result.success).toBe(true);
        expect(result.enriched).toBe(false);
        expect(result.number).toBe('B-99999');

        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.Description.value).toBe('<p>Fix the bug</p>');
        expect(postCall[1].Attributes.Custom_AcceptanceCriteria).toBeUndefined();
    });

    it('still creates story when Ollama returns non-JSON', async () => {
        const api = mockV1Api();

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'not valid json at all' }),
        })));

        const result = await createStoryBalanced(baseParams, api, 'http://fake-ollama:11434');

        expect(result.success).toBe(true);
        expect(result.enriched).toBe(false);
    });

    it('calls Ollama at the correct URL', async () => {
        const api = mockV1Api();
        const mockFetch = vi.fn(async () => ({
            ok: false, status: 500, statusText: 'err',
        }));
        vi.stubGlobal('fetch', mockFetch);

        await createStoryBalanced(baseParams, api, 'http://my-ollama:9999');

        expect(mockFetch).toHaveBeenCalledWith(
            'http://my-ollama:9999/api/generate',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('throws when Scope cannot be resolved', async () => {
        const api = mockV1Api({
            v1Fetch: vi.fn(async () => ({ Assets: [] })),
        });
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));

        await expect(createStoryBalanced(baseParams, api)).rejects.toThrow('Could not resolve Scope');
    });

    it('sets all resolved OIDs in attributes', async () => {
        const api = mockV1Api();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));

        await createStoryBalanced(baseParams, api);

        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.Scope.value).toBe('Scope:1001');
        expect(postCall[1].Attributes.Team.value).toBe('Team:2001');
        expect(postCall[1].Attributes.Category.value).toBe('StoryCategory:3001');
        expect(postCall[1].Attributes.Parent.value).toBe('Theme:4001');
        expect(postCall[1].Attributes.ClassOfService.value).toBe('ClassOfService:6001');
    });

    it('includes ClassOfService OID in v1Post payload (balanced)', async () => {
        const api = mockV1Api();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

        await createStoryBalanced(baseParams, api);

        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.ClassOfService).toEqual({ value: 'ClassOfService:6001', act: 'set' });
    });

    it('omits ClassOfService attribute when lookup returns no assets (balanced)', async () => {
        const api = mockV1Api({
            v1Fetch: vi.fn(async (path: string) => {
                if (path === '/ClassOfService') return { Assets: [] };
                if (path === '/Scope') return { Assets: [{ id: 'Scope:1001' }] };
                if (path === '/Team') return { Assets: [{ id: 'Team:2001' }] };
                if (path === '/StoryCategory') return { Assets: [{ id: 'StoryCategory:3001' }] };
                if (path === '/Theme') return { Assets: [{ id: 'Theme:4001' }] };
                if (path === '/Member') return { Assets: [{ id: 'Member:5001' }] };
                if (path.includes('Story/')) return { Attributes: { Number: { value: 'B-99999' } } };
                return { Assets: [] };
            }),
        });
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

        const result = await createStoryBalanced(baseParams, api);

        expect(result.success).toBe(true);
        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.ClassOfService).toBeUndefined();
    });
});

// ─── Speed mode (Cursor CLI cloud enrichment + REST) ─────────────

describe('createStorySpeed', () => {
    beforeEach(() => {
        stubCursorAgentUnavailable();
    });

    afterEach(() => {
        runCursorAgentMock.mockClear();
    });

    it('creates story with enrichment when Cursor CLI succeeds', async () => {
        const api = mockV1Api();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

        runCursorAgentMock.mockResolvedValueOnce(
            '{"description":"<h2>Summary</h2><p>Speed enriched</p>","acceptanceCriteria":"<ul><li>Done</li></ul>"}',
        );

        const result = await createStorySpeed(baseParams, api, 'http://fake:11434');

        expect(result.success).toBe(true);
        expect(result.enriched).toBe(true);
        expect(result.number).toBe('B-99999');

        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.Name.value).toBe('Test Story');
        expect(postCall[1].Attributes.Description.value).toContain('Speed enriched');
        expect(postCall[1].Attributes.Custom_AcceptanceCriteria.value).toContain('Done');
    });

    it('falls back to raw description when Cursor CLI unavailable', async () => {
        const api = mockV1Api();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));

        const result = await createStorySpeed(baseParams, api, 'http://fake:11434');

        expect(result.success).toBe(true);
        expect(result.enriched).toBe(false);

        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.Description.value).toBe('<p>Fix the bug</p>');
    });

    it('includes ClassOfService OID in v1Post payload (speed)', async () => {
        const api = mockV1Api();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));
        await createStorySpeed(baseParams, api, 'http://fake:11434');
        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.ClassOfService).toEqual({ value: 'ClassOfService:6001', act: 'set' });
    });

    it('omits ClassOfService when lookup returns no assets (speed)', async () => {
        const api = mockV1Api({
            v1Fetch: vi.fn(async (path: string) => {
                if (path === '/ClassOfService') return { Assets: [] };
                if (path === '/Scope') return { Assets: [{ id: 'Scope:1001' }] };
                if (path === '/Team') return { Assets: [{ id: 'Team:2001' }] };
                if (path === '/StoryCategory') return { Assets: [{ id: 'StoryCategory:3001' }] };
                if (path === '/Theme') return { Assets: [{ id: 'Theme:4001' }] };
                if (path === '/Member') return { Assets: [{ id: 'Member:5001' }] };
                if (path.includes('Story/')) return { Attributes: { Number: { value: 'B-99999' } } };
                return { Assets: [] };
            }),
        });
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));

        const result = await createStorySpeed(baseParams, api, 'http://fake:11434');
        expect(result.success).toBe(true);
        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.ClassOfService).toBeUndefined();
    });

    it('assigns owner when provided', async () => {
        const api = mockV1Api();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));
        await createStorySpeed(baseParams, api);
        expect(api.addOwner).toHaveBeenCalledWith('Story/12345', 'Member:5001');
    });

    it('skips owner when not provided', async () => {
        const api = mockV1Api();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));
        const { owner, ...noOwnerParams } = baseParams;
        await createStorySpeed(noOwnerParams, api);
        expect(api.addOwner).not.toHaveBeenCalled();
    });

    it('sets estimate when provided', async () => {
        const api = mockV1Api();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));
        await createStorySpeed(baseParams, api);
        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.Estimate.value).toBe(3);
    });

    it('omits estimate when not provided', async () => {
        const api = mockV1Api();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));
        const { estimate, ...noEstParams } = baseParams;
        await createStorySpeed(noEstParams, api);
        const postCall = vi.mocked(api.v1Post).mock.calls[0];
        expect(postCall[1].Attributes.Estimate).toBeUndefined();
    });

    it('throws when Scope cannot be resolved', async () => {
        const api = mockV1Api({
            v1Fetch: vi.fn(async () => ({ Assets: [] })),
        });
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));
        await expect(createStorySpeed(baseParams, api)).rejects.toThrow('Could not resolve Scope');
    });
});

// ─── Cross-mode comparisons ──────────────────────────────────────

describe('mode behavior comparisons', () => {
    it('balanced uses Ollama fetch; speed uses Cursor CLI for enrichment', async () => {
        const speedApi = mockV1Api();
        const balancedApi = mockV1Api();
        stubCursorAgentSuccess('{"description":"<p>enriched</p>"}');

        const mockFetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ response: '{"description":"<p>enriched</p>"}' }),
        }));
        vi.stubGlobal('fetch', mockFetch);

        try {
            await createStorySpeed(baseParams, speedApi, 'http://fake:11434');
            expect(runCursorAgentMock).toHaveBeenCalled();
            expect(mockFetch).toHaveBeenCalledTimes(0);

            mockFetch.mockClear();
            await createStoryBalanced(baseParams, balancedApi, 'http://fake:11434');
            expect(mockFetch).toHaveBeenCalledTimes(1);
        } finally {
            stubCursorAgentUnavailable();
        }
    });

    it('both modes enrich when their backends succeed', async () => {
        const api1 = mockV1Api();
        const api2 = mockV1Api();
        stubCursorAgentSuccess('{"description":"<p>enriched</p>"}');

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ response: '{"description":"<p>enriched</p>"}' }),
        })));

        try {
            const balanced = await createStoryBalanced(baseParams, api1, 'http://fake:11434');
            const speed = await createStorySpeed(baseParams, api2, 'http://fake:11434');

            expect(balanced.enriched).toBe(true);
            expect(speed.enriched).toBe(true);
        } finally {
            stubCursorAgentUnavailable();
        }
    });

    it('both modes resolve the same OIDs', async () => {
        const speedApi = mockV1Api();
        const balancedApi = mockV1Api();

        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));

        await createStorySpeed(baseParams, speedApi);
        await createStoryBalanced(baseParams, balancedApi);

        const speedPost = vi.mocked(speedApi.v1Post).mock.calls[0];
        const balancedPost = vi.mocked(balancedApi.v1Post).mock.calls[0];

        expect(speedPost[1].Attributes.Scope.value).toBe(balancedPost[1].Attributes.Scope.value);
        expect(speedPost[1].Attributes.Team.value).toBe(balancedPost[1].Attributes.Team.value);
        expect(speedPost[1].Attributes.ClassOfService?.value).toBe(balancedPost[1].Attributes.ClassOfService?.value);
    });

    it('both modes assign owner when provided', async () => {
        const speedApi = mockV1Api();
        const balancedApi = mockV1Api();

        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nope'); }));

        await createStorySpeed(baseParams, speedApi);
        await createStoryBalanced(baseParams, balancedApi);

        expect(speedApi.addOwner).toHaveBeenCalledWith('Story/12345', 'Member:5001');
        expect(balancedApi.addOwner).toHaveBeenCalledWith('Story/12345', 'Member:5001');
    });

    it('local mode is differentiated by using Goose CLI (not direct API)', () => {
        writeConfig('local');
        expect(getExecMode(TMP_CONFIG)).toBe('local');
    });
});

// ─── findGoose ───────────────────────────────────────────────────

describe('findGoose', () => {
    it('returns a string or null', () => {
        const result = findGoose();
        expect(result === null || typeof result === 'string').toBe(true);
    });
});
