import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseJsonUtf8File } from './json-file';
import { mapV1TaskStatus } from './route-shared';
import type { RawTask } from './status-normalize';

export interface LocalPlanningStory {
    id: string;
    number: string;
    name: string;
    description: string;
    status: string;
    teamId: string;
    team: string;
    estimate: number | null;
    priority: string;
    scope: string;
    classOfService: string;
    acceptanceCriteria: string;
    frontend: string;
    backend: string;
    qa: string;
    owner?: string;
    externalRef?: string;
    externalUrl?: string;
    /** When the story was authored from an AI-QA finding, the finding's stable id — links the story back to its finding. */
    sourceFindingId?: string;
    deleted?: boolean;
    sortOrder?: number;
    createdAt: string;
    updatedAt: string;
}

export interface LocalPlanningTask {
    id: string;
    number: string;
    name: string;
    parent: string;
    status: string;
    owners: string[];
    estimate: number;
    todo: number;
    done: number;
    actuals: number;
    category: string;
    priority?: string;
    createdAt: string;
    updatedAt: string;
}

export interface LocalPlanningState {
    nextStoryId: number;
    nextTaskId: number;
    teams: Array<{ id: string; name: string }>;
    members: Array<{ id: string; name: string; nickname?: string; email?: string }>;
    classOfService: Array<{ id: string; name: string }>;
    scopes: Array<{ id: string; name: string }>;
    stories: LocalPlanningStory[];
    tasks: LocalPlanningTask[];
}

export const LOCAL_STORY_PREFIX = 'LOCAL-B-';
export const LOCAL_TASK_PREFIX = 'LOCAL-TK-';

