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
