import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mlxHost, mlx14bHost, probeMlx, probeMlx14b, startMlxIfConfigured } from '../server/mlxProvider';

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

describe('mlx14bHost()', () => {
    let saved: string | undefined;
    beforeEach(() => { saved = process.env.MLX_HOST_14B; });
    afterEach(() => {
        if (saved === undefined) delete process.env.MLX_HOST_14B;
        else process.env.MLX_HOST_14B = saved;
    });

    it('returns default 14B host when MLX_HOST_14B is unset', () => {
        delete process.env.MLX_HOST_14B;
        expect(mlx14bHost()).toBe('http://localhost:8083');
    });

    it('returns MLX_HOST_14B when set', () => {
        process.env.MLX_HOST_14B = 'http://192.168.1.50:8083';
        expect(mlx14bHost()).toBe('http://192.168.1.50:8083');
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

describe('probeMlx14b()', () => {
    const mockFetch = vi.fn();
    beforeEach(() => { vi.stubGlobal('fetch', mockFetch); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('returns true when 14B server responds ok', async () => {
        mockFetch.mockResolvedValue({ ok: true });
        const result = await probeMlx14b(true);
        expect(result).toBe(true);
    });

    it('returns false when 14B server is down', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
        const result = await probeMlx14b(true);
        expect(result).toBe(false);
    });
});

describe('startMlxIfConfigured()', () => {
    const mockFetch = vi.fn();
    let savedVars: Record<string, string | undefined> = {};

    beforeEach(() => {
        vi.stubGlobal('fetch', mockFetch);
        for (const k of ['MLX_MODEL', 'MLX_MODEL_14B', 'MLX_HOST', 'MLX_HOST_14B', 'MLX_BIND_HOST', 'MLX_SERVER_CMD']) {
            savedVars[k] = process.env[k];
            delete process.env[k];
        }
        mockFetch.mockResolvedValue({ ok: false }); // not running by default
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        for (const [k, v] of Object.entries(savedVars)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('skips launch when neither MLX_MODEL nor MLX_MODEL_14B is set', async () => {
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        const result = await startMlxIfConfigured({ spawnFn });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/MLX_MODEL/);
        expect(spawnFn).not.toHaveBeenCalled();
    });

    it('skips launch when 8B server is already running', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        mockFetch.mockResolvedValue({ ok: true });
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        const result = await startMlxIfConfigured({ spawnFn });
        expect(result.ok).toBe(true);
        expect(spawnFn).not.toHaveBeenCalled();
    });

    it('spawns 8B server with correct args', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        await startMlxIfConfigured({ spawnFn });
        expect(spawnFn).toHaveBeenCalledWith(
            'mlx_lm.server',
            ['--model', 'mlx-community/Qwen3-8B-4bit', '--port', '8082'],
            expect.objectContaining({ stdio: 'ignore', detached: false }),
        );
    });

    it('spawns 14B server on port 8083', async () => {
        process.env.MLX_MODEL_14B = 'mlx-community/Qwen3-14B-4bit';
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        await startMlxIfConfigured({ spawnFn });
        expect(spawnFn).toHaveBeenCalledWith(
            'mlx_lm.server',
            ['--model', 'mlx-community/Qwen3-14B-4bit', '--port', '8083'],
            expect.anything(),
        );
    });

    it('uses MLX_SERVER_CMD when set', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        process.env.MLX_SERVER_CMD = '/home/user/mlx-env/bin/mlx_lm.server';
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        await startMlxIfConfigured({ spawnFn });
        expect((spawnFn.mock.calls[0] as unknown as [string, string[]])[0]).toBe('/home/user/mlx-env/bin/mlx_lm.server');
        delete process.env.MLX_SERVER_CMD;
    });

    it('spawns both 8B and 14B when both are configured', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        process.env.MLX_MODEL_14B = 'mlx-community/Qwen3-14B-4bit';
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        await startMlxIfConfigured({ spawnFn });
        expect(spawnFn).toHaveBeenCalledTimes(2);
        const ports = (spawnFn.mock.calls as unknown as [string, string[]][]).map(c => c[1]).map(args => args[args.indexOf('--port') + 1]);
        expect(ports).toContain('8082');
        expect(ports).toContain('8083');
    });

    it('uses port from MLX_HOST for 8B', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        process.env.MLX_HOST = 'http://localhost:9000';
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        await startMlxIfConfigured({ spawnFn });
        const args: string[] = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
        expect(args[args.indexOf('--port') + 1]).toBe('9000');
    });

    it('passes --host when MLX_BIND_HOST is set', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        process.env.MLX_BIND_HOST = '0.0.0.0';
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        await startMlxIfConfigured({ spawnFn });
        const args: string[] = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
        expect(args).toContain('--host');
        expect(args[args.indexOf('--host') + 1]).toBe('0.0.0.0');
    });

    it('omits --host when MLX_BIND_HOST is not set', async () => {
        process.env.MLX_MODEL = 'mlx-community/Qwen3-8B-4bit';
        const spawnFn = vi.fn(() => ({ on: vi.fn() } as any));
        await startMlxIfConfigured({ spawnFn });
        const args: string[] = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
        expect(args).not.toContain('--host');
    });
});
