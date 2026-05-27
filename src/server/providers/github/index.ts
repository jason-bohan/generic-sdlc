import { execSync } from 'child_process';
import type { IProjectTracker, FetchStoriesOptions } from '../IProjectTracker';
import type { Team, WorkItem, WorkItemSummary } from '../types';

interface GitHubIssue {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: string;
    html_url: string;
    labels: Array<{ name: string }>;
    assignee: { login: string } | null;
}

function resolveToken(): string {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    try {
        return execSync('gh auth token', { encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

function labelType(labels: string[]): WorkItem['type'] {
    if (labels.includes('bug')) return 'bug';
    if (labels.includes('feature') || labels.includes('enhancement')) return 'feature';
    if (labels.includes('task')) return 'task';
    return 'story';
}

function labelPriority(labels: string[]): string {
    if (labels.some(l => /high|critical|urgent/i.test(l))) return 'High';
    if (labels.some(l => /low/i.test(l))) return 'Low';
    return 'Medium';
}

function assignTeam(issueNumber: number): { teamId: string; team: string } {
    return issueNumber % 2 !== 0
        ? { teamId: 'team-autobots',    team: 'Autobots' }
        : { teamId: 'team-decepticons', team: 'Decepticons' };
}

function issueToWorkItem(issue: GitHubIssue, repo: string): WorkItem {
    const labels = issue.labels.map(l => l.name);
    return {
        id: String(issue.id),
        number: String(issue.number),
        title: issue.title,
        description: issue.body ?? '',
        status: issue.state === 'open' ? 'Open' : 'Closed',
        type: labelType(labels),
        assignee: issue.assignee?.login,
        priority: labelPriority(labels),
        url: issue.html_url,
        source: 'github',
        ...assignTeam(issue.number),
    };
}

export class GitHubProjectTracker implements IProjectTracker {
    readonly providerName = 'github';

    constructor(
        private readonly repo: string,
        private readonly token = resolveToken(),
    ) {}

    private get headers(): HeadersInit {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'sdlc-framework',
        };
    }

    private async apiGet<T>(path: string): Promise<T> {
        const res = await fetch(`https://api.github.com${path}`, { headers: this.headers });
        if (!res.ok) throw new Error(`GitHub API ${path} → ${res.status}`);
        return res.json() as Promise<T>;
    }

    async getTeams(): Promise<Team[]> {
        return [
            { id: 'team-autobots',    name: 'Autobots' },
            { id: 'team-decepticons', name: 'Decepticons' },
        ];
    }

    async getStories(opts: FetchStoriesOptions = {}): Promise<WorkItemSummary[]> {
        const params = new URLSearchParams({
            state: 'open',
            per_page: String(opts.maxResults ?? 30),
        });
        if (opts.text) params.set('q', opts.text);

        const issues = await this.apiGet<GitHubIssue[]>(
            `/repos/${this.repo}/issues?${params}`,
        );

        return issues
            .filter(i => !(i as unknown as Record<string, unknown>).pull_request)
            .map(i => {
                const labels = i.labels.map(l => l.name);
                return {
                    id: String(i.id),
                    number: String(i.number),
                    title: i.title,
                    status: 'Open',
                    priority: labelPriority(labels),
                    source: 'github' as const,
                    ...assignTeam(i.number),
                };
            });
    }

    async getWorkItem(numberOrId: string): Promise<WorkItem | null> {
        try {
            const issue = await this.apiGet<GitHubIssue>(
                `/repos/${this.repo}/issues/${numberOrId}`,
            );
            return issueToWorkItem(issue, this.repo);
        } catch {
            return null;
        }
    }

    async updateStatus(numberOrId: string, status: string): Promise<boolean> {
        const closed = ['done', 'closed', 'released', 'complete'].includes(status.toLowerCase());
        const res = await fetch(
            `https://api.github.com/repos/${this.repo}/issues/${numberOrId}`,
            {
                method: 'PATCH',
                headers: { ...this.headers as Record<string, string>, 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: closed ? 'closed' : 'open' }),
            },
        );
        return res.ok;
    }

    async createWorkItem(fields: Partial<WorkItem>): Promise<WorkItem> {
        const res = await fetch(
            `https://api.github.com/repos/${this.repo}/issues`,
            {
                method: 'POST',
                headers: { ...this.headers as Record<string, string>, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: fields.title ?? 'Untitled',
                    body: fields.description ?? '',
                    labels: fields.type === 'bug' ? ['bug'] : [],
                }),
            },
        );
        if (!res.ok) throw new Error(`Failed to create GitHub issue: ${res.status}`);
        const issue = await res.json() as GitHubIssue;
        return issueToWorkItem(issue, this.repo);
    }

    async getTasksForStory(): Promise<[]> { return []; }
}
