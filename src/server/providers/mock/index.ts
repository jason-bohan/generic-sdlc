import type { IProjectTracker, FetchStoriesOptions } from '../IProjectTracker';
import type { ICodeReview, CreatePROptions } from '../ICodeReview';
import type { INotifications } from '../INotifications';
import type { Team, WorkItem, WorkItemSummary, PREvent, NotificationPayload } from '../types';
import { MockDataGenerator } from '../../demo-presets';

const MOCK_TEAMS: Team[] = [
    { id: 'team-1', name: 'Alpha' },
    { id: 'team-2', name: 'Beta' },
    { id: 'team-3', name: 'Platform' },
];

const MOCK_ITEMS: WorkItem[] = [
    {
        id: 'item-1001', number: 'WI-1001', title: 'Add pagination to data table',
        description: '<p>The data table loads all records. Add server-side pagination.</p>',
        status: 'Ready', type: 'story', teamId: 'team-1', team: 'Alpha',
        estimate: 5, priority: 'High', classOfService: 'Standard',
        acceptanceCriteria: '<ul><li>25 records/page default</li><li>Page size selector</li></ul>',
        lanes: {
            frontend: 'Add paginator component below table.',
            backend: 'Add page/size query params. Return total count in headers.',
            qa: 'Test with 1000+ records.',
        },
        source: 'mock',
    },
    {
        id: 'item-1002', number: 'WI-1002', title: 'Fix environment selector not persisting',
        description: '<p>Selected environment lost on page refresh. Persist in localStorage.</p>',
        status: 'Ready', type: 'story', teamId: 'team-2', team: 'Beta',
        estimate: 2, priority: 'Medium', classOfService: 'Standard',
        lanes: { frontend: 'Read/write to localStorage.', backend: 'N/A', qa: 'Verify on refresh.' },
        source: 'mock',
    },
    {
        id: 'item-1003', number: 'WI-1003', title: 'Implement dark mode toggle',
        description: '<p>Add dark mode to the admin dashboard using CSS custom properties.</p>',
        status: 'Ready', type: 'story', teamId: 'team-1', team: 'Alpha',
        estimate: 8, priority: 'Medium', classOfService: 'Standard',
        lanes: {
            frontend: 'Create theme service with CSS custom properties.',
            backend: 'Add theme_preference to user settings.',
            qa: 'Test WCAG AA contrast in both modes.',
        },
        source: 'mock',
    },
    {
        id: 'item-1004', number: 'WI-1004', title: 'Add bulk actions to content manager',
        description: '<p>Select multiple items and apply publish/archive/delete in bulk.</p>',
        status: 'In Progress', type: 'story', teamId: 'team-3', team: 'Platform',
        estimate: 5, priority: 'High', classOfService: 'Expedite',
        source: 'mock',
    },
];

export class MockProjectTracker implements IProjectTracker {
    readonly providerName = 'mock';
    private readonly teams: Team[];
    private items: WorkItem[];

    constructor(rootDir = process.cwd(), presetName = process.env.DEMO_PRESET) {
        if (presetName) {
            const preset = new MockDataGenerator().load(rootDir, presetName);
            this.teams = preset.teams?.map(team => ({ ...team })) ?? MOCK_TEAMS.map(team => ({ ...team }));
            this.items = preset.workItems.map(item => ({ ...item, lanes: item.lanes ? { ...item.lanes } : undefined }));
            return;
        }
        this.teams = MOCK_TEAMS.map(team => ({ ...team }));
        this.items = MOCK_ITEMS.map(item => ({ ...item, lanes: item.lanes ? { ...item.lanes } : undefined }));
    }

    async getTeams(): Promise<Team[]> {
        return this.teams.map(team => ({ ...team }));
    }

    async getStories(opts: FetchStoriesOptions = {}): Promise<WorkItemSummary[]> {
        let results = this.items;
        if (opts.team) results = results.filter(i => i.team === opts.team || i.teamId === opts.team);
        if (opts.status) results = results.filter(i => i.status === opts.status);
        if (opts.text) {
            const q = opts.text.toLowerCase();
            results = results.filter(i => i.title.toLowerCase().includes(q) || i.number.toLowerCase().includes(q));
        }
        return results.slice(0, opts.maxResults ?? 20).map(({ id, number, title, status, team, teamId, estimate, priority, source }) =>
            ({ id, number, title, status, team, teamId, estimate, priority, source }));
    }

    async getWorkItem(numberOrId: string): Promise<WorkItem | null> {
        return this.items.find(i => i.number === numberOrId || i.id === numberOrId) ?? null;
    }

    async updateStatus(numberOrId: string, status: string): Promise<boolean> {
        const item = this.items.find(i => i.number === numberOrId || i.id === numberOrId);
        if (!item) return false;
        item.status = status;
        return true;
    }

    async createWorkItem(fields: Partial<WorkItem>): Promise<WorkItem> {
        const item: WorkItem = {
            id: `item-${Date.now()}`,
            number: `WI-${1000 + this.items.length + 1}`,
            title: fields.title ?? 'Untitled',
            description: fields.description ?? '',
            status: fields.status ?? 'Backlog',
            type: fields.type ?? 'story',
            team: fields.team,
            teamId: fields.teamId,
            estimate: fields.estimate,
            priority: fields.priority,
            source: 'mock',
        };
        this.items.push(item);
        return item;
    }
}

export class MockCodeReview implements ICodeReview {
    readonly providerName = 'mock';

    async createPR(opts: CreatePROptions): Promise<PREvent> {
        return {
            prId: `mock-pr-${Date.now()}`,
            title: opts.title,
            url: `https://example.com/pr/mock`,
            status: 'open',
            buildStatus: 'pending',
            branch: opts.sourceBranch,
        };
    }

    async getPR(prId: string): Promise<PREvent | null> {
        return { prId, title: 'Mock PR', url: 'https://example.com/pr/mock', status: 'open', buildStatus: 'passing' };
    }

    async triggerBuild(branch: string): Promise<{ buildId: string; url?: string }> {
        return { buildId: `mock-build-${Date.now()}`, url: `https://example.com/build/mock` };
    }

    async getBuildStatus(): Promise<PREvent['buildStatus']> {
        return 'passing';
    }
}

export class MockNotifications implements INotifications {
    readonly providerName = 'mock';
    readonly sent: NotificationPayload[] = [];

    async send(payload: NotificationPayload): Promise<boolean> {
        this.sent.push(payload);
        console.log(`[mock-notify] ${payload.title}: ${payload.body}`);
        return true;
    }
}