const DEFAULT_STATE: LocalPlanningState = {
    nextStoryId: 11,
    nextTaskId: 1,
    teams: [
        { id: 'LocalTeam:1', name: 'SDLC Framework' },
        { id: 'LocalTeam:2', name: 'Platform' },
        { id: 'LocalTeam:3', name: 'Experience' },
    ],
    members: [
        { id: 'LocalMember:1', name: 'Bohan, Jason', nickname: 'jbohan', email: 'jbohan@example.com' },
        { id: 'LocalMember:2', name: 'Agent, Frontend', nickname: 'frontend', email: 'frontend@sdlc-framework.local' },
        { id: 'LocalMember:3', name: 'Agent, Reviewer', nickname: 'reviewer', email: 'reviewer@sdlc-framework.local' },
        { id: 'LocalMember:4', name: 'Agent, DevOps', nickname: 'devops', email: 'devops@sdlc-framework.local' },
    ],
    classOfService: [
        { id: 'LocalClassOfService:1', name: 'Standard' },
        { id: 'LocalClassOfService:2', name: 'Expedite' },
        { id: 'LocalClassOfService:3', name: 'Fixed Date' },
        { id: 'LocalClassOfService:4', name: 'Intangible' },
    ],
    scopes: [{ id: 'LocalScope:1', name: 'SDLC Framework' }],
    stories: [
        {
            id: 'LocalStory:LOCAL-B-0001', number: 'LOCAL-B-0001',
            name: 'Look into task pickup and handoff',
            description: '<p>Investigate the full task pickup and handoff flow end-to-end in the SDLC Framework SDLC pipeline. Trace how an agent picks up a task, transitions phases, and hands off to the next role (reviewer, devops). Identify any gaps or friction in the current contract.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 3, priority: 'High',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- Can trace a task from assign through handoff in the dashboard\n- Phase contracts are clearly documented\n- Any gaps are filed as follow-up stories</p>',
            frontend: '<p>Verify dashboard shows handoff state correctly (stepPauseReady, handoffDispatched)</p>',
            backend: '<p>Trace scheduler → handoff → pr-events route chain. Check that local stories flow the same as Agility stories.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
        {
            id: 'LocalStory:LOCAL-B-0002', number: 'LOCAL-B-0002',
            name: 'Unit tests for agent-runner registry and tools',
            description: '<p>Add unit test coverage for agent-runner/registry.ts (runner lifecycle, inject, stop) and agent-runner/tools.ts (path safety, read/write/list). Currently zero coverage.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 2, priority: 'Medium',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- registry.ts: lifecycle start/stop, inject, concurrent runner guard\n- tools.ts: path safety (no traversal), read/write/list happy path and error cases\n- All new tests pass in vitest run</p>',
            frontend: '', backend: '<p>Write tests in src/test/. Use existing vitest + jsdom setup.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
        {
            id: 'LocalStory:LOCAL-B-0003', number: 'LOCAL-B-0003',
            name: 'SSE chat route unit test coverage',
            description: '<p>The SSE stream for chat is only covered by Cypress today. Add unit-level tests for the chat SSE route so regressions are caught without spinning up a browser.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 2, priority: 'Medium',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- Unit tests for chat SSE route: connection, message delivery, disconnect cleanup\n- Tests run in vitest (no Cypress required)</p>',
            frontend: '', backend: '<p>Mirror the pattern from src/test/statusEvents.test.ts for the chat SSE route.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
        {
            id: 'LocalStory:LOCAL-B-0004', number: 'LOCAL-B-0004',
            name: 'Server hook-runner on status file changes',
            description: '<p>Add <code>src/server/hook-runner.ts</code> subscribed to <code>onStatusChange</code> so watcher logic runs in the SDLC Framework server when status files change. Debounce like status-events.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 5, priority: 'High',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- Status writes trigger hook-runner\n- Idempotent per agent+phase\n- Unit tests for debounce\n- Started on server boot</p>',
            frontend: '', backend: '<p>Wire in server startup; reuse rootDir.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
        {
            id: 'LocalStory:LOCAL-B-0005', number: 'LOCAL-B-0005',
            name: 'Port workflow-validator to hook-runner.ts',
            description: '<p>Port all checks from <code>workflow-validator.ps1</code> to TypeScript with parity for task, reviewer handoff, PR, and Agility task violations.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 3, priority: 'High',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- Four validator checks ported\n- Vitest per violation type\n- Actionable nudge messages</p>',
            frontend: '', backend: '<p>Implement in hook-runner.ts.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
        {
            id: 'LocalStory:LOCAL-B-0006', number: 'LOCAL-B-0006',
            name: 'Port reviewer and devops watcher automation to hook-runner',
            description: '<p>Call spawn-from-desk and handoff APIs on status transitions; mirror handoffDispatched guards from PowerShell watchers.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 5, priority: 'High',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- Reviewer and devops automation parity\n- handoff tests pass\n- No duplicate POSTs</p>',
            frontend: '', backend: '<p>Use existing handoff routes or in-process calls.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
        {
            id: 'LocalStory:LOCAL-B-0007', number: 'LOCAL-B-0007',
            name: 'Unify role watchers and /api/hook/agent-stop in hook-runner',
            description: '<p>Port frontend/backend/ux nudges and /btw triggers; make agent-stop call the same hook-runner module.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 3, priority: 'Medium',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- Single TS implementation for IDE and server\n- agent-stop tests pass</p>',
            frontend: '', backend: '<p>Share triggers.ts matching logic.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
        {
            id: 'LocalStory:LOCAL-B-0008', number: 'LOCAL-B-0008',
            name: 'Server-driven agent continue (reduce followup_message dependency)',
            description: '<p>Nudge agents via continue/spawn APIs instead of IDE followup_message injection where the scheduler allows.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 5, priority: 'Medium',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- Auto-continue for key phases\n- Step-mode respected\n- No continue loops</p>',
            frontend: '', backend: '<p>Integrate spawn-agent and scheduler driver.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
        {
            id: 'LocalStory:LOCAL-B-0009', number: 'LOCAL-B-0009',
            name: 'Thin optional IDE hooks; retire PowerShell watchers',
            description: '<p>Optional hooks POST to server; remove duplicated PowerShell watcher logic after parity.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 2, priority: 'Low',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- Quiet optional hooks\n- Docs updated\n- PS watchers retired</p>',
            frontend: '', backend: '<p>Add /api/hook/run-watchers if needed.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
        {
            id: 'LocalStory:LOCAL-B-0010', number: 'LOCAL-B-0010',
            name: 'Cloud token estimator via server endpoint',
            description: '<p>Optional POST endpoint for response-text token estimates; minimal afterAgentResponse hook or log-based estimation.</p>',
            status: 'Backlog', teamId: 'LocalTeam:1', team: 'SDLC Framework', estimate: 2, priority: 'Low',
            scope: 'SDLC Framework', classOfService: 'Standard',
            acceptanceCriteria: '<p>- Dashboard token ledger still works\n- No profile noise on token path</p>',
            frontend: '', backend: '<p>Extend tokens API.</p>',
            qa: '', createdAt: '2026-05-18T00:00:00.000Z', updatedAt: '2026-05-18T00:00:00.000Z',
        },
    ],
    tasks: [],
};

export function isLocalStoryNumber(storyNumber: unknown): boolean {
    return typeof storyNumber === 'string' && storyNumber.toUpperCase().startsWith(LOCAL_STORY_PREFIX);
}

function statePath(rootDir: string): string {
    return resolve(rootDir, '.sdlc-framework', 'local-planning', 'state.json');
}

function migrateFromLegacyPath(rootDir: string): void {
    const legacyFile = resolve(rootDir, '.sdlc-framework', 'local-agility', 'state.json');
    const newFile = statePath(rootDir);
    if (existsSync(legacyFile) && !existsSync(newFile)) {
        mkdirSync(resolve(rootDir, '.sdlc-framework', 'local-planning'), { recursive: true });
        copyFileSync(legacyFile, newFile);
    }
}

export function loadLocalPlanningState(rootDir: string): LocalPlanningState {
    migrateFromLegacyPath(rootDir);
    const file = statePath(rootDir);
    if (!existsSync(file)) {
        saveLocalPlanningState(rootDir, DEFAULT_STATE);
        return structuredClone(DEFAULT_STATE);
    }
    try {
        const parsed = parseJsonUtf8File(file) as Partial<LocalPlanningState>;
        return {
            ...structuredClone(DEFAULT_STATE),
            ...parsed,
            teams: parsed.teams ?? DEFAULT_STATE.teams,
            members: parsed.members ?? DEFAULT_STATE.members,
            classOfService: parsed.classOfService ?? DEFAULT_STATE.classOfService,
            scopes: parsed.scopes ?? DEFAULT_STATE.scopes,
            stories: parsed.stories ?? [],
            tasks: parsed.tasks ?? [],
        };
    } catch {
        return structuredClone(DEFAULT_STATE);
    }
}

export function saveLocalPlanningState(rootDir: string, state: LocalPlanningState): void {
    mkdirSync(resolve(rootDir, '.sdlc-framework', 'local-planning'), { recursive: true });
    writeFileSync(statePath(rootDir), JSON.stringify(state, null, 2));
}

function nextStoryNumber(state: LocalPlanningState): string {
    const number = `${LOCAL_STORY_PREFIX}${String(state.nextStoryId).padStart(4, '0')}`;
    state.nextStoryId += 1;
    return number;
}

function nextTaskNumber(state: LocalPlanningState): string {
    const number = `${LOCAL_TASK_PREFIX}${String(state.nextTaskId).padStart(4, '0')}`;
    state.nextTaskId += 1;
    return number;
}

export function findLocalStory(rootDir: string, numberOrId: string): LocalPlanningStory | undefined {
    const state = loadLocalPlanningState(rootDir);
    return state.stories.find((story) => story.number === numberOrId || story.id === numberOrId);
}

export function createLocalStory(rootDir: string, input: Partial<LocalPlanningStory> & { name: string }): LocalPlanningStory {
    const state = loadLocalPlanningState(rootDir);
    const now = new Date().toISOString();
    const number = nextStoryNumber(state);
    const team = input.team || 'SDLC Framework';
    const teamId = input.teamId || state.teams.find((t) => t.name === team)?.id || state.teams[0]?.id || 'LocalTeam:1';
    const story: LocalPlanningStory = {
        id: `LocalStory:${number}`,
        number,
        name: input.name,
        description: input.description ?? '',
        status: input.status ?? 'Backlog',
        teamId,
        team,
        estimate: input.estimate ?? null,
        priority: input.priority ?? '',
        scope: input.scope ?? 'SDLC Framework',
        classOfService: input.classOfService ?? 'Standard',
        acceptanceCriteria: input.acceptanceCriteria ?? '',
        frontend: input.frontend ?? '',
        backend: input.backend ?? '',
        qa: input.qa ?? '',
        owner: input.owner,
        externalRef: input.externalRef,
        externalUrl: input.externalUrl,
        sourceFindingId: input.sourceFindingId,
        createdAt: now,
        updatedAt: now,
    };
    state.stories.push(story);
    saveLocalPlanningState(rootDir, state);
    return story;
}

export function createLocalTask(rootDir: string, input: {
    storyNumber: string;
    name: string;
    estimate?: number;
    category?: string | null;
    priority?: string;
    owners?: string[];
    status?: string;
}): LocalPlanningTask {
    const state = loadLocalPlanningState(rootDir);
    const story = state.stories.find((s) => s.number === input.storyNumber);
    if (!story) throw new Error(`Local story ${input.storyNumber} not found`);
    const now = new Date().toISOString();
    const number = nextTaskNumber(state);
    const task: LocalPlanningTask = {
        id: `LocalTask:${number}`,
        number,
        name: input.name,
        parent: story.number,
        status: input.status ?? 'None',
        owners: input.owners ?? [],
        estimate: input.estimate ?? 0,
        todo: input.estimate ?? 0,
        done: 0,
        actuals: 0,
        category: input.category ?? '',
        priority: input.priority,
        createdAt: now,
        updatedAt: now,
    };
    state.tasks.push(task);
    saveLocalPlanningState(rootDir, state);
    return task;
}

export function updateLocalStoryStatus(rootDir: string, storyNumber: string, status: string): LocalPlanningStory {
    const state = loadLocalPlanningState(rootDir);
    const story = state.stories.find((s) => s.number === storyNumber);
    if (!story) throw new Error(`Local story ${storyNumber} not found`);
    story.status = status;
    story.updatedAt = new Date().toISOString();
    saveLocalPlanningState(rootDir, state);
    return story;
}

export function updateLocalStory(rootDir: string, storyNumber: string, input: Partial<LocalPlanningStory>): LocalPlanningStory {
    const state = loadLocalPlanningState(rootDir);
    const story = state.stories.find((s) => s.number === storyNumber || s.id === storyNumber);
    if (!story) throw new Error(`Local story ${storyNumber} not found`);
    const team = input.team ?? story.team;
    const teamId = input.teamId ?? state.teams.find((t) => t.name === team)?.id ?? story.teamId;
    Object.assign(story, {
        name: input.name ?? story.name,
        description: input.description ?? story.description,
        status: input.status ?? story.status,
        team,
        teamId,
        estimate: input.estimate !== undefined ? input.estimate : story.estimate,
        priority: input.priority ?? story.priority,
        scope: input.scope ?? story.scope,
        classOfService: input.classOfService ?? story.classOfService,
        acceptanceCriteria: input.acceptanceCriteria ?? story.acceptanceCriteria,
        frontend: input.frontend ?? story.frontend,
        backend: input.backend ?? story.backend,
        qa: input.qa ?? story.qa,
        owner: input.owner ?? story.owner,
        externalRef: input.externalRef ?? story.externalRef,
        externalUrl: input.externalUrl ?? story.externalUrl,
        updatedAt: new Date().toISOString(),
    });
    saveLocalPlanningState(rootDir, state);
    return story;
}

export function updateLocalTaskStatus(rootDir: string, taskNumber: string, status: string): LocalPlanningTask {
    const state = loadLocalPlanningState(rootDir);
    const task = state.tasks.find((t) => t.number === taskNumber || t.id === taskNumber);
    if (!task) throw new Error(`Local task ${taskNumber} not found`);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    saveLocalPlanningState(rootDir, state);
    return task;
}

export function deleteLocalStory(rootDir: string, storyNumber: string): LocalPlanningStory {
    const state = loadLocalPlanningState(rootDir);
    const story = state.stories.find((s) => s.number === storyNumber || s.id === storyNumber);
    if (!story) throw new Error(`Local story ${storyNumber} not found`);
    story.deleted = true;
    story.updatedAt = new Date().toISOString();
    saveLocalPlanningState(rootDir, state);
    return story;
}

export function reorderLocalStories(rootDir: string, orderedNumbers: string[]): void {
    const state = loadLocalPlanningState(rootDir);
    const indexMap = new Map(orderedNumbers.map((n, i) => [n, i]));
    for (const story of state.stories) {
        const idx = indexMap.get(story.number);
        if (idx !== undefined) story.sortOrder = idx;
    }
    saveLocalPlanningState(rootDir, state);
}

export function listLocalTasksForStory(rootDir: string, storyNumber: string): LocalPlanningTask[] {
    const state = loadLocalPlanningState(rootDir);
    return state.tasks.filter((task) => task.parent === storyNumber);
}

export function localTaskToRawTask(task: LocalPlanningTask): RawTask {
    return {
        id: task.number,
        number: task.number,
        name: task.name,
        status: mapV1TaskStatus(task.status),
        agilityStatus: task.status,
        category: task.category || undefined,
        hours: task.estimate,
        todo: task.todo,
        done: task.done,
        actuals: task.actuals,
        owners: task.owners,
        source: 'local',
        inherited: true,
    };
}

export function loadLocalTasksForStory(rootDir: string, storyNumber: string): RawTask[] {
    return listLocalTasksForStory(rootDir, storyNumber).map(localTaskToRawTask);
}

export function groupLocalBoard(rootDir: string) {
    const state = loadLocalPlanningState(rootDir);
    const tasksByStory = new Map<string, LocalPlanningTask[]>();
    for (const task of state.tasks) {
        const list = tasksByStory.get(task.parent) ?? [];
        list.push(task);
        tasksByStory.set(task.parent, list);
    }
    return {
        ...state,
        stories: state.stories.map((story) => ({
            ...story,
            tasks: tasksByStory.get(story.number) ?? [],
        })),
    };
}

const STATUS_FILE_RE = /^\.([a-z][\w-]*)-status\.json$/;

/**
 * Scans agent status files for tasks belonging to a LOCAL story: creates
 * missing tasks and updates status on existing ones. Returns the count of
 * rows created or updated.
 */
export function syncAgentTasksToLocalDB(rootDir: string, storyNumber: string): number {
    let synced = 0;
    let stateDirty = false;
    const entries = readdirSync(rootDir);
    for (const entry of entries) {
        const m = STATUS_FILE_RE.exec(entry);
        if (!m) continue;
        const agentId = m[1];
        try {
            const raw = parseJsonUtf8File(resolve(rootDir, entry)) as Record<string, unknown>;
            if (raw.storyNumber !== storyNumber) continue;
            const statusTasks = Array.isArray(raw.tasks) ? (raw.tasks as Array<Record<string, unknown>>) : [];
            if (statusTasks.length === 0) continue;
            const state = loadLocalPlanningState(rootDir);
            const storyTasks = state.tasks.filter((t) => t.parent === storyNumber);
            const byNumber = new Map(storyTasks.map((t) => [t.number, t]));
            const byId = new Map(storyTasks.map((t) => [t.id, t]));
            const byName = new Map(storyTasks.map((t) => [t.name.trim().toLowerCase(), t]));
            const existingNames = new Set(storyTasks.map((t) => t.name.trim().toLowerCase()));
            const AGENT_CAT: Record<string, string> = {
                frontend: 'Frontend', backend: 'Api', qa: 'QA', devops: 'AzureDevOps', ux: 'UX',
            };
            const agentStatusToLocal = (raw: unknown): string => {
                const statusStr = String(raw ?? 'pending').toLowerCase();
                if (statusStr === 'completed' || statusStr === 'done') return 'Completed';
                if (statusStr === 'in progress' || statusStr === 'in-progress') return 'In Progress';
                if (statusStr === 'backlog') return 'Backlog';
                return 'None';
            };
            for (const st of statusTasks) {
                const name = String(st.name ?? '').trim();
                const localStatus = agentStatusToLocal(st.status);
                const taskKey = String(st.number ?? st.id ?? '').trim();
                const existing = (taskKey && (byNumber.get(taskKey) ?? byId.get(taskKey)))
                    ?? (name ? byName.get(name.toLowerCase()) : undefined);
                if (existing) {
                    if (existing.status !== localStatus) {
                        existing.status = localStatus;
                        existing.updatedAt = new Date().toISOString();
                        stateDirty = true;
                        synced++;
                    }
                    continue;
                }
                if (!name || existingNames.has(name.toLowerCase())) continue;
                createLocalTask(rootDir, {
                    storyNumber,
                    name,
                    estimate: typeof st.estimate === 'number' ? st.estimate
                        : typeof st.hours === 'number' ? st.hours : 0,
                    category: typeof st.category === 'string' ? st.category : (AGENT_CAT[agentId] ?? ''),
                    status: localStatus,
                });
                existingNames.add(name.toLowerCase());
                synced++;
            }
            if (stateDirty) saveLocalPlanningState(rootDir, state);
        } catch { /* skip unreadable status files */ }
    }
    return synced;
}
