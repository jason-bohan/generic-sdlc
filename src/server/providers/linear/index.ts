import type { IProjectTracker, FetchStoriesOptions } from '../IProjectTracker';
import type { Team, WorkItem, WorkItemSummary } from '../types';
import type { RawTask } from '../../status-normalize';

const LINEAR_API = 'https://api.linear.app/graphql';

function priorityLabel(p: number): string {
    if (p === 1) return 'Urgent';
    if (p === 2) return 'High';
    if (p === 3) return 'Medium';
    if (p === 4) return 'Low';
    return 'Medium';
}

function typeFromLabels(labels: string[]): WorkItem['type'] {
    const lower = labels.map(l => l.toLowerCase());
    if (lower.some(l => l.includes('bug'))) return 'bug';
    if (lower.some(l => l.includes('feature'))) return 'feature';
    if (lower.some(l => l.includes('task'))) return 'task';
    return 'story';
}

export class LinearProjectTracker implements IProjectTracker {
    readonly providerName = 'linear';

    constructor(private readonly apiKey: string) {}

    private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
        const res = await fetch(LINEAR_API, {
            method: 'POST',
            headers: {
                Authorization: this.apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query, variables }),
        });
        if (!res.ok) throw new Error(`Linear API error: ${res.status}`);
        const body = await res.json() as { data?: T; errors?: Array<{ message: string }> };
        if (body.errors?.length) throw new Error(body.errors.map(e => e.message).join('; '));
        return body.data as T;
    }

    async getTeams(): Promise<Team[]> {
        const data = await this.gql<{ teams: { nodes: Array<{ id: string; name: string }> } }>(`
            query { teams { nodes { id name } } }
        `);
        return data.teams.nodes.map(t => ({ id: t.id, name: t.name }));
    }

    async getStories(opts: FetchStoriesOptions = {}): Promise<WorkItemSummary[]> {
        const filter: Record<string, unknown> = {};
        if (opts.status) filter['state'] = { name: { eq: opts.status } };
        if (opts.team) filter['team'] = { name: { eq: opts.team } };
        if (opts.text) filter['or'] = [
            { title: { containsIgnoreCase: opts.text } },
            { description: { containsIgnoreCase: opts.text } },
        ];

        const data = await this.gql<{
            issues: {
                nodes: Array<{
                    id: string; identifier: string; number: number;
                    title: string; state: { name: string };
                    team: { id: string; name: string };
                    priority: number; url: string;
                    labels: { nodes: Array<{ name: string }> };
                }>;
            };
        }>(`
            query Issues($filter: IssueFilter, $first: Int) {
                issues(filter: $filter, first: $first, orderBy: updatedAt) {
                    nodes {
                        id identifier number title
                        state { name }
                        team { id name }
                        priority url
                        labels { nodes { name } }
                    }
                }
            }
        `, { filter, first: opts.maxResults ?? 30 });

        return data.issues.nodes.map(i => ({
            id: i.id,
            number: i.identifier,
            title: i.title,
            status: i.state.name,
            team: i.team.name,
            teamId: i.team.id,
            priority: priorityLabel(i.priority),
            source: 'linear' as const,
        }));
    }

    async getWorkItem(numberOrId: string): Promise<WorkItem | null> {
        // numberOrId may be: "5", "FLO-5", or a UUID
        const isUuid = /^[0-9a-f-]{36}$/i.test(numberOrId);

        if (isUuid) {
            return this.getById(numberOrId);
        }

        // Linear's IssueFilter does not support filtering by `identifier`.
        // Parse the identifier to get the numeric part (e.g. "UNW-90" → 90)
        // and use `or` to search by number only.
        // For identifiers like "FLO-5", we search by number and rely on the
        // team context if available.
        const numberOnly = numberOrId.replace(/^[A-Za-z]+-/, '');
        const parsed = parseInt(numberOnly, 10);
        if (isNaN(parsed)) return null;

        const filter: Record<string, unknown> = { number: { eq: parsed } };

        const data = await this.gql<{
            issues: {
                nodes: Array<{
                    id: string; identifier: string; number: number;
                    title: string; description: string | null;
                    state: { name: string };
                    team: { id: string; name: string };
                    priority: number; url: string;
                    labels: { nodes: Array<{ name: string }> };
                }>;
            };
        }>(`
            query Issues($filter: IssueFilter) {
                issues(filter: $filter, first: 1) {
                    nodes {
                        id identifier number title description
                        state { name }
                        team { id name }
                        priority url
                        labels { nodes { name } }
                    }
                }
            }
        `, { filter });

        const i = data.issues.nodes[0];
        if (!i) return null;
        return this.mapIssue(i);
    }

    private async getById(id: string): Promise<WorkItem | null> {
        const data = await this.gql<{
            issue: {
                id: string; identifier: string; number: number;
                title: string; description: string | null;
                state: { name: string };
                team: { id: string; name: string };
                priority: number; url: string;
                labels: { nodes: Array<{ name: string }> };
            } | null;
        }>(`
            query Issue($id: String!) {
                issue(id: $id) {
                    id identifier number title description
                    state { name }
                    team { id name }
                    priority url
                    labels { nodes { name } }
                }
            }
        `, { id });
        if (!data.issue) return null;
        return this.mapIssue(data.issue);
    }

    private mapIssue(i: {
        id: string; identifier: string; number: number;
        title: string; description: string | null;
        state: { name: string };
        team: { id: string; name: string };
        priority: number; url: string;
        labels: { nodes: Array<{ name: string }> };
    }): WorkItem {
        const labels = i.labels.nodes.map(l => l.name);
        return {
            id: i.id,
            number: i.identifier,
            title: i.title,
            description: i.description ?? '',
            status: i.state.name,
            type: typeFromLabels(labels),
            teamId: i.team.id,
            team: i.team.name,
            priority: priorityLabel(i.priority),
            url: i.url,
            source: 'linear',
        };
    }

    async updateStatus(id: string, status: string): Promise<boolean> {
        // Resolve state ID for this issue's team
        const stateData = await this.gql<{
            workflowStates: { nodes: Array<{ id: string; name: string }> };
        }>(`
            query States($filter: WorkflowStateFilter) {
                workflowStates(filter: $filter) {
                    nodes { id name }
                }
            }
        `, { filter: { name: { containsIgnoreCase: status } } });

        const state = stateData.workflowStates.nodes[0];
        if (!state) return false;

        const result = await this.gql<{ issueUpdate: { success: boolean } }>(`
            mutation IssueUpdate($id: String!, $stateId: String!) {
                issueUpdate(id: $id, input: { stateId: $stateId }) { success }
            }
        `, { id, stateId: state.id });

        return result.issueUpdate.success;
    }

    async createWorkItem(fields: Partial<WorkItem>): Promise<WorkItem> {
        let teamId = fields.teamId ?? process.env.LINEAR_TEAM_ID;
        if (!teamId) {
            const teams = await this.getTeams();
            if (!teams.length) throw new Error('No Linear teams found and LINEAR_TEAM_ID is not set');
            teamId = teams[0].id;
        }

        const result = await this.gql<{
            issueCreate: {
                success: boolean;
                issue: { id: string; identifier: string; number: number; title: string; url: string; description: string | null; state: { name: string }; team: { id: string; name: string }; priority: number; labels: { nodes: Array<{ name: string }> } };
            };
        }>(`
            mutation IssueCreate($input: IssueCreateInput!) {
                issueCreate(input: $input) {
                    success
                    issue {
                        id identifier number title url description
                        state { name }
                        team { id name }
                        priority
                        labels { nodes { name } }
                    }
                }
            }
        `, {
            input: {
                teamId,
                title: fields.title ?? 'Untitled',
                description: fields.description ?? '',
            },
        });

        if (!result.issueCreate.success) throw new Error('Failed to create Linear issue');
        return this.mapIssue(result.issueCreate.issue);
    }

    async getTasksForStory(storyNumber: string): Promise<RawTask[]> {
        const data = await this.gql<{
            issues: {
                nodes: Array<{
                    children: {
                        nodes: Array<{
                            id: string; identifier: string; title: string;
                            state: { name: string }; priority: number;
                        }>;
                    };
                }>;
            };
        }>(`
            query SubIssues($filter: IssueFilter) {
                issues(filter: $filter, first: 1) {
                    nodes {
                        children {
                            nodes { id identifier title state { name } priority }
                        }
                    }
                }
            }
        `, {
            filter: storyNumber.includes('-')
                ? { identifier: { eq: storyNumber } }
                : { number: { eq: parseInt(storyNumber, 10) } },
        });

        const parent = data.issues.nodes[0];
        if (!parent) return [];

        return parent.children.nodes.map(c => ({
            id: c.identifier,
            number: c.identifier,
            name: c.title,
            status: c.state.name.toLowerCase().includes('done') ? 'completed' : 'pending',
            hours: 0,
            category: null,
            owners: [],
        }));
    }
}
