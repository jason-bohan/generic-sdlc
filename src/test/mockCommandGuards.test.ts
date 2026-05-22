import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

describe('mock command guards', () => {
    it('installs shell-level guards for agent runs in mock mode', () => {
        const source = readFileSync('bin/run-agent.ps1', 'utf-8');

        expect(source).toContain('function Install-MockModeCommandGuards');
        expect(source).toContain('git push is blocked');
        expect(source).toContain('Azure CLI is blocked');
        expect(source).toContain('$env:SDLC_FRAMEWORK_MOCK_MODE = "1"');
        expect(source).toMatch(/Install-MockModeCommandGuards\s*\r?\n\s*\}/);
    });
});
