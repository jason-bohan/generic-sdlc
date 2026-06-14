import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
import { executeToolCall, rewriteWorktreeAddOnCollision, parseWorktreeAddPath, parseWorktreeAddBranch, parseWorktreeList, autoCommitWorktree, findStoryWorktree, autoCreatePr } from '../server/agent-runner/tools';

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

    it('fills validating outputs from the recorded run_validation PASS verdict (not fabricated)', async () => {
        writeFileSync(STATUS_FILE, JSON.stringify({
            workflowItemId: 123, storyNumber: 'B-123', currentPhase: 'validating',
            tasks: [{ id: 'T-001', name: 'Validate' }],
            lastValidationResult: 'passed',
        }, null, 2));
        let payload: Record<string, unknown> | null = null;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            payload = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }));
        await executeToolCall('complete_phase', { next_phase: 'committing', summary: 'done' }, TMP, TMP, 'frontend', resolve(TMP, '.sdlc-framework.config.json'));
        const outputs = (payload as unknown as { outputs: Record<string, unknown> }).outputs;
        expect(outputs.validationResults).toMatchObject({ passed: true, source: 'run_validation' });
    });

    it('reports passed:false when run_validation recorded a FAIL — never fabricates a pass', async () => {
        writeFileSync(STATUS_FILE, JSON.stringify({
            workflowItemId: 123, storyNumber: 'B-123', currentPhase: 'validating',
            tasks: [{ id: 'T-001', name: 'Validate' }],
            lastValidationResult: 'failed', lastValidationFailure: 'tsc: error TS2304',
        }, null, 2));
        let payload: Record<string, unknown> | null = null;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            payload = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }));
        await executeToolCall('complete_phase', { next_phase: 'committing', summary: 'done' }, TMP, TMP, 'frontend', resolve(TMP, '.sdlc-framework.config.json'));
        const outputs = (payload as unknown as { outputs: Record<string, unknown> }).outputs;
        expect(outputs.validationResults).toMatchObject({ passed: false });
        expect(JSON.stringify(outputs.validationResults)).toContain('TS2304');
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

describe('parseWorktreeAddPath', () => {
    it('extracts the .claude/worktrees target path', () => {
        expect(parseWorktreeAddPath('git worktree add -b feat/X .claude/worktrees/backend-LOCAL-B-0011 main'))
            .toBe('.claude/worktrees/backend-LOCAL-B-0011');
        expect(parseWorktreeAddPath('git -C /repo worktree add .claude/worktrees/backend-LOCAL-B-0011 feat/X'))
            .toBe('.claude/worktrees/backend-LOCAL-B-0011');
        expect(parseWorktreeAddPath('git worktree add -b feat/X "/repo/.claude/worktrees/backend-LOCAL-B-0011" main'))
            .toBe('/repo/.claude/worktrees/backend-LOCAL-B-0011');
    });

    it('returns null for non-worktree-add commands or missing path', () => {
        expect(parseWorktreeAddPath('git worktree list')).toBeNull();
        expect(parseWorktreeAddPath('git worktree add /tmp/elsewhere main')).toBeNull();
    });
});

describe('parseWorktreeAddBranch', () => {
    it('extracts -b and -B branch names', () => {
        expect(parseWorktreeAddBranch('git worktree add -b feature/LOCAL-B-0011 .claude/worktrees/backend-LOCAL-B-0011 main'))
            .toBe('feature/LOCAL-B-0011');
        expect(parseWorktreeAddBranch('git worktree add -B "feature/LOCAL-B-0011" .claude/worktrees/backend-LOCAL-B-0011 main'))
            .toBe('feature/LOCAL-B-0011');
    });

    it('returns null when no new branch is requested', () => {
        expect(parseWorktreeAddBranch('git worktree add .claude/worktrees/backend-LOCAL-B-0011 feature/LOCAL-B-0011'))
            .toBeNull();
    });
});

