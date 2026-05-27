import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { dbGetOllamaState, dbSetOllamaState } from './db';
import { ollamaLog as log } from './logger';

const PULL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const EMBEDDING_MODEL = 'nomic-embed-text';
export const CUSTOM_MODEL_NAME = 'sdlc-local:latest';
export const TUNED_MODEL_NAME = 'sdlc-tuned:latest';

interface OllamaState {
    model: string;
    digest: string | null;
    lastPulled: string | null;
    /** True when the most recent pull installed a newer digest than the one before it. */
    modelUpdated: boolean;
    customModelReady: boolean;
    tunedModelReady: boolean;
    embeddingModelReady: boolean;
}

interface OllamaHealth {
    online: boolean;
    model: string;
    digest: string | null;
    lastPulled: string | null;
    modelUpdated: boolean;
    lastChecked: string;
    ragReady: boolean;
    tunedModelReady: boolean;
}

let _state: OllamaState = {
    model: process.env.LOCAL_LLM_MODEL || 'qwen3:8b',
    digest: null,
    lastPulled: null,
    modelUpdated: false,
    customModelReady: false,
    tunedModelReady: false,
    embeddingModelReady: false,
};
let _pullTimer: ReturnType<typeof setInterval> | null = null;
let _ollamaProcess: ChildProcess | null = null;
let _ollamaAvailable = false;
let _rootDir = '';

function loadState(_rootDir: string): void {
    try {
        const saved = dbGetOllamaState<Partial<OllamaState>>('state', {});
        _state = { ..._state, ...saved, modelUpdated: false };
    } catch { /* DB not ready yet — first run */ }
}

function saveState(_rootDir: string): void {
    try {
        dbSetOllamaState('state', _state);
    } catch { /* non-fatal */ }
}

export function ollamaHost(): string {
    const raw = process.env.OLLAMA_HOST || 'http://localhost:11434';
    // Add protocol if missing (e.g. OLLAMA_HOST=0.0.0.0 or 0.0.0.0:11434)
    const withProto = (raw.startsWith('http://') || raw.startsWith('https://')) ? raw : `http://${raw}`;
    // 0.0.0.0 is a valid bind address but not a valid client destination on Windows
    const normalized = withProto.replace('://0.0.0.0', '://127.0.0.1');
    // Add default Ollama port if none specified (e.g. OLLAMA_HOST=0.0.0.0 → http://127.0.0.1:11434)
    try {
        const url = new URL(normalized);
        if (!url.port) url.port = '11434';
        return url.origin;
    } catch {
        return 'http://localhost:11434';
    }
}

/** Drain an NDJSON streaming response, resolving when the stream ends. */
async function drainStream(res: Response): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) return;
    while (true) {
        const { done } = await reader.read();
        if (done) break;
    }
}

/** Pull a model via the Ollama REST API (works while Ollama is already running). */
async function pullModel(model: string, timeoutMs = 10 * 60 * 1000): Promise<void> {
    try {
        const res = await fetch(`${ollamaHost()}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model, stream: true }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            log.warn(`pull ${model} failed: HTTP ${res.status}`);
            return;
        }
        await drainStream(res);
        log.success(`pull ${model} complete`);
    } catch (e: unknown) {
        log.warn(`pull ${model} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** Strip `:tag` for Ollama create's `model` field (e.g. `sdlc-local:latest` → `sdlc-local`). */
function modelBaseName(full: string): string {
    const i = full.indexOf(':');
    return i >= 0 ? full.slice(0, i) : full;
}

/**
 * Parse a simple Modelfile (FROM, SYSTEM """...""" or SYSTEM "...", PARAMETER lines) for Ollama's
 * structured /api/create body (current Ollama rejects legacy `name` + `modelfile`).
 */
function parseModelfile(content: string): { from: string; system: string; parameters: Record<string, string | number> } | null {
    const fromMatch = content.match(/^\s*FROM\s+(\S+)/m);
    if (!fromMatch) return null;
    const from = fromMatch[1];
    let system = '';
    const triple = content.match(/SYSTEM\s+"""(.*?)"""/s);
    if (triple) system = triple[1].trim();
    else {
        const quoted = content.match(/SYSTEM\s+"(.*)"/s);
        if (quoted) system = quoted[1].trim();
    }
    const parameters: Record<string, string | number> = {};
    const paramRe = /^\s*PARAMETER\s+(\S+)\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = paramRe.exec(content)) !== null) {
        const key = m[1];
        let raw = m[2].trim();
        if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
            raw = raw.slice(1, -1);
        }
        const num = Number(raw);
        parameters[key] = raw !== '' && Number.isFinite(num) && !/\s/.test(raw) ? num : raw;
    }
    return { from, system, parameters };
}

