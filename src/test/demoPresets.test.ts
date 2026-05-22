import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { MockDataGenerator } from '../server/demo-presets';
import { MockProjectTracker } from '../server/providers/mock';

const roots: string[] = [];

function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-demo-presets-'));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('demo presets', () => {
    it('loads named presets from data/presets and normalizes work items', () => {
        const root = tempRoot();
        mkdirSync(join(root, 'data', 'presets'), { recursive: true });
        writeFileSync(join(root, 'data', 'presets', 'startup-jira.json'), JSON.stringify({
            name: 'startup-jira',
            teams: [{ id: 'startup', name: 'Startup' }],
            workItems: [{
                number: 'DEMO-1',
                title: 'Import tickets',
                status: 'Ready',
                lanes: { backend: 'Map ticket fields.' },
            }],
        }));

        const preset = new MockDataGenerator().load(root, 'startup-jira');

        expect(preset.teams).toEqual([{ id: 'startup', name: 'Startup' }]);
        expect(preset.workItems).toMatchObject([{
            id: 'preset-DEMO-1',
            number: 'DEMO-1',
            title: 'Import tickets',
            status: 'Ready',
            type: 'story',
            source: 'mock',
            lanes: { backend: 'Map ticket fields.' },
        }]);
    });

    it('seeds the mock tracker from the selected preset', async () => {
        const root = tempRoot();
        mkdirSync(join(root, 'data', 'presets'), { recursive: true });
        writeFileSync(join(root, 'data', 'presets', 'enterprise-agility.json'), JSON.stringify({
            name: 'enterprise-agility',
            teams: [{ id: 'platform', name: 'Platform' }],
            workItems: [{
                id: 'story-1',
                number: 'ENT-1001',
                title: 'Golden path story',
                description: 'Demo story',
                status: 'Backlog',
                type: 'feature',
                team: 'Platform',
                teamId: 'platform',
                estimate: 13,
            }],
        }));

        const tracker = new MockProjectTracker(root, 'enterprise-agility');

        await expect(tracker.getTeams()).resolves.toEqual([{ id: 'platform', name: 'Platform' }]);
        await expect(tracker.getStories()).resolves.toMatchObject([{
            id: 'story-1',
            number: 'ENT-1001',
            title: 'Golden path story',
            status: 'Backlog',
            team: 'Platform',
            teamId: 'platform',
            estimate: 13,
            source: 'mock',
        }]);
        await expect(tracker.getWorkItem('ENT-1001')).resolves.toMatchObject({
            id: 'story-1',
            number: 'ENT-1001',
            type: 'feature',
        });
    });
});