describe('parseWorktreeList', () => {
    it('parses porcelain blocks into {path, branch} records', () => {
        const porcelain = [
            'worktree /repo',
            'HEAD abc123',
            'branch refs/heads/main',
            '',
            'worktree /repo/.claude/worktrees/backend-LOCAL-B-0011',
            'HEAD def456',
            'branch refs/heads/feature/LOCAL-B-0011',
            '',
        ].join('\n');
        const out = parseWorktreeList(porcelain);
        expect(out).toEqual([
            { path: '/repo', branch: 'main' },
            { path: '/repo/.claude/worktrees/backend-LOCAL-B-0011', branch: 'feature/LOCAL-B-0011' },
        ]);
    });

    it('handles a detached worktree (no branch line)', () => {
        const out = parseWorktreeList('worktree /repo/wt\nHEAD abc123\ndetached\n');
        expect(out).toEqual([{ path: '/repo/wt', branch: null }]);
    });
});

describe('run_command worktree guard', () => {
    const GTMP = resolve(__dirname, '.agent-runner-git-tmp');
    const cfg = resolve(GTMP, '.sdlc-framework.config.json');

    const git = (args: string[]) => execFileSync('git', args, { cwd: GTMP, encoding: 'utf8' });

    beforeEach(() => {
        rmSync(GTMP, { recursive: true, force: true });
        mkdirSync(GTMP, { recursive: true });
        git(['init', '-b', 'main']);
        writeFileSync(resolve(GTMP, 'README.md'), 'test\n');
        git(['add', 'README.md']);
        git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '-m', 'init']);
        git(['worktree', 'add', '-b', 'feature/LOCAL-B-0011', '.claude/worktrees/backend-LOCAL-B-0011', 'main']);
    });

    afterEach(() => rmSync(GTMP, { recursive: true, force: true }));

    it('reuses an existing checked-out branch when git reports a branch-name collision', async () => {
        const out = await executeToolCall(
            'run_command',
            { command: `cd "${GTMP}" && git worktree add -b feature/LOCAL-B-0011 /tmp/not-the-intended-worktree main` },
            GTMP,
            GTMP,
            'backend',
            cfg,
        );

        expect(out).toContain('[worktree-guard]');
        expect(out).toContain('feature/LOCAL-B-0011');
        expect(out).toContain('.claude/worktrees/backend-LOCAL-B-0011');
        expect(out).toContain('reusing it');
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

describe('committing commit-gate (auto-commit worktree)', () => {
    const CTMP = resolve(__dirname, '.commit-gate-tmp');
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

    beforeEach(() => {
        rmSync(CTMP, { recursive: true, force: true });
        mkdirSync(CTMP, { recursive: true });
        // Base repo with one commit so worktrees can branch off it.
        git(CTMP, 'init', '-q');
        git(CTMP, 'config', 'user.email', 'test@test.dev');
        git(CTMP, 'config', 'user.name', 'Test');
        git(CTMP, 'config', 'commit.gpgsign', 'false');
        writeFileSync(resolve(CTMP, 'README.md'), '# base\n');
        git(CTMP, 'add', '-A');
        git(CTMP, 'commit', '-q', '-m', 'base');
        // Story worktree at the orchestrator's deterministic path.
        git(CTMP, 'worktree', 'add', '-q', '-b', 'fix/LOCAL-X', '.claude/worktrees/backend-LOCAL-X');
    });

    afterEach(() => rmSync(CTMP, { recursive: true, force: true }));

    it('finds the deterministic <agent>-<story> worktree', () => {
        const wt = findStoryWorktree(CTMP, 'backend', 'LOCAL-X');
        expect(wt).toBe(resolve(CTMP, '.claude', 'worktrees', 'backend-LOCAL-X'));
    });

    it('stages and commits real work with the framework message, then no-ops on a clean tree', () => {
        const wt = resolve(CTMP, '.claude', 'worktrees', 'backend-LOCAL-X');
        const headBefore = git(wt, 'rev-parse', 'HEAD').trim();
        writeFileSync(resolve(wt, 'feature.ts'), 'export const x = 1;\n');

        const first = autoCommitWorktree(CTMP, 'backend', 'LOCAL-X', 'LOCAL-X: add feature');
        expect(first).toMatchObject({ ok: true, committed: true });
        const headAfter = git(wt, 'rev-parse', 'HEAD').trim();
        expect(headAfter).not.toBe(headBefore); // HEAD advanced — work is in source control
        expect(git(wt, 'log', '-1', '--pretty=%s').trim()).toBe('LOCAL-X: add feature'); // framework message, not model summary
        expect(git(wt, 'status', '--porcelain').trim()).toBe(''); // nothing left uncommitted

        // Idempotent: a second call on a clean tree commits nothing.
        const second = autoCommitWorktree(CTMP, 'backend', 'LOCAL-X', 'LOCAL-X: add feature');
        expect(second).toMatchObject({ ok: true, committed: false });
        expect(second.note).toContain('already committed');
        expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(headAfter);
    });

    it('refuses to commit when only build/cache junk changed (no real work)', () => {
        const wt = resolve(CTMP, '.claude', 'worktrees', 'backend-LOCAL-X');
        const headBefore = git(wt, 'rev-parse', 'HEAD').trim();
        mkdirSync(resolve(wt, 'node_modules', '.vite'), { recursive: true });
        writeFileSync(resolve(wt, 'node_modules', '.vite', 'results.json'), '{"cache":1}\n');

        const r = autoCommitWorktree(CTMP, 'backend', 'LOCAL-X', 'LOCAL-X: nothing real');
        expect(r).toMatchObject({ ok: false, committed: false });
        expect(r.note).toContain('no real work');
        expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(headBefore); // no junk commit made
    });

    it('returns a no-op result when there is no worktree', () => {
        const r = autoCommitWorktree(resolve(CTMP, 'nope'), 'backend', 'MISSING', 'x');
        expect(r).toMatchObject({ ok: false, committed: false });
        expect(r.note).toContain('no worktree found');
    });
});

describe('framework-driven creating-pr (autoCreatePr)', () => {
    const PTMP = resolve(__dirname, '.auto-pr-tmp');
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
    const MOCK_CFG = resolve(PTMP, '.sdlc-framework.config.json');

    beforeEach(() => {
        rmSync(PTMP, { recursive: true, force: true });
        mkdirSync(PTMP, { recursive: true });
        git(PTMP, 'init', '-q');
        git(PTMP, 'config', 'user.email', 'test@test.dev');
        git(PTMP, 'config', 'user.name', 'Test');
        git(PTMP, 'config', 'commit.gpgsign', 'false');
        writeFileSync(resolve(PTMP, 'README.md'), '# base\n');
        git(PTMP, 'add', '-A');
        git(PTMP, 'commit', '-q', '-m', 'base');
        git(PTMP, 'worktree', 'add', '-q', '-b', 'fix/LOCAL-P', '.claude/worktrees/backend-LOCAL-P');
        // Mock external mode → autoCreatePr must never touch a real remote.
        writeFileSync(MOCK_CFG, JSON.stringify({ externalMode: 'mock' }));
    });

    afterEach(() => rmSync(PTMP, { recursive: true, force: true }));

    it('synthesizes a deterministic mockPr in mock mode without touching a remote', () => {
        const r = autoCreatePr(PTMP, 'backend', 'LOCAL-P', 'add feature', 'body', MOCK_CFG);
        expect(r.ok).toBe(true);
        expect(r.pr).toBeUndefined();
        expect(r.mockPr).toMatchObject({ branch: 'fix/LOCAL-P', mock: true, state: 'open' });
        expect(r.handoff).toContain('mock PR');
    });

    it('reports a no-op when there is no worktree', () => {
        const r = autoCreatePr(resolve(PTMP, 'nope'), 'backend', 'MISSING', 't', 'b', MOCK_CFG);
        expect(r.ok).toBe(false);
        expect(r.note).toContain('no worktree found');
    });
});

describe('plumbing protection (write_file cannot modify the framework)', () => {
    const WS = resolve(__dirname, '.plumbing-ws');   // target workspace (e.g. flowboard)
    const FW = resolve(__dirname, '.plumbing-fw');    // framework dir (generic-sdlc)
    const cfg = resolve(WS, '.sdlc-framework.config.json');

    beforeEach(() => { for (const d of [WS, FW]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); } });
    afterEach(() => { for (const d of [WS, FW]) rmSync(d, { recursive: true, force: true }); });

    it('allows writing inside the target workspace', async () => {
        const out = await executeToolCall('write_file', { path: 'src/app.ts', content: 'export const x = 1;' }, WS, FW, 'backend', cfg);
        expect(out).toContain('Written');
    });

    it('blocks writing into the framework when it differs from the workspace', async () => {
        const out = await executeToolCall('write_file', { path: resolve(FW, 'src/server/agent-runner/tools.ts'), content: 'hacked' }, WS, FW, 'backend', cfg);
        expect(out).toContain('not allowed');
        expect(out).toContain('may not modify their own tooling');
    });

    it('allows framework writes during self-development (workspace === framework)', async () => {
        const out = await executeToolCall('write_file', { path: 'src/server/x.ts', content: 'ok' }, FW, FW, 'backend', cfg);
        expect(out).toContain('Written');
    });
});

describe('edit_file tool (targeted replace for small models)', () => {
    const ETMP = resolve(__dirname, '.edit-file-tmp');
    const FW = resolve(__dirname, '.edit-file-fw');
    const cfg = resolve(ETMP, '.sdlc-framework.config.json');

    beforeEach(() => { for (const d of [ETMP, FW]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); } });
    afterEach(() => { for (const d of [ETMP, FW]) rmSync(d, { recursive: true, force: true }); });

    it('replaces an exact unique snippet and reports an Edited result (counts as a mutation)', async () => {
        writeFileSync(resolve(ETMP, 'App.tsx'), "<div style={{ background: '#0a0e17' }}>hi</div>\n");
        const out = await executeToolCall('edit_file',
            { path: 'App.tsx', old_string: "background: '#0a0e17'", new_string: "background: '#22c55e'" },
            ETMP, FW, 'frontend', cfg);
        expect(out).toMatch(/^Edited /); // AgentRunner counts this as a mutation
        expect(readFileSync(resolve(ETMP, 'App.tsx'), 'utf8')).toContain("background: '#22c55e'");
    });

    it('errors when old_string is not found', async () => {
        writeFileSync(resolve(ETMP, 'a.ts'), 'const x = 1;\n');
        const out = await executeToolCall('edit_file', { path: 'a.ts', old_string: 'const y', new_string: 'const z' }, ETMP, FW, 'frontend', cfg);
        expect(out).toContain('not found');
    });

    it('errors when old_string is not unique', async () => {
        writeFileSync(resolve(ETMP, 'a.ts'), 'x\nx\n');
        const out = await executeToolCall('edit_file', { path: 'a.ts', old_string: 'x', new_string: 'y' }, ETMP, FW, 'frontend', cfg);
        expect(out).toContain('multiple times');
    });

    it('errors when the file does not exist', async () => {
        const out = await executeToolCall('edit_file', { path: 'missing.ts', old_string: 'a', new_string: 'b' }, ETMP, FW, 'frontend', cfg);
        expect(out).toContain('file not found');
    });

    it('is blocked by plumbing protection from editing the framework', async () => {
        mkdirSync(resolve(FW, 'src'), { recursive: true });
        writeFileSync(resolve(FW, 'src', 'tools.ts'), 'export const real = 1;\n');
        const out = await executeToolCall('edit_file',
            { path: resolve(FW, 'src', 'tools.ts'), old_string: 'real = 1', new_string: 'real = 2' },
            ETMP, FW, 'frontend', cfg);
        expect(out).toContain('not allowed');
    });
});
