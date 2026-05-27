import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mlxHost, probeMlx, startMlxIfConfigured } from '../server/mlxProvider';

describe('mlxHost()', () => {
    let saved: string | undefined;
    beforeEach(() => { saved = process.env.MLX_HOST; });
    afterEach(() => {
        if (saved === undefined) delete process.env.MLX_HOST;
        else process.env.MLX_HOST = saved;
    });

    it('returns default host when MLX_HOST is unset', () => {
        delete process.env.MLX_HOST;
        expect(mlxHost()).toBe('http://localhost:8082');
    });

    it('returns MLX_HOST when set', () => {
        process.env.MLX_HOST = 'http://localhost:9000';
        expect(mlxHost()).toBe('http://localhost:9000');
    });
});

describe('probeMlx()', () => {
    const mockFetch = vi.fn();
    beforeEach(() => { vi.stubGlobal('fetch', mockFetch); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('returns true when server responds ok', async () => {
        mockFetch.mockResolvedValue({ ok: true });
        const result = await probeMlx(true);
        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('/v1/models'),
            expect.objectContaining({ signal: expect.anything() }),
        );
    });

    it('returns false when server responds not ok', async () => {
        mockFetch.mockResolvedValue({ ok: false });
        const result = await probeMlx(true);
        expect(result).toBe(false);
    });

    it('returns false when fetch throws', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
        const result = await probeMlx(true);
        expect(result).toBe(false);
    });
});

describe('startMlxIfConfigured()', () => {
    const mockFetch = vi.fn();
    let savedModel: string | undefined;
    let savedHost: string | undefined;

    beforeEach(() => {
        vi.stubGlobal('fetch', mockFetch);
        savedModel = process.env.MLX_MODEL;
        savedHost = process.env.MLX_HOST;
        mockFetch.mockResolvedValue({ ok: false }); // not running by default
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        if (savedModel === undefined) delete process.env.MLX_MODEL;
        else process.env.MLX_MODEL = savedModel;
        if (savedHost === undefined) delete process.env.MLX_HOST;
        else process.env.MLX_HOST = savedHost;
    });

    it('skips launch when MLX_MODEL is not set', async () => {
        delete process.env.MLX_MODEL;
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        const result = await startMlxIfConfigured({ spawnFn });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/MLX_MODEL/);
        expect(spawnFn).not.toHaveBeenCalled();
    });

    it('skips launch when server is already running', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        mockFetch.mockResolvedValue({ ok: true });
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        const result = await startMlxIfConfigured({ spawnFn });
        expect(result.ok).toBe(true);
        expect(spawnFn).not.toHaveBeenCalled();
    });

    it('spawns mlx_lm.server with correct args when MLX_MODEL is set', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        delete process.env.MLX_HOST;
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        const result = await startMlxIfConfigured({ spawnFn });
        expect(result.ok).toBe(true);
        expect(spawnFn).toHaveBeenCalledWith(
            'python',
            ['-m', 'mlx_lm.server', '--model', 'mlx-community/Qwen3-8B-4bit', '--port', '8082'],
            expect.objectContaining({ stdio: 'ignore', detached: false }),
        );
    });

    it('uses port from MLX_HOST when set', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        process.env.MLX_HOST = 'http://localhost:9000';
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        await startMlxIfConfigured({ spawnFn });
        expect(spawnFn).toHaveBeenCalledWith(
            'python',
            ['-m', 'mlx_lm.server', '--model', 'mlx-community/Qwen3-8B-4bit', '--port', '9000'],
            expect.anything(),
        );
    });
});
