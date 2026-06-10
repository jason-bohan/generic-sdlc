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

function reworkFile(baseDir: string): string {
    return resolve(baseDir, '.build-rework-claim.json');
}

/**
 * Returns true the first time CI-failure rework is claimed for this (prId, headSha). Persists keys
 * under `.build-rework-claim.json` so a red, unchanged PR is routed to rework exactly once — but a
 * re-pushed fix (new head SHA) re-routes. Used by the deterministic build-gate driver so the GitHub
 * CI-failure path spawns the owner once per commit instead of every poll/auto-resume.
 */
export function tryClaimBuildRework(baseDir: string, prId: number, headSha: string): boolean {
    if (!headSha) return false;
    const file = reworkFile(baseDir);
    const key = `${prId}:${headSha}`;
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
