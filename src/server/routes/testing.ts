import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { spawn as cpSpawn, type ChildProcess } from 'child_process';
import http from 'node:http';
import {
    dbAddMessage,
    dbAddTestRun,
    dbGetTestRuns,
    dbGetLatestTestRun,
    dbGetTestSummary,
} from '../db';
import { setTestRunnerActive } from '../spawn-agent';
import { readBody, json, cors } from '../router';
import { resetMockState } from '../mock-external';
import type { UseFn } from './types';

const TESTID_KEYWORD_MAP: Array<{ keywords: string[]; hint: string }> = [
    { keywords: ['step mode', 'step-mode', 'pause', 'checkpoint'], hint: '[data-testid="simple-global-step-toggle-btn"]' },
    { keywords: ['chat', '/btw', 'message'], hint: '[data-testid="simple-agent-chat-{agent}"]' },
    { keywords: ['pick up', 'assign', 'story picker'], hint: '[data-testid="simple-agent-assign-{agent}"]' },
    { keywords: ['approve', 'approval'], hint: '[data-testid="simple-agent-approve-{agent}"]' },
    { keywords: ['model', 'model picker'], hint: '[data-testid="simple-agent-model-{agent}"]' },
    { keywords: ['open desk', 'agent desk', 'detail'], hint: '[data-testid="simple-agent-open-{agent}"]' },
    { keywords: ['card', 'agent card'], hint: '[data-testid="simple-agent-card-{agent}"]' },
    { keywords: ['paused', 'paused badge'], hint: '[data-testid="paused-badge-{agent}"]' },
    { keywords: ['stopped', 'resume', 'terminated'], hint: '[data-testid="stopped-badge-{agent}"]' },
    { keywords: ['task', 'task list'], hint: '[data-testid="{agent}-task-list"]' },
    { keywords: ['create pr', 'pull request'], hint: '[data-testid="{agent}-action-create-pr"]' },
    { keywords: ['review', 'feedback'], hint: '[data-testid="{agent}-action-address-feedback"]' },
    { keywords: ['notification'], hint: '[data-testid="simple-notifications-btn"]' },
    { keywords: ['create story'], hint: '[data-testid="simple-create-story-btn"]' },
    { keywords: ['theme', 'dark mode', 'light mode'], hint: '[data-testid="simple-theme-toggle-btn"]' },
    { keywords: ['refresh'], hint: '[data-testid="simple-refresh-btn"]' },
    { keywords: ['test runner'], hint: '[data-testid="simple-test-runner-btn"]' },
    { keywords: ['qa result', 'test result', 'test pass', 'test fail'], hint: '[data-testid="qa-results-qa"]' },
];

function inferTestidHint(acText: string, agentId: string, _featureArea?: string): string | null {
    const lower = acText.toLowerCase();
    for (const entry of TESTID_KEYWORD_MAP) {
        if (entry.keywords.some(kw => lower.includes(kw))) {
            return entry.hint.replace(/\{agent\}/g, agentId);
        }
    }
    return null;
}

const TEST_SCENARIOS: Record<string, { name: string; script: string; args: string[]; description: string; suppressSpawns: boolean }> = {
    pipeline: { name: 'Pipeline Smoke Test', script: 'bin/test-sdlc-pipeline.ps1', args: [], description: 'Validates all handoff endpoints and status transitions', suppressSpawns: true },
    fullstack: { name: 'Full-Stack Story', script: 'bin/test-fullstack-e2e.ps1', args: ['-SkipAgentSpawn', '-SkipCypress'], description: 'Frontend + backend split a story, reviewer + devops pipeline', suppressSpawns: true },
    // 'fullstack-live': { name: 'Full-Stack (Live Agents)', script: 'bin/test-fullstack-e2e.ps1', args: [], description: 'Same but with real agent spawns and Cypress', suppressSpawns: false },
    'design-first': { name: 'Design-First Story', script: 'bin/test-design-first-e2e.ps1', args: ['-SkipAgentSpawn', '-SkipCypress'], description: 'UX designs, hands off to frontend + backend, parallel review', suppressSpawns: true },
};

let activeTestRunner: { pid: number; scenarioId: string; logFile: string; startedAt: string; process: ChildProcess } | null = null;
let lastTestLogFile: string | null = null;

function streamLog(res: http.ServerResponse, logPath: string) {
    if (!existsSync(logPath)) { json(res, { error: 'Log file not found' }, 404); return; }
    try {
        const stat = statSync(logPath);
        const MAX_TAIL = 64 * 1024;
        if (stat.size <= MAX_TAIL) {
            const content = readFileSync(logPath, 'utf-8');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(content);
        } else {
            const content = readFileSync(logPath, 'utf-8');
            const tail = content.slice(-MAX_TAIL);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(`... (truncated, showing last ${MAX_TAIL} bytes) ...\n${tail}`);
        }
    } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
}