/** Create a custom model from a Modelfile via the Ollama REST API. */
async function createModel(name: string, modelfilePath: string, timeoutMs = 10 * 60 * 1000): Promise<void> {
    let modelfile: string;
    try {
        modelfile = readFileSync(modelfilePath, 'utf-8');
    } catch (e: unknown) {
        log.warn(`could not read Modelfile at ${modelfilePath}: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }
    const base = modelBaseName(name);
    const parsed = parseModelfile(modelfile);

    try {
        if (parsed) {
            const body: Record<string, unknown> = {
                model: base,
                from: parsed.from,
                system: parsed.system,
                stream: true,
            };
            if (Object.keys(parsed.parameters).length) body.parameters = parsed.parameters;
            const res = await fetch(`${ollamaHost()}/api/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.ok) {
                await drainStream(res);
                log.success(`create ${name} complete`);
                return;
            }
            const detail = await res.text().catch(() => '');
            const short = detail.length > 320 ? `${detail.slice(0, 320)}…` : detail;
            log.warn(`create ${base} (structured) failed: HTTP ${res.status}${short ? ` — ${short}` : ''}`);
        }

        const resLegacy = await fetch(`${ollamaHost()}/api/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, modelfile, stream: true }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resLegacy.ok) {
            const detail = await resLegacy.text().catch(() => '');
            const short = detail.length > 320 ? `${detail.slice(0, 320)}…` : detail;
            log.warn(`create ${name} failed: HTTP ${resLegacy.status}${short ? ` — ${short}` : ''}`);
            return;
        }
        await drainStream(resLegacy);
        log.success(`create ${name} complete`);
    } catch (e: unknown) {
        log.warn(`create ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

export interface OllamaModelEntry {
    name: string;
    digest: string;
    size: number;
    modified_at: string;
}

export async function listOllamaModels(): Promise<OllamaModelEntry[]> {
    try {
        const res = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const data: any = await res.json();
        return (data.models ?? []).map((m: any) => ({
            name: m.name ?? m.model ?? 'unknown',
            digest: m.digest ?? '',
            size: m.size ?? 0,
            modified_at: m.modified_at ?? '',
        }));
    } catch { return []; }
}

/** Fetch the digest for a model from the local Ollama API. */
async function fetchDigest(model: string): Promise<string | null> {
    try {
        const res = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const data: any = await res.json();
        const base = model.includes(':') ? model.slice(0, model.indexOf(':')) : model;
        const entry = (data.models ?? []).find((m: any) => {
            const name: string = m.name ?? m.model ?? '';
            return (
                name === model
                || name === base
                || name === `${base}:latest`
                || name.startsWith(`${base}:`)
            );
        });
        return entry?.digest ?? null;
    } catch { return null; }
}

async function isModelPresent(model: string): Promise<boolean> {
    return (await fetchDigest(model)) !== null;
}

/** Pull the base LLM, then set up embedding model and custom Modelfile model. */
/** Check if Ollama is reachable; if not, spawn `ollama serve` and wait up to 15s. */
async function ensureOllamaRunning(): Promise<void> {
    try {
        const res = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) { _ollamaAvailable = true; return; }
    } catch { /* not running — start it */ }

    if (!_ollamaProcess) {
        log.info('Ollama not detected — spawning `ollama serve`...');
        _ollamaProcess = spawn('ollama', ['serve'], { stdio: 'ignore', detached: false });
        _ollamaProcess.on('error', (err) => {
            log.warn(`ollama serve: ${err.message} — cloud fallback will be used`);
            _ollamaAvailable = false;
            _ollamaProcess = null;
        });
        _ollamaProcess.on('exit', (code) => {
            log.info(`ollama serve exited (code=${code})`);
            _ollamaAvailable = false;
            _ollamaProcess = null;
        });
    }

    // Wait up to 15s for Ollama to come up
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        try {
            const res = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) { _ollamaAvailable = true; log.success('Ollama is up'); return; }
        } catch { /* still starting */ }
    }
    _ollamaAvailable = false;
    log.warn('Ollama unavailable — falling back to cloud (speed) mode');
}

export function isOllamaAvailable(): boolean {
    return _ollamaAvailable;
}

