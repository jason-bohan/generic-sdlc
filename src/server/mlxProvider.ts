import { spawn } from 'node:child_process';
import { mlxLog as log } from './logger';

const MLX_DEFAULT_HOST = 'http://localhost:8082';
const PROBE_TIMEOUT_MS = 3_000;

let _mlxAvailable = false;
let _lastProbe = 0;
const PROBE_COOLDOWN_MS = 30_000;

export function mlxHost(): string {
    return process.env.MLX_HOST || MLX_DEFAULT_HOST;
}

export function isMlxAvailable(): boolean {
    return _mlxAvailable;
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

interface MlxModel {
    id: string;
    object: string;
}

interface MlxModelsResponse {
    data?: MlxModel[];
}

async function fetchMlxModels(): Promise<MlxModelsResponse | null> {
    try {
        const res = await fetch(`${mlxHost()}/v1/models`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        _mlxAvailable = res.ok;
        if (!res.ok) return null;
        const text = await res.text();
        if (!text.trim()) return { data: [] };
        return JSON.parse(text) as MlxModelsResponse;
    } catch {
        _mlxAvailable = false;
        return null;
    }
}

export async function listMlxModels(): Promise<string[]> {
    const data = await fetchMlxModels();
    return data?.data?.map(m => m.id) ?? [];
}

export async function getMlxHealth() {
    const available = await probeMlx(true);
    const models = available ? await listMlxModels() : [];
    return {
        available,
        host: mlxHost(),
        models,
        lastChecked: new Date().toISOString(),
    };
}

type SpawnFn = typeof spawn;

/**
 * Spawns `python -m mlx_lm.server` if MLX_MODEL is configured and the server
 * isn't already running. No-ops silently when MLX_MODEL is unset.
 * Pass `spawnFn` to inject a test double (mirrors meshllmLauncher deps pattern).
 */
export async function startMlxIfConfigured(
    deps: { spawnFn?: SpawnFn } = {},
): Promise<{ ok: boolean; reason?: string }> {
    const model = process.env.MLX_MODEL?.trim();
    if (!model) return { ok: false, reason: 'MLX_MODEL env var not set' };

    const already = await probeMlx(true);
    if (already) return { ok: true };

    let port = 8082;
    try {
        const url = new URL(mlxHost());
        if (url.port) port = parseInt(url.port, 10);
    } catch { /* use default */ }

    const bindHost = process.env.MLX_BIND_HOST?.trim();
    const spawnArgs = ['-m', 'mlx_lm.server', '--model', model, '--port', String(port)];
    if (bindHost) spawnArgs.push('--host', bindHost);

    const spawnFn = deps.spawnFn ?? spawn;
    log.info(`spawning mlx_lm.server --model ${model} --port ${port}${bindHost ? ` --host ${bindHost}` : ''}…`);
    const child = spawnFn('python', spawnArgs, {
        stdio: 'ignore',
        detached: false,
    });
    child.on('error', (err) => log.warn(`mlx_lm.server: ${err.message}`));
    child.on('exit', (code) => log.info(`mlx_lm.server exited (code=${code})`));

    return { ok: true };
}
