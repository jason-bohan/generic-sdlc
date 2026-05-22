import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseJsonUtf8File } from './json-file';

const MAX_KEYS = 500;

function notifyFile(baseDir: string): string {
    return resolve(baseDir, '.build-complete-notify.json');
}

export function buildCompleteNotifyKey(prId: number, buildId: number | undefined, result: 'passed' | 'failed'): string {
    return buildId != null && Number.isFinite(buildId) ? `${prId}:${buildId}:${result}` : `${prId}:${result}`;
}

/**
 * Returns true the first time this (prId, buildId, result) tuple is claimed for Teams notification.
 * Persists keys under `.build-complete-notify.json` so duplicate HTTP callbacks cannot spam Teams.
 */
export function tryClaimBuildCompleteNotification(
    baseDir: string,
    prId: number,
    buildId: number | undefined,
    result: 'passed' | 'failed',
): boolean {
    const file = notifyFile(baseDir);
    const key = buildCompleteNotifyKey(prId, buildId, result);
    let keys: string[] = [];
    if (existsSync(file)) {
        try {
            const raw = parseJsonUtf8File(file);
            keys = Array.isArray(raw) ? raw : [];
        } catch {
            keys = [];
        }
    }
    if (keys.includes(key)) {
        return false;
    }
    keys.push(key);
    writeFileSync(file, JSON.stringify(keys.slice(-MAX_KEYS), null, 2));
    return true;
}
