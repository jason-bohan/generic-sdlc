import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { executeToolCall } from '../server/agent-runner/tools';

const TMP = resolve(__dirname, '.agent-runner-tools-tmp');
const STATUS_FILE = resolve(TMP, '.frontend-status.json');

describe('agent runner complete_phase tool', () => {
    const originalServerUrl = process.env.SDLC_SERVER_URL;

    beforeEach(() => {
        rmSync(TMP, { recursive: true, force: true });
        mkdirSync(TMP, { recursive: true });
        process.env.SDLC_SERVER_URL = 'http://127.0.0.1:39999';
        vi.restoreAllMocks();
    });

    afterEach(() => {
        if (originalServerUrl === undefined) delete process.env.SDLC_SERVER_URL;
        else process.env.SDLC_SERVER_URL = originalServerUrl;
        vi.restoreAllMocks();
        rmSync(TMP, { recursive: true, force: true });
    });

    it('does not fabricate successful phase evidence when args omit it', async () => {
        writeFileSync(STATUS_FILE, JSON.stringify({
            workflowItemId: 123,
            storyNumber: 'B-123',
            currentPhase: 'validating',
            tasks: [{ id: 'T-001', name: 'Validate form' }],
        }, null, 2));

        let payload: Record<string, unknown> | null = null;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            payload = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ ok: false, missing: ['validationResults'] }), { status: 409 });
        }));

        const result = await executeToolCall(
            'complete_phase',
            { next_phase: 'creating-pr', summary: 'done' },
            TMP,
            TMP,
            'frontend',
            resolve(TMP, '.sdlc-framework.config.json'),
        );

        expect(result).toContain('HTTP 409');
        const outputs = payload?.outputs as Record<string, unknown>;
        expect(outputs).toMatchObject({
            tasks: [{ id: 'T-001', name: 'Validate form' }],
            taskIds: ['T-001'],
        });
        expect(outputs.validationResults).toBeUndefined();
        expect(outputs.reviewVerdict).toBeUndefined();
        expect(outputs.testResults).toBeUndefined();
        expect(outputs.staticAnalysis).toBeUndefined();
        expect(outputs.build).toBeUndefined();
    });

    it('updates status currentPhase only after complete-phase succeeds', async () => {
        writeFileSync(STATUS_FILE, JSON.stringify({
            workflowItemId: 123,
            storyNumber: 'B-123',
            currentPhase: 'validating',
            tasks: [],
        }, null, 2));

        vi.stubGlobal('fetch', vi.fn(async () => {
            return new Response(JSON.stringify({ ok: true, workflow: { active_phase: 'creating-pr' } }), { status: 200 });
        }));

        const result = await executeToolCall(
            'complete_phase',
            {
                next_phase: 'creating-pr',
                summary: 'validation complete',
                validation_results: 'npm test passed',
                static_analysis: 'tsc passed',
                test_results: '12 tests passed',
                risks: 'None identified',
            },
            TMP,
            TMP,
            'frontend',
            resolve(TMP, '.sdlc-framework.config.json'),
        );

        expect(result).toContain('HTTP 200');
        const status = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
        expect(status.currentPhase).toBe('creating-pr');
    });
});
