import { v1Fetch, v1Post } from '../../route-shared';
import type { IProjectTracker, FetchStoriesOptions } from '../IProjectTracker';
import type { Team, WorkItem, WorkItemSummary } from '../types';

export class AgilityProjectTracker implements IProjectTracker {
    readonly providerName = 'agility';

    constructor(private rootDir: string, private configFile: string) {}

    async getTeams(): Promise<Team[]> {
        const data = await v1Fetch(this.rootDir, '/Team', { sel: 'Name', where: "AssetState='64'", sort: 'Name' }) as { Assets?: Array<{ id?: string; Attributes?: Record<string, { value?: unknown }> }> };
        return (data.Assets ?? []).map(a => ({
            id: a.id ?? '',
            name: String(a.Attributes?.Name?.value ?? a.id ?? ''),
        }));
    }

    async getStories(opts: FetchStoriesOptions = {}): Promise<WorkItemSummary[]> {
        const where: string[] = ["IsClosed='false'", "Status.Name!='Released'"];
        if (opts.team) where.push(`Team.Name='${opts.team}'`);
        if (opts.status) where.push(`Status.Name='${opts.status}'`);
        if (opts.text) where.push(`Name~'${opts.text}'`);
        const data = await v1Fetch(this.rootDir, '/Story', {
            sel: 'Number,Name,Status.Name,Team,Team.Name,Estimate,Priority.Name',
            where: where.join(';'),
            sort: '-ChangeDate',
            page: `${opts.maxResults ?? 20},0`,
        }) as { Assets?: Array<{ id?: string; Attributes?: Record<string, { value?: unknown }> }> };
        return (data.Assets ?? []).map(a => {
            const at = a.Attributes ?? {};
            return {
                id: a.id ?? '',
                number: String(at.Number?.value ?? ''),
                title: String(at.Name?.value ?? ''),
                status: String(at['Status.Name']?.value ?? 'None'),
                teamId: String(at.Team?.value ?? ''),
                team: String(at['Team.Name']?.value ?? ''),
                estimate: at.Estimate?.value as number | null,
                priority: String(at['Priority.Name']?.value ?? ''),
                source: 'agility' as const,
            };
        });
    }

    async getWorkItem(numberOrId: string): Promise<WorkItem | null> {
        const sel = 'Number,Name,Description,Status.Name,Team,Team.Name,Estimate,Priority.Name,Custom_AcceptanceCriteria,Custom_Frontend,Custom_Backend,Custom_QA,Scope.Name,ClassOfService.Name';
        const data = await v1Fetch(this.rootDir, '/Story', { sel, where: `Number='${numberOrId}'` }) as { Assets?: Array<{ id?: string; Attributes?: Record<string, { value?: unknown }> }> };
        const asset = data.Assets?.[0];
        if (!asset) return null;
        const at = asset.Attributes ?? {};
        return {
            id: asset.id ?? '',
            number: String(at.Number?.value ?? ''),
            title: String(at.Name?.value ?? ''),
            description: String(at.Description?.value ?? ''),
            status: String(at['Status.Name']?.value ?? 'None'),
            type: 'story',
            teamId: String(at.Team?.value ?? ''),
            team: String(at['Team.Name']?.value ?? ''),
            estimate: at.Estimate?.value as number | null,
            priority: String(at['Priority.Name']?.value ?? ''),
            classOfService: String(at['ClassOfService.Name']?.value ?? ''),
            acceptanceCriteria: String(at.Custom_AcceptanceCriteria?.value ?? ''),
            lanes: {
                frontend: String(at.Custom_Frontend?.value ?? ''),
                backend: String(at.Custom_Backend?.value ?? ''),
                qa: String(at.Custom_QA?.value ?? ''),
            },
            source: 'agility',
        };
    }

    async updateStatus(numberOrId: string, status: string): Promise<boolean> {
        const find = await v1Fetch(this.rootDir, '/Story', { where: `Number='${numberOrId}'`, sel: 'Name' }) as { Assets?: Array<{ id?: string }> };
        const oid = find.Assets?.[0]?.id;
        if (!oid) return false;
        if (['Released', 'Done', 'Closed'].includes(status)) {
            await v1Post(this.rootDir, `/${oid}?op=Inactivate`, {});
        }
        return true;
    }

    async createWorkItem(fields: Partial<WorkItem>): Promise<WorkItem> {
        const body = {
            Attributes: {
                Name: { value: fields.title ?? 'Untitled' },
                Description: { value: fields.description ?? '' },
                ...(fields.team ? { 'Team.Name': { value: fields.team } } : {}),
                ...(fields.estimate != null ? { Estimate: { value: fields.estimate } } : {}),
            },
        };
        const data = await v1Post(this.rootDir, '/Story', body) as { id?: string };
        return { ...fields, id: data.id ?? '', number: '', title: fields.title ?? '', description: fields.description ?? '', status: 'Backlog', type: 'story', source: 'agility' };
    }
}
