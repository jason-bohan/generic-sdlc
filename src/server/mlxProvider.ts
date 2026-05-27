import { spawn } from 'node:child_process';
import { mlxLog as log } from './logger';

const MLX_DEFAULT_HOST = 'http://localhost:8082';
const MLX_14B_DEFAULT_HOST = 'http://localhost:8083';
const PROBE_TIMEOUT_MS = 3_000;

let _mlxAvailable = false;
let _mlx14bAvailable = false;
let _lastProbe = 0;
let _lastProbe14b = 0;
const PROBE_COOLDOWN_MS = 30_000;

export function mlxHost(): string {
    return process.env.MLX_HOST || MLX_DEFAULT_HOST;
}

export function mlx14bHost(): string {
    return process.env.MLX_HOST_14B || MLX_14B_DEFAULT_HOST;
}

export function isMlxAvailable(): boolean {
    return _mlxAvailable;
}

export function isMlx14bAvailable(): boolean {
    return _mlx14bAvailable;
}

export async function probeMlx(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && now - _lastProbe < PROBE_COOLDOWN_MS) return _mlxAvailable;
    _lastProbe = now;

    try {
        const res = await fetch(`${mlxHost()}/v1/models`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        _mlxAvailable = res.ok;
        if (_mlxAvailable) log.success('detected at ' + mlxHost());
    } catch {
        _mlxAvailable = false;
    }
    return _mlxAvailable;
}

export async function probeMlx14b(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && now - _lastProbe14b < PROBE_COOLDOWN_MS) return _mlx14bAvailable;
    _lastProbe14b = now;

    try {
        const res = await fetch(`${mlx14bHost()}/v1/models`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        _mlx14bAvailable = res.ok;
        if (_mlx14bAvailable) log.success('14B detected at ' + mlx14bHost());
    } catch {
        _mlx14bAvailable = false;
    }
    return _mlx14bAvailable;
}

interface MlxModel {
    id: string;
    object: string;
}

interface MlxModelsResponse {
    data?: MlxModel[];
}

async function fetchModelsFromHost(host: string): Promise<MlxModelsResponse | null> {
    try {
        const res = await fetch(`${host}/v1/models`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const text = await res.text();
        if (!text.trim()) return { data: [] };
        return JSON.parse(text) as MlxModelsResponse;
    } catch {
        return null;
    }
}

async function fetchMlxModels(): Promise<MlxModelsResponse | null> {
    const data = await fetchModelsFromHost(mlxHost());
    _mlxAvailable = data !== null;
    return data;
}

export async function listMlxModels(): Promise<string[]> {
    const [data8b, data14b] = await Promise.allSettled([
        fetchModelsFromHost(mlxHost()),
        fetchModelsFromHost(mlx14bHost()),
    ]);
    const models: string[] = [];
    if (data8b.status === 'fulfilled' && data8b.value?.data) {
        models.push(...data8b.value.data.map(m => m.id));
    }
    if (data14b.status === 'fulfilled' && data14b.value?.data) {
        models.push(...data14b.value.data.map(m => m.id));
    }
    return models;
}

export async function getMlxHealth() {
    const [available, available14b] = await Promise.all([
        probeMlx(true),
        probeMlx14b(true),
    ]);
    const models = await listMlxModels();
    return {
        available: available || available14b,
        host: mlxHost(),
        host14b: mlx14bHost(),
        models,
        lastChecked: new Date().toISOString(),
    };
}

type SpawnFn = typeof spawn;

function portFromHost(host: string, defaultPort: number): number {
    try {
        const url = new URL(host);
        if (url.port) return parseInt(url.port, 10);
    } catch { /* use default */ }
    return defaultPort;
}

async function startMlxServer(
    model: string,
    host: string,
    defaultPort: number,
    label: string,
    probeFn: (force: boolean) => Promise<boolean>,
    deps: { spawnFn?: SpawnFn },
): Promise<{ ok: boolean; reason?: string }> {
    const already = await probeFn(true);
    if (already) return { ok: true };

    const port = portFromHost(host, defaultPort);
    const bindHost = process.env.MLX_BIND_HOST?.trim();
    const spawnArgs = ['--model', model, '--port', String(port)];
    if (bindHost) spawnArgs.push('--host', bindHost);

    // MLX_SERVER_CMD lets you point to the venv binary, e.g. ~/mlx-env/bin/mlx_lm.server
    const serverCmd = process.env.MLX_SERVER_CMD?.trim() || 'mlx_lm.server';
    const spawnFn = deps.spawnFn ?? spawn;
    log.info(`spawning ${label} --model ${model} --port ${port}${bindHost ? ` --host ${bindHost}` : ''}…`);
    const child = spawnFn(serverCmd, spawnArgs, { stdio: 'ignore', detached: false });
    child.on('error', (err) => log.warn(`${label}: ${err.message}`));
    child.on('exit', (code) => log.info(`${label} exited (code=${code})`));

    return { ok: true };
}

/**
 * Spawns `python -m mlx_lm.server` for the 8B slot (MLX_MODEL) and/or the 14B
 * slot (MLX_MODEL_14B) if configured and not already running.
 * Pass `spawnFn` to inject a test double (mirrors meshllmLauncher deps pattern).
 */
export async function startMlxIfConfigured(
    deps: { spawnFn?: SpawnFn } = {},
): Promise<{ ok: boolean; reason?: string }> {
    const model8b = process.env.MLX_MODEL?.trim();
    const model14b = process.env.MLX_MODEL_14B?.trim();

    if (!model8b && !model14b) {
        return { ok: false, reason: 'MLX_MODEL env var not set' };
    }

    const results = await Promise.all([
        model8b
            ? startMlxServer(model8b, mlxHost(), 8082, 'mlx_lm.server(8B)', probeMlx, deps)
            : Promise.resolve({ ok: true }),
        model14b
            ? startMlxServer(model14b, mlx14bHost(), 8083, 'mlx_lm.server(14B)', probeMlx14b, deps)
            : Promise.resolve({ ok: true }),
    ]);

    const failed = results.filter(r => !r.ok);
    if (failed.length === results.length) return failed[0];
    return { ok: true };
}