async function bootSequence(rootDir: string): Promise<void> {
    await ensureOllamaRunning();
    const model = _state.model;

    // 1 — Pull base model, track digest change
    log.info(`Pulling base model ${model}...`);
    const digestBefore = _state.digest;
    await pullModel(model);
    const digestAfter = await fetchDigest(model);
    const updated = !!digestAfter && digestAfter !== digestBefore;
    _state = { ..._state, digest: digestAfter ?? digestBefore, lastPulled: new Date().toISOString(), modelUpdated: updated };
    if (updated) log.success(`${model} updated — new digest: ${digestAfter}`);

    // 2 — Pull embedding model (small, fast — needed for RAG)
    const hasEmbed = await isModelPresent(EMBEDDING_MODEL);
    if (!hasEmbed) {
        log.info(`Pulling embedding model ${EMBEDDING_MODEL}...`);
        await pullModel(EMBEDDING_MODEL);
    }
    _state.embeddingModelReady = await isModelPresent(EMBEDDING_MODEL);

    // 3 — Create custom Modelfile model if Modelfile is present in rootDir
    const modelfilePath = resolve(rootDir, 'Modelfile');
    if (existsSync(modelfilePath)) {
        log.info(`Creating custom model ${CUSTOM_MODEL_NAME} from Modelfile...`);
        await createModel(CUSTOM_MODEL_NAME, modelfilePath);
        _state.customModelReady = await isModelPresent(CUSTOM_MODEL_NAME);
        if (_state.customModelReady) log.success(`Custom model ${CUSTOM_MODEL_NAME} ready`);
    }

    // 4 — Check for Unsloth fine-tuned model (created via tools/unsloth pipeline)
    _state.tunedModelReady = await isModelPresent(TUNED_MODEL_NAME);
    if (_state.tunedModelReady) log.success(`Fine-tuned model ${TUNED_MODEL_NAME} detected`);

    // 5 — Pre-warm the active model so first help-chat response is fast
    const activeModel = _state.tunedModelReady ? TUNED_MODEL_NAME
        : _state.customModelReady ? CUSTOM_MODEL_NAME : model;
    try {
        log.info(`Pre-warming ${activeModel}...`);
        await fetch(`${ollamaHost()}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: activeModel, messages: [{ role: 'user', content: 'hi' }], stream: false, think: false, options: { num_predict: 1 } }),
            signal: AbortSignal.timeout(3 * 60 * 1000),
        });
        log.success(`${activeModel} warm`);
    } catch { /* non-fatal — first chat will just be slower */ }

    saveState(rootDir);
}

/**
 * Returns the best available model name for inference.
 * Tuned (Unsloth) > Custom (Modelfile) > env override > base model.
 */
export function getActiveModel(): string {
    if (_state.tunedModelReady) return TUNED_MODEL_NAME;
    if (_state.customModelReady) return CUSTOM_MODEL_NAME;
    return process.env.LOCAL_LLM_MODEL || _state.model;
}

export function isTunedModelReady(): boolean {
    return _state.tunedModelReady;
}

export function isEmbeddingReady(): boolean {
    return _state.embeddingModelReady;
}

/**
 * Call once at server start (when not in test mode).
 * Runs the full boot sequence via REST API, then re-checks every 6 hours.
 */
export function startOllamaManager(rootDir: string): void {
    _rootDir = rootDir;
    loadState(rootDir);
    bootSequence(rootDir).catch((err) => log.error(`Boot sequence error: ${err}`));
    _pullTimer = setInterval(() => {
        bootSequence(rootDir).catch(() => {});
    }, PULL_INTERVAL_MS);
}

export function stopOllamaManager(): void {
    if (_pullTimer) {
        clearInterval(_pullTimer);
        _pullTimer = null;
    }
    if (_ollamaProcess) {
        _ollamaProcess.kill();
        _ollamaProcess = null;
    }
}

/** Returns the current health snapshot for the /api/ollama/health endpoint. */
export async function getOllamaHealth(): Promise<OllamaHealth & { meshllmAvailable?: boolean }> {
    let online = false;
    try {
        const res = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(3000) });
        online = res.ok;
    } catch { /* offline */ }

    let meshllmAvailable = false;
    try {
        const { isMeshllmAvailable } = await import('./meshllmProvider');
        meshllmAvailable = isMeshllmAvailable();
    } catch { /* meshllm module not loaded */ }

    return {
        online,
        model: getActiveModel(),
        digest: _state.digest,
        lastPulled: _state.lastPulled,
        modelUpdated: _state.modelUpdated,
        lastChecked: new Date().toISOString(),
        ragReady: _state.embeddingModelReady,
        tunedModelReady: _state.tunedModelReady,
        meshllmAvailable,
    };
}
