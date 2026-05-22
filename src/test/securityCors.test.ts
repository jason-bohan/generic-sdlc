import { afterEach, describe, expect, it } from 'vitest';
import { isE2eLocalhostOrigin } from '../server/security';

describe('isE2eLocalhostOrigin', () => {
    const prev = process.env.SDLC_FRAMEWORK_E2E;

    afterEach(() => {
        if (prev === undefined) delete process.env.SDLC_FRAMEWORK_E2E;
        else process.env.SDLC_FRAMEWORK_E2E = prev;
    });

    it('returns false when SDLC_FRAMEWORK_E2E is not set', () => {
        delete process.env.SDLC_FRAMEWORK_E2E;
        expect(isE2eLocalhostOrigin('http://localhost:4000')).toBe(false);
    });

    it('allows localhost origins on any port when SDLC_FRAMEWORK_E2E=1', () => {
        process.env.SDLC_FRAMEWORK_E2E = '1';
        expect(isE2eLocalhostOrigin('http://localhost:4000')).toBe(true);
        expect(isE2eLocalhostOrigin('http://127.0.0.1:3847')).toBe(true);
    });

    it('rejects non-localhost origins even in E2E mode', () => {
        process.env.SDLC_FRAMEWORK_E2E = '1';
        expect(isE2eLocalhostOrigin('https://evil.example')).toBe(false);
    });
});
