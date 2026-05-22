import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCompleteNotifyKey, tryClaimBuildCompleteNotification } from '../server/build-complete-dedup';

describe('build-complete Teams dedup', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'sdlc-framework-dedup-'));
    });

    it('buildCompleteNotifyKey includes buildId when present', () => {
        expect(buildCompleteNotifyKey(42, 9001, 'passed')).toBe('42:9001:passed');
    });

    it('buildCompleteNotifyKey falls back when buildId is undefined', () => {
        expect(buildCompleteNotifyKey(42, undefined, 'passed')).toBe('42:passed');
    });

    it('tryClaim returns true once and false on duplicate', () => {
        expect(tryClaimBuildCompleteNotification(dir, 1, 100, 'passed')).toBe(true);
        expect(tryClaimBuildCompleteNotification(dir, 1, 100, 'passed')).toBe(false);
        const file = join(dir, '.build-complete-notify.json');
        expect(existsSync(file)).toBe(true);
        const keys = JSON.parse(readFileSync(file, 'utf-8'));
        expect(keys).toContain('1:100:passed');
    });

    it('different buildId for same PR can notify again', () => {
        expect(tryClaimBuildCompleteNotification(dir, 1, 100, 'passed')).toBe(true);
        expect(tryClaimBuildCompleteNotification(dir, 1, 101, 'passed')).toBe(true);
    });
});
