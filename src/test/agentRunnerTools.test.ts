import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { executeToolCall, rewriteWorktreeAddOnCollision } from '../server/agent-runner/tools';

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
        expect(payload).not.toBeNull();
        const outputs = (payload as unknown as { outputs: Record<string, unknown> }).outputs;
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

    it('retries a transient connection failure instead of failing the phase', async () => {
        writeFileSync(STATUS_FILE, JSON.stringify({
            workflowItemId: 123, storyNumber: 'B-123', currentPhase: 'validating', tasks: [],
        }, null, 2));

        let calls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            calls++;
            if (calls === 1) throw new TypeError('fetch failed'); // server momentarily down
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }));

        const result = await executeToolCall(
            'complete_phase',
            { next_phase: 'committing', summary: 'validated', validation_results: 'tests passed' },
            TMP, TMP, 'frontend', resolve(TMP, '.sdlc-framework.config.json'),
        );

        expect(calls).toBe(2);
        expect(result).toContain('PHASE_COMPLETE::committing');
    });

    it('asks the model to retry (not escalate to error) when the server stays unreachable', async () => {
        writeFileSync(STATUS_FILE, JSON.stringify({
            workflowItemId: 123, storyNumber: 'B-123', currentPhase: 'validating', tasks: [],
        }, null, 2));

        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

        const result = await executeToolCall(
            'complete_phase',
            { next_phase: 'committing', summary: 'validated' },
            TMP, TMP, 'frontend', resolve(TMP, '.sdlc-framework.config.json'),
        );

        expect(result).toContain('call complete_phase again');
        expect(result).not.toContain('PHASE_COMPLETE');
    }, 10_000); // exhausts all retries (~6s of real backoff)
});

describe('rewriteWorktreeAddOnCollision', () => {
    it('rewrites a colliding worktree path and branch to a fresh -N suffix', () => {
        const cmd = 'git worktree add -b feature/LOCAL-B-0014 .claude/worktrees/frontend-LOCAL-B-0014 main';
        const out = rewriteWorktreeAddOnCollision(cmd, '/tmp/does-not-exist-xyz');
        expect(out).toBe('git worktree add -b feature/LOCAL-B-0014-2 .claude/worktrees/frontend-LOCAL-B-0014-2 main');
    });

    it('returns null for non-worktree-add commands', () => {
        expect(rewriteWorktreeAddOnCollision('npm test', '/tmp')).toBeNull();
        expect(rewriteWorktreeAddOnCollision('git worktree list', '/tmp')).toBeNull();
    });
});

describe('run_validation tool', () => {
    const VTMP = resolve(__dirname, '.run-validation-tmp');
    const cfg = resolve(VTMP, '.sdlc-framework.config.json');

    beforeEach(() => { rmSync(VTMP, { recursive: true, force: true }); mkdirSync(VTMP, { recursive: true }); });
    afterEach(() => rmSync(VTMP, { recursive: true, force: true }));

    it('reports PASSED and routes to committing when checks pass', async () => {
        writeFileSync(resolve(VTMP, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'exit 0' } }));
        const out = await executeToolCall('run_validation', {}, VTMP, VTMP, 'frontend', cfg);
        expect(out).toContain('OVERALL: PASSED');
        expect(out).toContain('next_phase="committing"');
    }, 30_000);

    it('reports FAILED and routes to generating-code when a check fails', async () => {
        writeFileSync(resolve(VTMP, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'exit 1' } }));
        const out = await executeToolCall('run_validation', {}, VTMP, VTMP, 'frontend', cfg);
        expect(out).toContain('OVERALL: FAILED');
        expect(out).toContain('next_phase="generating-code"');
    }, 30_000);

    it('treats a project with no checks as passing', async () => {
        writeFileSync(resolve(VTMP, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
        const out = await executeToolCall('run_validation', {}, VTMP, VTMP, 'frontend', cfg);
        expect(out).toContain('OVERALL: PASSED');
        expect(out).toContain('no checks configured');
    });
});
