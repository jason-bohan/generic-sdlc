import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { parseJsonUtf8File } from './json-file';
import type { Team, WorkItem } from './providers/types';

export interface DemoPreset {
    name: string;
    description?: string;
    teams?: Team[];
    workItems: WorkItem[];
}

function presetFile(rootDir: string, presetNameOrPath: string): string {
    if (isAbsolute(presetNameOrPath)) return presetNameOrPath;
    if (presetNameOrPath.includes('/') || presetNameOrPath.includes('\\')) {
        return resolve(rootDir, presetNameOrPath);
    }
    return resolve(rootDir, 'data', 'presets', `${presetNameOrPath}.json`);
}

function isWorkItemType(value: unknown): value is WorkItem['type'] {
    return value === 'story' || value === 'bug' || value === 'task' || value === 'defect' || value === 'feature';
}

function normalizeWorkItem(raw: Record<string, unknown>, index: number): WorkItem {
    const number = String(raw.number ?? `WI-${String(index + 1).padStart(4, '0')}`);
    const type = isWorkItemType(raw.type) ? raw.type : 'story';
    const lanes = raw.lanes && typeof raw.lanes === 'object' ? raw.lanes as WorkItem['lanes'] : undefined;
    const source = raw.source === 'local' || raw.source === 'agility' || raw.source === 'jira' || raw.source === 'github'
        ? raw.source
        : 'mock';
    return {
        id: String(raw.id ?? `preset-${number}`),
        number,
        title: String(raw.title ?? raw.name ?? 'Untitled'),
        description: String(raw.description ?? ''),
        status: String(raw.status ?? 'Backlog'),
        type,
        teamId: raw.teamId === undefined ? undefined : String(raw.teamId),
        team: raw.team === undefined ? undefined : String(raw.team),
        assignee: raw.assignee === undefined ? undefined : String(raw.assignee),
        estimate: typeof raw.estimate === 'number' ? raw.estimate : raw.estimate === null ? null : undefined,
        priority: raw.priority === undefined ? undefined : String(raw.priority),
        classOfService: raw.classOfService === undefined ? undefined : String(raw.classOfService),
        acceptanceCriteria: raw.acceptanceCriteria === undefined ? undefined : String(raw.acceptanceCriteria),
        lanes,
        url: raw.url === undefined ? undefined : String(raw.url),
        source,
    };
}

function normalizeTeams(raw: unknown): Team[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw
        .filter((team): team is Record<string, unknown> => team !== null && typeof team === 'object')
        .map((team, index) => ({
            id: String(team.id ?? `team-${index + 1}`),
            name: String(team.name ?? `Team ${index + 1}`),
        }));
}

export class MockDataGenerator {
    private readonly registry = new Map<string, () => DemoPreset>();

    register(name: string, loader: () => DemoPreset): void {
        this.registry.set(name, loader);
    }

    load(rootDir: string, presetNameOrPath: string): DemoPreset {
        const registered = this.registry.get(presetNameOrPath);
        if (registered) return registered();

        const file = presetFile(rootDir, presetNameOrPath);
        if (!existsSync(file)) {
            throw new Error(`Demo preset not found: ${file}`);
        }
        const raw = parseJsonUtf8File(file) as Record<string, unknown>;
        if (!Array.isArray(raw.workItems)) {
            throw new Error(`Demo preset ${file} must include a workItems array`);
        }
        return {
            name: String(raw.name ?? presetNameOrPath),
            description: raw.description === undefined ? undefined : String(raw.description),
            teams: normalizeTeams(raw.teams),
            workItems: raw.workItems
                .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
                .map(normalizeWorkItem),
        };
    }
}

