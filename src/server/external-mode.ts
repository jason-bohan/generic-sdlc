import { existsSync } from 'fs';
import { parseJsonUtf8File } from './json-file';

export type ExternalMode = 'live' | 'mock';

export function getExternalMode(configPath: string): ExternalMode {
    const envMode = process.env.SDLC_EXTERNAL_MODE?.toLowerCase();
    if (envMode === 'mock' || envMode === 'live') return envMode;

    if (!existsSync(configPath)) return 'live';
    try {
        const cfg = parseJsonUtf8File(configPath);
        const raw = String(cfg.externalMode ?? cfg.integrations?.mode ?? '').toLowerCase();
        return raw === 'mock' ? 'mock' : 'live';
    } catch {
        return 'live';
    }
}

export function isMockExternalMode(configPath: string): boolean {
    return getExternalMode(configPath) === 'mock';
}