export function mount(use: UseFn, rootDir: string, _configFile: string): void {
    // ── /api/test-results ────────────────────────────────────────────────────
    use('/api/test-results', async (req, res) => {
        cors(res, 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

        if (req.method === 'GET') {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const agentId = url.searchParams.get('agentId') || undefined;
            if (url.searchParams.has('summary')) {
                json(res, dbGetTestSummary());
            } else if (url.searchParams.has('latest') && agentId) {
                const latest = dbGetLatestTestRun(agentId);
                json(res, latest ?? { empty: true });
            } else {
                json(res, { runs: dbGetTestRuns(agentId) });
            }
            return;
        }

        if (req.method === 'POST') {
            const body = await readBody(req);
            try {
                const { agentId, specFile, passed, failed, skipped, durationMs, failures } = JSON.parse(body);
                if (!agentId || !specFile) { json(res, { error: 'agentId and specFile required' }, 400); return; }
                const failureList: Array<{ test: string; error: string; spec: string }> = Array.isArray(failures) ? failures : [];
                const id = dbAddTestRun({
                    agentId,
                    specFile,
                    passed: passed ?? 0,
                    failed: failed ?? 0,
                    skipped: skipped ?? 0,
                    durationMs: durationMs ?? 0,
                    failures: failureList,
                });
                console.log(`[test-results] ${agentId}: ${specFile} — ${passed ?? 0} passed, ${failed ?? 0} failed`);

                // Auto-notify dev agents on failures
                if (failureList.length > 0) {
                    const targetAgent = specFile.includes('api') ? 'backend' : 'frontend';
                    const summary = failureList.slice(0, 3).map(f => `- ${f.test}: ${f.error}`).join('\n');
                    const msg = `[QA] ${failureList.length} test(s) failed in ${specFile}:\n${summary}${failureList.length > 3 ? `\n... +${failureList.length - 3} more` : ''}`;
                    const msgId = `qa-failure-notify-${Date.now()}`;
                    dbAddMessage(targetAgent, { id: msgId, from: 'qa', message: msg, timestamp: new Date().toISOString() });
                    console.log(`[test-results] Notified ${targetAgent} of ${failureList.length} failure(s)`);
                }

                json(res, { ok: true, runId: id });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
            return;
        }

        res.statusCode = 405; res.end('Method not allowed');
    });

    // ── /api/test-spec/generate — generate Cypress spec from story AC ────────
    use('/api/test-spec/generate', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }

        const body = await readBody(req);
        try {
            const { storyNumber: rawNumber, storyName, acceptanceCriteria, agentId, featureArea } = JSON.parse(body);
            if (!rawNumber) { json(res, { error: 'storyNumber required' }, 400); return; }

            const storyNumber = String(rawNumber).replace(/^B-/i, '');
            const acList: string[] = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
            const specPath = `cypress/e2e/stories/B-${storyNumber}.cy.ts`;
            const specFullPath = resolve(rootDir, specPath);

            if (existsSync(specFullPath)) {
                json(res, { ok: true, specPath, testCount: 0, skipped: true, reason: 'Spec already exists' });
                return;
            }

            const effectiveAgent = agentId || 'frontend';
            const sanitizeName = (s: string) => s.replace(/'/g, "\\'").replace(/\\/g, '\\\\');

            const tests = acList.map((ac: string, i: number) => {
                const sanitized = sanitizeName(ac);
                const hint = inferTestidHint(ac, effectiveAgent, featureArea);
                const bodyLines = hint
                    ? [`        cy.get('${hint}').should('be.visible');`]
                    : [`        cy.get('body').should('be.visible');`];
                return `    it('AC${i + 1}: ${sanitized}', () => {\n${bodyLines.join('\n')}\n    });`;
            });

            const specContent = [
                `// Auto-generated from story B-${storyNumber} acceptance criteria`,
                `// cypress/support/e2e.ts handles cy.visit('/') and theme setup`,
                `// Custom commands available: cy.seedAgent(), cy.resetAgent(), cy.openDesk()`,
                ``,
                `const API = Cypress.env('apiUrl') || 'http://localhost:3001';`,
                ``,
                `describe('B-${storyNumber}: ${sanitizeName(storyName || 'Story')}', () => {`,
                `    afterEach(() => {`,
                `        cy.resetAgent('${effectiveAgent}');`,
                `    });`,
                ``,
                tests.length > 0 ? tests.join('\n\n') : `    it('has acceptance criteria to test', () => {\n        cy.get('body').should('be.visible');\n    });`,
                `});`,
                ``,
            ].join('\n');

            const specDir = resolve(rootDir, 'cypress/e2e/stories');
            if (!existsSync(specDir)) mkdirSync(specDir, { recursive: true });
            writeFileSync(specFullPath, specContent);

            console.log(`[test-spec] Generated ${specPath} with ${acList.length} AC tests`);
            json(res, { ok: true, specPath, testCount: Math.max(acList.length, 1) });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── Test Runner ────────────────────────────────────────────────────────

    use('/api/test-runner/scenarios', (_req, res) => {
        cors(res);
        const scenarios = Object.entries(TEST_SCENARIOS).map(([id, s]) => ({ id, name: s.name, description: s.description }));
        json(res, { scenarios });
    });

    use('/api/test-runner/run', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        if (activeTestRunner && activeTestRunner.process && !activeTestRunner.process.killed) {
            json(res, { error: 'A test is already running', scenarioId: activeTestRunner.scenarioId, pid: activeTestRunner.pid }, 409);
            return;
        }
        const body = await readBody(req);
        try {
            const { scenarioId } = JSON.parse(body);
            const scenario = TEST_SCENARIOS[scenarioId];
            if (!scenario) { json(res, { error: `Unknown scenario: ${scenarioId}` }, 400); return; }
            const outputDir = resolve(rootDir, '.agent-output');
            if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logFile = resolve(outputDir, `test-runner-${scenarioId}-${timestamp}.log`);
            const scriptPath = resolve(rootDir, scenario.script);
            const isWin = process.platform === 'win32';
            const shell = isWin ? 'powershell' : 'pwsh';
            const shellArgs = isWin
                ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...scenario.args]
                : ['-NoProfile', '-File', scriptPath, ...scenario.args];
            const child = cpSpawn(shell, shellArgs, {
                cwd: rootDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                ...(isWin ? { windowsHide: true } : {}),
            });
            const logStream = createWriteStream(logFile);
            child.stdout?.pipe(logStream);
            child.stderr?.pipe(logStream);
            child.on('error', (err) => {
                logStream.write(`\n--- Spawn error: ${err.message} ---\n`);
                logStream.end();
                if (scenario.suppressSpawns) setTestRunnerActive(false);
                if (activeTestRunner?.logFile === logFile) {
                    lastTestLogFile = logFile;
                    activeTestRunner = null;
                }
            });
            activeTestRunner = { pid: child.pid || 0, scenarioId, logFile, startedAt: new Date().toISOString(), process: child };
            if (scenario.suppressSpawns) setTestRunnerActive(true);
            child.on('close', (code) => {
                logStream.write(`\n--- Test finished with exit code ${code} ---\n`);
                logStream.end();
                if (scenario.suppressSpawns) setTestRunnerActive(false);
                if (activeTestRunner?.pid === child.pid) {
                    lastTestLogFile = logFile;
                    activeTestRunner = null;
                }
            });
            console.log(`[test-runner] Started ${scenarioId} via ${shell} (PID ${child.pid}), log: ${logFile}`);
            json(res, { ok: true, logFile, pid: child.pid });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    use('/api/test-runner/status', (_req, res) => {
        cors(res);
        if (activeTestRunner) {
            const elapsed = Date.now() - new Date(activeTestRunner.startedAt).getTime();
            json(res, { running: true, scenarioId: activeTestRunner.scenarioId, pid: activeTestRunner.pid, logFile: activeTestRunner.logFile, elapsedMs: elapsed });
        } else {
            json(res, { running: false, lastLogFile: lastTestLogFile });
        }
    });

    use('/api/test-runner/log', (req, res) => {
        cors(res);
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const file = url.searchParams.get('file');
        if (!file) {
            const logPath = activeTestRunner?.logFile ?? lastTestLogFile;
            if (logPath) {
                return streamLog(res, logPath);
            }
            json(res, { error: 'No file param and no active test' }, 400);
            return;
        }
        streamLog(res, file);
    });

    use('/api/test-runner/stop', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        if (!activeTestRunner) { json(res, { error: 'No test running' }, 404); return; }
        try {
            activeTestRunner.process.kill();
            setTestRunnerActive(false);
            const scenarioId = activeTestRunner.scenarioId;
            activeTestRunner = null;
            json(res, { ok: true, stopped: scenarioId });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/mock/reset ───────────────────────────────────────────────────
    use('/api/mock/reset', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        try {
            resetMockState(rootDir);
            json(res, { ok: true, message: 'Mock state reset to defaults (PRs, builds, notifications cleared)' });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });
}
