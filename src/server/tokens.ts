import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { recordStoryTokens } from './ledger';
import type { TokenPhase } from './ledger';
import { parseJsonUtf8File } from './json-file';

export type TokenSource = 'cloud' | 'meshllm' | 'ollama' | 'mlx';

export interface TokenUpdate {
    agentId: string;
    source: TokenSource;
    input: number;
    output: number;
    phase?: TokenPhase;
    /** Target repo the work belongs to. Recorded on the ledger for per-repo attribution. */
    project?: string | null;
    /** Planning team the story belongs to. Recorded for per-team attribution/filtering. */
    team?: string | null;
}

export interface TokenMetrics {
    input: number;
    output: number;
}

export interface TokenState {
    cloud: TokenMetrics;
    meshllm: TokenMetrics;
    ollama: TokenMetrics;
    mlx: TokenMetrics;
}

const VALID_SOURCES: TokenSource[] = ['cloud', 'meshllm', 'ollama', 'mlx'];

export function isValidTokenSource(source: string): source is TokenSource {
    return VALID_SOURCES.includes(source as TokenSource);
}

export function defaultTokenState(): TokenState {
    return {
        cloud: { input: 0, output: 0 },
        meshllm: { input: 0, output: 0 },
        ollama: { input: 0, output: 0 },
        mlx: { input: 0, output: 0 } };
}

function appendEvent(raw: Record<string, unknown>, message: string): void {
    if (!Array.isArray(raw.events)) {
        raw.events = [];
    }
    (raw.events as Array<Record<string, string>>).push({
        timestamp: new Date().toISOString(),
        type: 'warning',
        message });
}

export function updateTokens(
    rootDir: string,
    update: TokenUpdate,
): { ok: boolean; tokens?: TokenState; error?: string } {
    if (!update.agentId) {
        return { ok: false, error: 'agentId is required' };
    }
    if (!isValidTokenSource(update.source)) {
        return { ok: false, error: `source must be one of: ${VALID_SOURCES.join(', ')}` };
    }
    if (typeof update.input !== 'number' || typeof update.output !== 'number') {
        return { ok: false, error: 'input and output must be numbers' };
    }

    const statusFile = resolve(rootDir, `.${update.agentId}-status.json`);

    let raw: Record<string, unknown>;
    if (!existsSync(statusFile)) {
        raw = { tokens: defaultTokenState() };
    } else {
        try {
            raw = parseJsonUtf8File(statusFile);
        } catch (e: unknown) {
            const msg = `Malformed status file for "${update.agentId}": ${e instanceof Error ? e.message : String(e)}`;
            const fallback: Record<string, unknown> = { tokens: defaultTokenState() };
            appendEvent(fallback, msg);
            raw = fallback;
        }
    }

    if (!raw.tokens || typeof raw.tokens !== 'object') {
        raw.tokens = defaultTokenState();
    }

    const tokens = raw.tokens as Record<string, TokenMetrics>;
    for (const source of VALID_SOURCES) {
        if (!tokens[source]) {
            tokens[source] = { input: 0, output: 0 };
        }
    }

    tokens[update.source].input += update.input;
    tokens[update.source].output += update.output;

    try {
        writeFileSync(statusFile, JSON.stringify(raw, null, 2));
    } catch (e: unknown) {
        const writeErr = e instanceof Error ? e.message : String(e);
        appendEvent(raw, `Failed to persist token update: ${writeErr}`);
        return { ok: false, error: `Failed to write status file: ${writeErr}` };
    }

    const storyNumber = raw.storyNumber as string | null | undefined;
    if (storyNumber && (update.input > 0 || update.output > 0)) {
        recordStoryTokens(rootDir, {
            storyNumber,
            storyName: (raw.storyName as string | null) ?? null,
            project: update.project ?? (raw.project as string | null) ?? null,
            team: update.team ?? (raw.teamId as string | null) ?? null,
            agent: update.agentId,
            source: update.source,
            phase: update.phase ?? 'development',
            input: update.input,
            output: update.output });
    }

    return { ok: true, tokens: tokens as unknown as TokenState };
}
