import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureDockerRunning, resolveMeshllmLaunch, startMeshllm } from '../server/meshllmLauncher';

const TMP = resolve(__dirname, '.meshllm-launch-tmp');

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
});

describe('MeshLLM launcher', () => {
    it('reports that launch is unavailable until a start command is configured', () => {
        const status = resolveMeshllmLaunch({
            env: {},
            commandExists: () => false,
        });

        expect(status).toMatchObject({
            canLaunch: false,
            source: null,
        });
        expect(status.reason).toContain('MESHLLM_START_COMMAND');
    });

    it('uses MESHLLM_START_COMMAND as the launch command', () => {
        const status = resolveMeshllmLaunch({
            env: { MESHLLM_START_COMMAND: 'meshllm serve --port 9337' },
            commandExists: () => false,
        });

        expect(status).toMatchObject({
            canLaunch: true,
            source: 'env',
            command: 'meshllm serve --port 9337',
        });
    });

    it('uses the local Docker Compose meshllm service when Docker is available and running', () => {
        mkdirSync(TMP, { recursive: true });
        writeFileSync(resolve(TMP, 'docker-compose.yml'), [
            'services:',
            '  meshllm:',
            '    profiles: ["meshllm"]',
        ].join('\n'));

        const status = resolveMeshllmLaunch({
            rootDir: TMP,
            env: {},
            commandExists: (name) => name === 'docker',
            isDockerRunning: () => true,
        });

        expect(status).toMatchObject({
            canLaunch: true,
            source: 'docker',
            command: 'docker compose -f docker-compose.yml --profile meshllm up -d meshllm',
        });
    });

    it('preserves the local MeshLLM model override when auto-launching Docker', () => {
        mkdirSync(TMP, { recursive: true });
        writeFileSync(resolve(TMP, 'docker-compose.yml'), [
            'services:',
            '  meshllm:',
            '    profiles: ["meshllm"]',
        ].join('\n'));
        writeFileSync(resolve(TMP, 'docker-compose.gpu.yml'), 'services: {}\n');
        writeFileSync(resolve(TMP, 'docker-compose.meshllm-local.yml'), 'services: {}\n');

        const status = resolveMeshllmLaunch({
            rootDir: TMP,
            env: { MESHLLM_MODEL: '/models/model.gguf' },
            commandExists: (name) => name === 'docker',
            isDockerRunning: () => true,
        });

        expect(status.command).toBe(
            'docker compose -f docker-compose.yml -f docker-compose.gpu.yml -f docker-compose.meshllm-local.yml --profile meshllm up -d meshllm',
        );
    });

    it('reports canLaunch:false with a clear message when Docker is installed but the daemon is not running', () => {
        mkdirSync(TMP, { recursive: true });
        writeFileSync(resolve(TMP, 'docker-compose.yml'), [
            'services:',
            '  meshllm:',
            '    profiles: ["meshllm"]',
        ].join('\n'));

        const status = resolveMeshllmLaunch({
            rootDir: TMP,
            env: {},
            commandExists: (name) => name === 'docker',
            isDockerRunning: () => false,
        });

        expect(status.canLaunch).toBe(false);
        expect(status.source).toBe('docker');
        expect(status.reason).toMatch(/daemon is not running/i);
        expect(status.reason).toMatch(/Docker Desktop/i);
    });

    it('starts a configured command without blocking the API request', async () => {
        const spawn = vi.fn(() => ({ unref: vi.fn() }));

        const result = await startMeshllm('C:/repo', {
            env: { MESHLLM_START_COMMAND: 'meshllm serve --port 9337' },
            commandExists: () => false,
            spawn,
        });

        expect(result.ok).toBe(true);
        expect(spawn).toHaveBeenCalledWith(
            'meshllm serve --port 9337',
            expect.objectContaining({ detached: true, shell: true, windowsHide: true }),
        );
    });

    it('auto-starts Docker Desktop and retries when daemon is not running', async () => {
        mkdirSync(TMP, { recursive: true });
        writeFileSync(resolve(TMP, 'docker-compose.yml'), [
            'services:',
            '  meshllm:',
            '    profiles: ["meshllm"]',
        ].join('\n'));

        let desktopSpawned = false;
        const spawn = vi.fn((cmd: string) => {
            if (cmd.includes('Docker Desktop')) desktopSpawned = true;
            return { unref: vi.fn() };
        });
        const sleep = vi.fn(() => Promise.resolve());
        // Daemon is down until Docker Desktop has been spawned
        const isDockerRunning = vi.fn(() => desktopSpawned);

        const result = await startMeshllm(TMP, {
            env: {},
            commandExists: (name) => name === 'docker',
            isDockerRunning,
            spawn,
            sleep,
            findDockerDesktop: () => 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
        });

        expect(result.ok).toBe(true);
        // Docker Desktop launch + meshllm compose up
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(spawn).toHaveBeenCalledWith(
            expect.stringContaining('Docker Desktop.exe'),
            expect.objectContaining({ detached: true }),
        );
        expect(spawn).toHaveBeenCalledWith(
            'docker compose -f docker-compose.yml --profile meshllm up -d meshllm',
            expect.objectContaining({ detached: true }),
        );
    });

    it('returns ok:false if Docker Desktop cannot be found on this machine', async () => {
        const result = await ensureDockerRunning({
            isDockerRunning: () => false,
            findDockerDesktop: () => undefined,
            spawn: vi.fn(() => ({ unref: vi.fn() })),
            sleep: vi.fn(() => Promise.resolve()),
        });

        expect(result).toBe(false);
    });
});
