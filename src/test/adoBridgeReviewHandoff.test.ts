import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { closeDb, initDb } from '../server/db';
import { handleReviewerChangesRequested, startAdoBridge, stopAdoBridge } from '../server/ado-bridge';
import { setTestRunnerActive } from '../server/spawn-agent';

const TMP = resolve(__dirname, '.ado-bridge-review-handoff-tmp');

let server: Server | null = null;
let previousPort: string | undefined;

function writeJson(path: string, value: unknown) {
    writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path: string) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

async function startServer() {
    server = http.createServer(createApp(TMP));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const address = server.address() as AddressInfo;
    process.env.SDLC_API_PORT = String(address.port);
}

async function stopServer() {
    if (!server) return;
    await new Promise<void>((r, j) => server!.close((err) => (err ? j(err) : r())));
    server = null;
}

beforeEach(async () => {
    setTestRunnerActive(true);
    closeDb();
    stopAdoBridge();
    previousPort = process.env.SDLC_API_PORT;
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    delete process.env.SDLC_EXTERNAL_MODE;

    writeJson(resolve(TMP, '.sdlc-framework.config.json'), {
        externalMode: 'mock',
        activeProject: 'YourProject',
        projects: {
            YourProject: {
                organization: 'mock-org',
                azureProject: 'YourProject',
                repositoryId: 'mock-repo',
                targetBranch: 'master',
                pipelineId: 646,
                reviewerIds: ['mock-reviewer'],
                prUrlBase: 'mock://ado/pr',
                workspacePath: TMP,
            },
        },
        scheduler: {
            mode: 'notify',
            agents: {
                frontend: { enabled: true, autoStart: false, stepMode: true },
                reviewer: { enabled: true, autoStart: false, stepMode: false },
            },
        },
    });

    writeJson(resolve(TMP, '.frontend-status.json'), {
        storyNumber: 'B-17003',
        storyName: 'Implement dark mode',
        currentPhase: 'watching-reviews',
        tasks: [],
        prs: [{ id: 42, title: 'PR #42', status: 'active', comments: 0, approvals: 0 }],
        events: [],
    });
    writeJson(resolve(TMP, '.reviewer-status.json'), {
        currentPhase: 'pending-review',
        assignedPR: { id: 42, storyNumber: 'B-17003', branch: 'feature/B-17003-dark-mode', projectKey: 'YourProject' },
        events: [],
    });
    writeJson(resolve(TMP, '.reviewer-comments.json'), {
        prId: 42,
        threads: [
            { id: '1', file: 'src/Dashboard.tsx', line: 27, comment: 'Handle missing preference before reading theme.', severity: 'warning' },
        ],
    });

    initDb(TMP);
    await startServer();
    startAdoBridge({
        workspaceDir: TMP,
        organization: 'mock-org',
        azureProject: 'YourProject',
        repositoryId: 'mock-repo',
        prUrlBase: 'mock://ado/pr',
        reviewerIds: ['mock-reviewer'],
        pat: '',
    });
});

afterEach(async () => {
    stopAdoBridge();
    await stopServer();
    closeDb();
    setTestRunnerActive(false);
    if (previousPort === undefined) delete process.env.SDLC_API_PORT;
    else process.env.SDLC_API_PORT = previousPort;
    rmSync(TMP, { recursive: true, force: true });
});

describe('ADO bridge reviewer handoff', () => {
    it('posts changes-requested reviewer comments through the handoff endpoint', async () => {
        writeJson(resolve(TMP, '.reviewer-status.json'), {
            currentPhase: 'changes-requested',
            assignedPR: { id: 42, storyNumber: 'B-17003', branch: 'feature/B-17003-dark-mode', projectKey: 'YourProject' },
            events: [],
        });
        await handleReviewerChangesRequested(readJson(resolve(TMP, '.reviewer-status.json')));

        const frontend = readJson(resolve(TMP, '.frontend-status.json'));
        expect(frontend.currentPhase).toBe('addressing-feedback');
        expect(frontend.requests).toHaveLength(1);
        expect(frontend.requests[0]).toMatchObject({
            id: 'REQ-1',
            type: 'review',
            source: 'reviewer',
            summary: 'Handle missing preference before reading theme.',
            file: 'src/Dashboard.tsx',
            status: 'open',
            prId: 42,
        });

        const reviewer = readJson(resolve(TMP, '.reviewer-status.json'));
        expect(reviewer.handoffDispatched).toBe(true);
    });
});
