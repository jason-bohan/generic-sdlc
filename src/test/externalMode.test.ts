import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { getExternalMode, isMockExternalMode } from '../server/external-mode';
import { mockAdoFetch, mockV1Fetch, mockV1Http, mockV1Post } from '../server/mock-external';
import { getMockModeSafetyDirective, hasLiveAdoCredentialsInMockMode, isAzureDevOpsUrl } from '../server/test-safety';

const TMP = resolve(__dirname, '.external-mode-test-tmp');
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    delete process.env.SDLC_EXTERNAL_MODE;
});

afterEach(() => {
    delete process.env.SDLC_EXTERNAL_MODE;
    rmSync(TMP, { recursive: true, force: true });
});

describe('external mode', () => {
    it('defaults to live mode', () => {
        expect(getExternalMode(CONFIG)).toBe('live');
    });

    it('reads mock mode from config', () => {
        writeFileSync(CONFIG, JSON.stringify({ externalMode: 'mock' }));
        expect(getExternalMode(CONFIG)).toBe('mock');
        expect(isMockExternalMode(CONFIG)).toBe(true);
    });

    it('lets the env var override config', () => {
        writeFileSync(CONFIG, JSON.stringify({ externalMode: 'live' }));
        process.env.SDLC_EXTERNAL_MODE = 'mock';
        expect(getExternalMode(CONFIG)).toBe('mock');
    });

    it('emits a mock-mode safety directive that forbids live ADO writes', () => {
        writeFileSync(CONFIG, JSON.stringify({ externalMode: 'mock' }));
        const directive = getMockModeSafetyDirective(CONFIG);
        expect(directive).toContain('MOCK EXTERNAL MODE IS ACTIVE');
        expect(directive).toContain('do not call Azure DevOps MCP tools');
        expect(directive).toContain('do not run git push');
    });

    it('recognizes Azure DevOps URLs as live PR URLs', () => {
        expect(isAzureDevOpsUrl('https://dev.azure.com/org/project/_git/repo/pullrequest/1')).toBe(true);
        expect(isAzureDevOpsUrl('https://oursundayvisitor.visualstudio.com/YourProject/_git/YourProject/pullrequest/1')).toBe(true);
        expect(isAzureDevOpsUrl('mock://ado/pr/1')).toBe(false);
        expect(isAzureDevOpsUrl('https://example.com/pr/1')).toBe(false);
    });

    it('detects live ADO credentials while mock mode is active', () => {
        writeFileSync(CONFIG, JSON.stringify({ externalMode: 'mock' }));
        process.env.AZURE_DEVOPS_PAT = 'live-token';
        expect(hasLiveAdoCredentialsInMockMode(CONFIG)).toBe(true);
        delete process.env.AZURE_DEVOPS_PAT;

        writeFileSync(CONFIG, JSON.stringify({
            externalMode: 'mock',
            scheduler: { agents: { devops: { adoPat: 'agent-token' } } },
        }));
        expect(hasLiveAdoCredentialsInMockMode(CONFIG)).toBe(true);
    });
});

describe('mock external services', () => {
    it('returns fixture stories and creates local tasks without network calls', () => {
        const stories = mockV1Fetch(TMP, '/Story', { where: "Number='B-17001'" }) as any;
        expect(stories.Assets).toHaveLength(1);
        const parent = stories.Assets[0].id;

        const created = mockV1Post(TMP, '/Task', {
            Attributes: {
                Name: { value: 'Plan local workflow' },
                Parent: { value: parent },
                DetailEstimate: { value: 2 },
            },
        }) as any;
        expect(created.Attributes.Number.value).toMatch(/^TK-LOCAL-/);

        const tasks = mockV1Fetch(TMP, '/Task', { where: `Parent='${parent}'` }) as any;
        expect(tasks.Assets).toHaveLength(1);
        expect(tasks.Assets[0].Attributes.Name.value).toBe('Plan local workflow');
    });

    it('creates local Azure DevOps PR and pipeline records', () => {
        const pr = mockAdoFetch(TMP, '/git/repositories/repo/pullrequests?api-version=7.1', 'POST', {
            title: 'Mock PR',
            sourceRefName: 'refs/heads/feat/mock',
        }) as any;
        expect(pr.pullRequestId).toBeGreaterThan(5000);

        const run = mockAdoFetch(TMP, '/pipelines/646/runs?api-version=7.1', 'POST', {}) as any;
        expect(run.status).toBe('completed');
        expect(run.result).toBe('succeeded');
    });

    it('serves VersionOne-style paths used by the Agility MCP', () => {
        const story = mockV1Http(TMP, 'GET', '/Story', {
            where: "Number='B-17001'",
            sel: 'Name,Number',
        }) as any;
        expect(story.Assets[0].Attributes.Number.value).toBe('B-17001');

        const parent = story.Assets[0].id;
        const task = mockV1Http(TMP, 'POST', '/Task', {}, {
            Attributes: {
                Name: { value: 'MCP-created local task' },
                Parent: { value: parent },
                DetailEstimate: { value: 1 },
                ToDo: { value: 1 },
            },
        }) as any;
        expect(task.id).toMatch(/^Task:/);

        const taskNumber = mockV1Http(TMP, 'GET', `/Task/${task.id.split(':')[1]}`, { sel: 'Number' }) as any;
        expect(taskNumber.Attributes.Number.value).toMatch(/^TK-LOCAL-/);

        const updated = mockV1Http(TMP, 'POST', `/Task/${task.id.split(':')[1]}`, {}, {
            Attributes: {
                Status: { value: 'TaskStatus:123' },
                ToDo: { value: 0 },
            },
        }) as any;
        expect(updated.Attributes['Status.Name'].value).toBe('TaskStatus:123');
        expect(updated.Attributes.ToDo.value).toBe(0);
    });

    it('persists mock Agility state to .sdlc-framework/mock/state.json and reloads on subsequent API reads', () => {
        const stateFile = resolve(TMP, '.sdlc-framework', 'mock', 'state.json');
        mockV1Post(TMP, '/Task', {
            Attributes: {
                Name: { value: 'Persistence check task' },
                Parent: { value: 'Story:17001' },
                DetailEstimate: { value: 1 },
            },
        });
        expect(existsSync(stateFile)).toBe(true);
        const disk = JSON.parse(readFileSync(stateFile, 'utf-8'));
        expect(disk.tasks.some((t: { name: string }) => t.name === 'Persistence check task')).toBe(true);

        const tasks = mockV1Fetch(TMP, '/Task', { where: "Parent='Story:17001'" }) as any;
        expect(tasks.Assets.some((a: any) => a.Attributes.Name.value === 'Persistence check task')).toBe(true);
    });
});
