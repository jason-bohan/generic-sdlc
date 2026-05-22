import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseJsonUtf8File } from './json-file';

interface MockState {
    nextStoryId: number;
    nextTaskId: number;
    nextPrId: number;
    nextBuildId: number;
    teams: Array<{ id: string; name: string }>;
    members: Array<{ id: string; name: string; nickname?: string; email?: string }>;
    classOfService: Array<{ id: string; name: string }>;
    stories: MockStory[];
    tasks: MockTask[];
    prs: Array<Record<string, unknown>>;
    builds: Array<Record<string, unknown>>;
    notifications: Array<Record<string, unknown>>;
}

interface MockStory {
    id: string;
    number: string;
    name: string;
    description?: string;
    status?: string;
    teamId?: string;
    team?: string;
    estimate?: number | null;
    priority?: string;
    scope?: string;
    classOfService?: string;
    acceptanceCriteria?: string;
    frontend?: string;
    backend?: string;
    qa?: string;
}

interface MockTask {
    id: string;
    number: string;
    name: string;
    parent: string;
    status: string;
    owners: string[];
    estimate: number;
    todo: number;
    done: number;
    category?: string;
}

const DEFAULT_STATE: MockState = {
    nextStoryId: 17020,
    nextTaskId: 90000,
    nextPrId: 5000,
    nextBuildId: 7000,
    teams: [
        { id: 'Team:2001', name: 'Chipmunks' },
        { id: 'Team:2002', name: 'Ninja Turtles' },
        { id: 'Team:2003', name: 'Mighty Ducks' },
        { id: 'Team:2004', name: 'Integrators' },
        { id: 'Team:2005', name: 'Istari' },
        { id: 'Team:2006', name: 'Planeteers' },
        { id: 'Team:2007', name: 'Avengers' },
        { id: 'Team:2008', name: 'ARM' },
        { id: 'Team:2009', name: 'DevOps' },
    ],
    members: [
        { id: 'Member:1001', name: 'Bohan, Jason', nickname: 'jbohan', email: 'jbohan@example.com' },
        { id: 'Member:1002', name: 'Agent, Frontend', nickname: 'frontend', email: 'frontend@sdlc-framework.local' },
        { id: 'Member:1003', name: 'Agent, Reviewer', nickname: 'reviewer', email: 'reviewer@sdlc-framework.local' },
    ],
    classOfService: [
        { id: 'ClassOfService:1', name: 'Standard' },
        { id: 'ClassOfService:2', name: 'Expedite' },
        { id: 'ClassOfService:3', name: 'Fixed Date' },
        { id: 'ClassOfService:4', name: 'Intangible' },
    ],
    stories: [
        {
            id: 'Story:17001', number: 'B-17001',
            name: 'Add pagination to audit trail table',
            description: '<p>The audit trail table in YourProject currently loads all records. Add server-side pagination with configurable page size.</p>',
            status: 'Ready', teamId: 'Team:2002', team: 'Ninja Turtles',
            estimate: 5, priority: 'High', scope: 'YourProject', classOfService: 'Standard',
            acceptanceCriteria: '<ul><li>Table shows 25 records per page by default</li><li>Page size selector: 10, 25, 50, 100</li><li>Next/Prev/First/Last buttons</li><li>Total record count displayed</li></ul>',
            frontend: 'Use PrimeNG p-table with lazy loading. Add paginator component below table.',
            backend: 'Add page/size query params to GET /api/audit-trail. Return total count in response header.',
            qa: 'Test with 1000+ records. Verify page navigation, size changes, and filter resets page to 1.' },
        {
            id: 'Story:17002', number: 'B-17002',
            name: 'Fix environment selector not persisting across sessions',
            description: '<p>When a user selects a dev environment, the choice is lost on page refresh. Should persist in localStorage.</p>',
            status: 'Ready', teamId: 'Team:2001', team: 'Chipmunks',
            estimate: 2, priority: 'Medium', scope: 'YourProject', classOfService: 'Standard',
            acceptanceCriteria: '<ul><li>Selected environment persists in localStorage</li><li>On load, reads from storage and preselects</li><li>Clear button resets to default</li></ul>',
            frontend: 'Read/write environment key to localStorage in the environment-selector component.',
            backend: 'N/A — frontend-only change.',
            qa: 'Select env, refresh page, verify selection persists. Clear storage, verify default.' },
        {
            id: 'Story:17003', number: 'B-17003',
            name: 'Implement dark mode for admin dashboard',
            description: '<p>Add a dark mode toggle to the admin dashboard. Use CSS custom properties for theming.</p>',
            status: 'Ready', teamId: 'Team:2002', team: 'Ninja Turtles',
            estimate: 8, priority: 'Medium', scope: 'YourProject', classOfService: 'Standard',
            acceptanceCriteria: '<ul><li>Toggle in header switches light/dark</li><li>Preference saved to user profile</li><li>All admin pages support both themes</li><li>Charts and graphs adapt colors</li></ul>',
            frontend: 'Create theme service with CSS custom properties. Update all SCSS files to use variables.',
            backend: 'Add theme_preference column to user_settings table. New PUT /api/user/preferences endpoint.',
            qa: 'Test all admin pages in both modes. Check contrast ratios meet WCAG AA.' },
        {
            id: 'Story:17004', number: 'B-17004',
            name: 'Add bulk action support to content manager',
            description: '<p>Content editors need to select multiple items and apply actions (publish, archive, delete) in bulk.</p>',
            status: 'In Progress', teamId: 'Team:2002', team: 'Ninja Turtles',
            estimate: 5, priority: 'High', scope: 'YourProject', classOfService: 'Standard',
            acceptanceCriteria: '<ul><li>Checkbox column for row selection</li><li>Select all / deselect all</li><li>Bulk publish, archive, delete actions</li><li>Confirmation dialog before destructive actions</li></ul>',
            frontend: 'Add selection state to content-list component. Bulk action toolbar appears when items selected.',
            backend: 'New POST /api/content/bulk-action endpoint accepting array of IDs and action type.',
            qa: 'Test with 50+ items selected. Verify partial failures show individual errors.' },
        {
            id: 'Story:17005', number: 'B-17005',
            name: 'Upgrade Angular to v19',
            description: '<p>Upgrade YourProject frontend from Angular 18 to Angular 19. Update all dependencies and fix breaking changes.</p>',
            status: 'Ready', teamId: 'Team:2004', team: 'Integrators',
            estimate: 13, priority: 'Low', scope: 'YourProject', classOfService: 'Intangible',
            acceptanceCriteria: '<ul><li>All unit tests pass</li><li>All e2e tests pass</li><li>No console errors or warnings</li><li>Bundle size does not increase by more than 5%</li></ul>',
            frontend: 'Run ng update. Fix deprecated APIs. Update third-party libs.',
            backend: 'N/A',
            qa: 'Full regression test of all modules. Compare bundle sizes before/after.' },
        {
            id: 'Story:17006', number: 'B-17006',
            name: 'Add real-time notifications via WebSocket',
            description: '<p>Replace polling-based notification system with WebSocket push for instant updates.</p>',
            status: 'Ready', teamId: 'Team:2005', team: 'Istari',
            estimate: 8, priority: 'Medium', scope: 'YourProject', classOfService: 'Standard',
            acceptanceCriteria: '<ul><li>WebSocket connection established on login</li><li>Notifications appear within 1s of event</li><li>Graceful fallback to polling if WS unavailable</li><li>Connection auto-reconnects on drop</li></ul>',
            frontend: 'Create WebSocket service with reconnect logic. Update notification component to use push.',
            backend: 'Add SignalR hub for notifications. Broadcast on content publish, user mention, system alert.',
            qa: 'Test with network throttling. Verify reconnect. Load test with 100 concurrent connections.' },
        {
            id: 'Story:17007', number: 'B-17007',
            name: 'Fix media library upload failing for files over 10MB',
            description: '<p>Large file uploads to the media library fail silently. Need chunked upload support.</p>',
            status: 'Ready', teamId: 'Team:2001', team: 'Chipmunks',
            estimate: 3, priority: 'High', scope: 'YourProject', classOfService: 'Expedite',
            acceptanceCriteria: '<ul><li>Files up to 500MB upload successfully</li><li>Progress bar shows upload percentage</li><li>Resume on network interruption</li></ul>',
            frontend: 'Implement chunked upload in media-upload component. Show progress bar.',
            backend: 'Add chunked upload endpoint. Reassemble chunks on completion. Store in blob storage.',
            qa: 'Test 10MB, 100MB, 500MB files. Kill network mid-upload and verify resume.' },
        {
            id: 'Story:17008', number: 'B-17008',
            name: 'Create deployment pipeline for Kubernetes migration',
            description: '<p>Set up CI/CD pipeline for deploying YourProject to AKS (Azure Kubernetes Service).</p>',
            status: 'Ready', teamId: 'Team:2009', team: 'DevOps',
            estimate: 13, priority: 'Medium', scope: 'YourProject', classOfService: 'Standard',
            acceptanceCriteria: '<ul><li>Dockerfile builds and runs locally</li><li>Helm chart deploys to AKS dev cluster</li><li>Pipeline triggers on PR merge to master</li><li>Health checks and rollback on failure</li></ul>',
            frontend: 'N/A',
            backend: 'Create Dockerfile, Helm chart, and Azure Pipeline YAML.',
            qa: 'Deploy to staging. Run smoke tests. Verify rollback on failed health check.' },
    ],
    tasks: [],
    prs: [],
    builds: [],
    notifications: [] };

function statePath(workspaceDir: string): string {
    return resolve(workspaceDir, '.sdlc-framework', 'mock', 'state.json');
}

function ensureState(workspaceDir: string): MockState {
    const file = statePath(workspaceDir);
    if (!existsSync(file)) {
        mkdirSync(resolve(workspaceDir, '.sdlc-framework', 'mock'), { recursive: true });
        writeFileSync(file, JSON.stringify(DEFAULT_STATE, null, 2));
        return structuredClone(DEFAULT_STATE);
    }
    try {
        return { ...structuredClone(DEFAULT_STATE), ...parseJsonUtf8File(file) };
    } catch {
        return structuredClone(DEFAULT_STATE);
    }
}

function saveState(workspaceDir: string, state: MockState) {
    mkdirSync(resolve(workspaceDir, '.sdlc-framework', 'mock'), { recursive: true });
    writeFileSync(statePath(workspaceDir), JSON.stringify(state, null, 2));
}

function attr(value: unknown, name?: string) {
    return name ? { value, name } : { value };
}

function bodyAttr(value: unknown) {
    return { value, act: 'set' };
}

function storyAsset(story: MockStory) {
    return {
        id: story.id,
        Attributes: {
            Number: attr(story.number),
            Name: attr(story.name),
            Description: attr(story.description ?? ''),
            'Status.Name': attr(story.status ?? 'Ready'),
            Team: attr(story.teamId),
            'Team.Name': attr(story.team ?? ''),
            Estimate: attr(story.estimate ?? null),
            'Priority.Name': attr(story.priority ?? ''),
            Custom_AcceptanceCriteria: attr(story.acceptanceCriteria ?? ''),
            Custom_Frontend: attr(story.frontend ?? ''),
            Custom_Backend: attr(story.backend ?? ''),
            Custom_QA: attr(story.qa ?? ''),
            'Scope.Name': attr(story.scope ?? ''),
            'ClassOfService.Name': attr(story.classOfService ?? ''),
            IsClosed: attr(false),
            CreateDate: attr(new Date().toISOString()),
            ClosedDate: attr(null),
            'Owners.Name': attr([]) } };
}

function taskAsset(task: MockTask) {
    return {
        id: task.id,
        Attributes: {
            Number: attr(task.number),
            Name: attr(task.name),
            'Status.Name': attr(task.status),
            'Owners.Name': attr(task.owners),
            DetailEstimate: attr(task.estimate),
            ToDo: attr(task.todo),
            Done: attr(task.done),
            Actuals: attr(0),
            Description: attr(''),
            'Category.Name': attr(task.category || '') } };
}

function valueFromBody(body: Record<string, any>, key: string) {
    return body.Attributes?.[key]?.value;
}

const CATEGORY_OID_TO_NAME: Record<string, string> = {
    'TaskCategory:111': 'Frontend',
    'TaskCategory:112': 'Api',
    'TaskCategory:113': 'QA',
    'TaskCategory:118781': 'AzureDevOps',
    'TaskCategory:239198': 'UX',
};

function resolveCategoryName(val: unknown): string | undefined {
    if (!val) return undefined;
    const s = String(val);
    return CATEGORY_OID_TO_NAME[s] ?? (s.startsWith('TaskCategory:') ? undefined : s);
}

function idsEqual(left: string, right: string) {
    return left === right || left.split(':')[1] === right || left.replace(':', '/') === right;
}

function findStory(state: MockState, idOrNumber: string) {
    return state.stories.find(s => s.number === idOrNumber || idsEqual(s.id, idOrNumber));
}

function findTask(state: MockState, idOrNumber: string) {
    return state.tasks.find(t => t.number === idOrNumber || idsEqual(t.id, idOrNumber));
}

function firstNamed<T extends { id: string; name: string }>(items: T[], name?: string) {
    if (!name) return items;
    return items.filter(item => item.name === name);
}

function parseWhereName(where = '') {
    return where.match(/Name='([^']+)'/)?.[1];
}

function applyStoryAttributes(story: MockStory, body: Record<string, any>) {
    const attrs = body.Attributes ?? {};
    if (attrs.Name) story.name = attrs.Name.value ?? story.name;
    if (attrs.Description) story.description = attrs.Description.value ?? '';
    if (attrs.Estimate) story.estimate = attrs.Estimate.value ?? null;
    if (attrs.Team) story.teamId = attrs.Team.value ?? story.teamId;
    if (attrs['Team.Name']) story.team = attrs['Team.Name'].value ?? story.team;
    if (attrs.Status) story.status = attrs.Status.value ?? story.status;
    if (attrs.Custom_AcceptanceCriteria) story.acceptanceCriteria = attrs.Custom_AcceptanceCriteria.value ?? '';
    if (attrs.Custom_Frontend) story.frontend = attrs.Custom_Frontend.value ?? '';
    if (attrs.Custom_Backend) story.backend = attrs.Custom_Backend.value ?? '';
    if (attrs.Custom_QA) story.qa = attrs.Custom_QA.value ?? '';
    if (attrs.Scope) story.scope = String(attrs.Scope.value ?? story.scope);
    if (attrs.ClassOfService) story.classOfService = String(attrs.ClassOfService.value ?? story.classOfService);
}

function applyTaskAttributes(task: MockTask, body: Record<string, any>) {
    const attrs = body.Attributes ?? {};
    if (attrs.Name) task.name = attrs.Name.value ?? task.name;
    if (attrs.Parent) task.parent = attrs.Parent.value ?? task.parent;
    if (attrs.Status) task.status = String(attrs.Status.value ?? task.status);
    if (attrs.DetailEstimate) task.estimate = Number(attrs.DetailEstimate.value ?? task.estimate);
    if (attrs.ToDo) task.todo = Number(attrs.ToDo.value ?? task.todo);
    if (attrs.Done) task.done = Number(attrs.Done.value ?? task.done);
    if (attrs.Category?.value) task.category = resolveCategoryName(attrs.Category.value) ?? task.category;
    if (attrs.Owners?.value && Array.isArray(attrs.Owners.value)) {
        task.owners = attrs.Owners.value.map((owner: any) => String(owner.idref ?? owner.value ?? owner)).filter(Boolean);
    }
}

export function mockV1Fetch(workspaceDir: string, assetPath: string, queryParams: Record<string, string> = {}) {
    const state = ensureState(workspaceDir);
    if (assetPath === '/Team') {
        const where = queryParams.where ?? '';
        const teamName = where.match(/Name='([^']+)'/)?.[1];
        let teams = state.teams;
        if (teamName) teams = teams.filter(t => t.name === teamName);
        return { Assets: teams.map(t => ({ id: t.id, Attributes: { Name: attr(t.name) } })), Total: teams.length, total: teams.length };
    }
    if (assetPath === '/Member') {
        return { Assets: state.members.map(m => ({ id: m.id, Attributes: { Name: attr(m.name), Nickname: attr(m.nickname ?? ''), Email: attr(m.email ?? '') } })) };
    }
    if (assetPath === '/ClassOfService') {
        return { Assets: state.classOfService.map(c => ({ id: c.id, Attributes: { Name: attr(c.name) } })) };
    }
    if (assetPath === '/PrimaryWorkitem') {
        const number = queryParams.where?.match(/Number='([^']+)'/)?.[1];
        const stories = number ? state.stories.filter(s => s.number === number) : state.stories;
        return { Assets: stories.map(storyAsset), Total: stories.length, total: stories.length };
    }
    if (assetPath === '/Scope') {
        const name = queryParams.where?.match(/Name='([^']+)'/)?.[1] ?? 'Mock Project';
        return { Assets: [{ id: 'Scope:1', Attributes: { Name: attr(name) } }] };
    }
    if (assetPath === '/StoryCategory') {
        return { Assets: [{ id: 'StoryCategory:1', Attributes: { Name: attr('Roadmap Features') } }] };
    }
    if (assetPath === '/Theme') {
        return { Assets: [{ id: 'Theme:1', Attributes: { Name: attr('General') } }] };
    }
    if (['TaskCategory', 'Custom_Environment', 'DefectType', 'StorySource', 'Epic'].includes(assetPath.slice(1))) {
        return { Assets: [{ id: `${assetPath.slice(1)}:1`, Attributes: { Name: attr('Mock') } }] };
    }
    if (assetPath === '/Story') {
        const where = queryParams.where ?? '';
        let stories = state.stories;
        const number = where.match(/Number='([^']+)'/)?.[1];
        const teamName = where.match(/Team\.Name='([^']+)'/)?.[1];
        const scopeName = where.match(/Scope\.Name='([^']+)'/)?.[1];
        const statusName = where.match(/Status\.Name='([^']+)'/)?.[1];
        const text = where.match(/Name~'([^']+)'/)?.[1];
        if (number) stories = stories.filter(s => s.number === number);
        if (teamName) stories = stories.filter(s => s.team === teamName);
        if (scopeName) stories = stories.filter(s => s.scope === scopeName);
        if (statusName) stories = stories.filter(s => s.status === statusName);
        if (text) stories = stories.filter(s => s.name.includes(text));
        return { Assets: stories.map(storyAsset), Total: stories.length, total: stories.length };
    }
    const storyId = assetPath.match(/^\/(?:Story|PrimaryWorkitem)\/?([^/]*)/)?.[1];
    if (storyId) {
        const story = findStory(state, storyId);
        return story ? storyAsset(story) : {};
    }
    if (assetPath === '/Task') {
        const where = queryParams.where ?? '';
        const parent = where.match(/Parent='([^']+)'/)?.[1];
        const number = where.match(/Number='([^']+)'/)?.[1];
        let tasks = state.tasks;
        if (parent) tasks = tasks.filter(t => t.parent === parent);
        if (number) tasks = tasks.filter(t => t.number === number);
        return { Assets: tasks.map(taskAsset), Total: tasks.length, total: tasks.length };
    }
    const taskId = assetPath.match(/^\/Task\/?([^/]*)/)?.[1];
    if (taskId) {
        const task = findTask(state, taskId);
        return task ? taskAsset(task) : {};
    }
    if (assetPath === '/Defect') return { Assets: [], Total: 0, total: 0 };
    return { Assets: [] };
}

export function mockV1Post(workspaceDir: string, assetPath: string, body: Record<string, any>) {
    const state = ensureState(workspaceDir);
    if (assetPath === '/Story') {
        const idNum = ++state.nextStoryId;
        const teamOid = valueFromBody(body, 'Team');
        const teamName = valueFromBody(body, 'Team.Name') || state.teams.find(t => t.id === teamOid)?.name || 'Ninjas';
        const story: MockStory = {
            id: `Story:${idNum}`,
            number: `B-${idNum}`,
            name: valueFromBody(body, 'Name') || 'Mock created story',
            description: valueFromBody(body, 'Description') || '',
            status: 'Ready',
            teamId: teamOid || 'Team:2002',
            team: String(teamName),
            estimate: valueFromBody(body, 'Estimate') ?? null,
            priority: 'Medium',
            scope: String(valueFromBody(body, 'Scope') || 'Mock Project'),
            classOfService: String(valueFromBody(body, 'ClassOfService') || 'Standard'),
            acceptanceCriteria: valueFromBody(body, 'Custom_AcceptanceCriteria') || '',
            frontend: valueFromBody(body, 'Custom_Frontend') || '',
            backend: valueFromBody(body, 'Custom_Backend') || '',
            qa: valueFromBody(body, 'Custom_QA') || '' };
        state.stories.push(story);
        saveState(workspaceDir, state);
        return storyAsset(story);
    }
    if (assetPath === '/Task') {
        const idNum = ++state.nextTaskId;
        const categoryVal = valueFromBody(body, 'Category');
        const categoryName = resolveCategoryName(categoryVal);
        const task: MockTask = {
            id: `Task:${idNum}`,
            number: `TK-LOCAL-${idNum}`,
            name: valueFromBody(body, 'Name') || 'Mock task',
            parent: valueFromBody(body, 'Parent') || '',
            status: 'Future',
            owners: (body.Attributes?.Owners?.value ?? []).map((owner: any) => String(owner.idref ?? owner.value ?? owner)).filter(Boolean),
            estimate: Number(valueFromBody(body, 'DetailEstimate') ?? 0),
            todo: Number(valueFromBody(body, 'DetailEstimate') ?? 0),
            done: 0,
            ...(categoryName ? { category: String(categoryName) } : {}) };
        state.tasks.push(task);
        saveState(workspaceDir, state);
        return taskAsset(task);
    }
    const storyUpdate = assetPath.match(/^\/Story\/([^/]+)$/)?.[1];
    if (storyUpdate) {
        const story = findStory(state, storyUpdate);
        if (!story) return {};
        applyStoryAttributes(story, body);
        saveState(workspaceDir, state);
        return storyAsset(story);
    }
    const taskUpdate = assetPath.match(/^\/Task\/([^/]+)$/)?.[1];
    if (taskUpdate) {
        const task = findTask(state, taskUpdate);
        if (!task) return {};
        applyTaskAttributes(task, body);
        saveState(workspaceDir, state);
        return taskAsset(task);
    }
    return { id: 'Mock:1', Attributes: {} };
}

export function mockV1PostRelation(workspaceDir: string, assetPath: string, body: Record<string, any>) {
    const state = ensureState(workspaceDir);
    const ownerMatch = assetPath.match(/^\/(?:Story|Task)\/([^/]+)\/Owners$/);
    if (!ownerMatch) return { Assets: [] };
    const ownerValues = body.Assets ?? body.value ?? [];
    const owners = Array.isArray(ownerValues)
        ? ownerValues.map((item: any) => String(item.idref ?? item.id ?? item)).filter(Boolean)
        : [];
    const story = findStory(state, ownerMatch[1]);
    if (story) {
        saveState(workspaceDir, state);
        return { Assets: owners.map(id => ({ id })) };
    }
    const task = findTask(state, ownerMatch[1]);
    if (task) {
        task.owners = [...new Set([...task.owners, ...owners])];
        saveState(workspaceDir, state);
        return { Assets: owners.map(id => ({ id })) };
    }
    return { Assets: [] };
}

export function mockV1LookupFetch(workspaceDir: string, assetPath: string, queryParams: Record<string, string> = {}) {
    const state = ensureState(workspaceDir);
    const type = assetPath.replace(/^\//, '');
    const name = parseWhereName(queryParams.where ?? '');
    if (type === 'Team') {
        const teams = firstNamed(state.teams, name);
        return { Assets: teams.map(t => ({ id: t.id, Attributes: { Name: attr(t.name) } })), total: teams.length };
    }
    if (type === 'Member') {
        const nickname = queryParams.where?.match(/Nickname='([^']+)'/)?.[1];
        let members = state.members;
        if (name) members = members.filter(m => m.name === name);
        if (nickname) members = members.filter(m => m.nickname === nickname);
        return { Assets: members.map(m => ({ id: m.id, Attributes: { Name: attr(m.name), Nickname: attr(m.nickname ?? '') } })), total: members.length };
    }
    if (type === 'ClassOfService') {
        const values = firstNamed(state.classOfService, name);
        return { Assets: values.map(c => ({ id: c.id, Attributes: { Name: attr(c.name) } })), total: values.length };
    }
    const defaultName = name || (type === 'Theme' ? 'General' : type === 'StoryCategory' ? 'Roadmap Features' : 'Mock');
    return { Assets: [{ id: `${type}:1`, Attributes: { Name: attr(defaultName), Number: attr(`${type}-1`) } }], total: 1 };
}

export function mockV1Http(workspaceDir: string, method: string, rawPath: string, queryParams: Record<string, string>, body?: Record<string, any>) {
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    if (method === 'GET') {
        const lookupTypes = ['Scope', 'Theme', 'StoryCategory', 'DefectType', 'StorySource', 'Team', 'TaskCategory', 'Custom_Environment', 'ClassOfService', 'Epic', 'Member'];
        if (lookupTypes.includes(path.slice(1))) return mockV1LookupFetch(workspaceDir, path, queryParams);
        return mockV1Fetch(workspaceDir, path, queryParams);
    }
    if (method === 'POST') {
        if (path.endsWith('/Owners')) return mockV1PostRelation(workspaceDir, path, body ?? {});
        return mockV1Post(workspaceDir, path, body ?? {});
    }
    return { error: `Unsupported mock V1 method ${method}` };
}

export function appendMockNotification(workspaceDir: string, title: string, message: string, color?: string) {
    const state = ensureState(workspaceDir);
    state.notifications.push({ timestamp: new Date().toISOString(), title, message, color });
    saveState(workspaceDir, state);
}

/** Update `status` on a mock ADO PR so `/api/reviewer/prs` matches live Azure after merge (build passed in SDLC). */
export function setMockPullRequestStatus(workspaceDir: string, prId: number | string, status: string): void {
    const want = Number(prId);
    if (!Number.isFinite(want) || want <= 0) return;
    const state = ensureState(workspaceDir);
    let found = false;
    for (const pr of state.prs) {
        const row = pr as { pullRequestId?: number; id?: number };
        const id = Number(row.pullRequestId ?? row.id);
        if (id === want) {
            (pr as { status: string }).status = status;
            found = true;
            break;
        }
    }
    if (found) saveState(workspaceDir, state);
}

/** Upsert a mock PR by id (for bridging `/api/pr/created` ids into mock state). */
export function upsertMockPullRequest(workspaceDir: string, prId: number, fields: Record<string, unknown>): Record<string, unknown> {
    const state = ensureState(workspaceDir);
    const existing = state.prs.find(p => Number(p.pullRequestId ?? p.id) === prId);
    if (existing) {
        Object.assign(existing, fields);
        saveState(workspaceDir, state);
        return existing;
    }
    const pr: Record<string, unknown> = {
        pullRequestId: prId,
        id: prId,
        status: 'active',
        createdBy: { id: 'mock-user', displayName: 'Mock User', uniqueName: 'mock.user@example.test' },
        creationDate: new Date().toISOString(),
        ...fields };
    state.prs.push(pr);
    saveState(workspaceDir, state);
    return pr;
}

export function resetMockState(workspaceDir: string): void {
    const file = statePath(workspaceDir);
    writeFileSync(file, JSON.stringify(DEFAULT_STATE, null, 2));
}

export function clearMockTasksForStory(workspaceDir: string, storyOid: string): void {
    const state = ensureState(workspaceDir);
    const before = state.tasks.length;
    state.tasks = state.tasks.filter(t => t.parent !== storyOid);
    if (state.tasks.length !== before) saveState(workspaceDir, state);
}

export function mockAdoFetch(workspaceDir: string, path: string, method = 'GET', body?: unknown) {
    const state = ensureState(workspaceDir);
    if (path.includes('/pullrequests') && method === 'POST') {
        const b = (body as Record<string, unknown>) ?? {};
        const branch = typeof b.sourceRefName === 'string' ? b.sourceRefName : undefined;
        const title = typeof b.title === 'string' ? b.title : undefined;
        const existing = state.prs.find(p => {
            if (String(p.status ?? 'active') !== 'active') return false;
            if (branch && String(p.sourceRefName ?? '') === branch) return true;
            if (title && String(p.title ?? '') === title) return true;
            return false;
        });
        if (existing) {
            Object.assign(existing, b);
            saveState(workspaceDir, state);
            return existing;
        }
        const id = ++state.nextPrId;
        const pr = {
            pullRequestId: id,
            id,
            status: 'active',
            title: title ?? `Mock PR #${id}`,
            createdBy: { id: 'mock-user', displayName: 'Mock User', uniqueName: 'mock.user@example.test' },
            creationDate: new Date().toISOString(),
            ...b };
        state.prs.push(pr);
        saveState(workspaceDir, state);
        return pr;
    }
    if (path.includes('/reviewers/')) {
        return { ok: true };
    }
    if (path.includes('/pipelines/') && path.includes('/runs') && method === 'POST') {
        const id = ++state.nextBuildId;
        const build = { id, status: 'completed', result: 'succeeded', ...(body as Record<string, unknown>) };
        state.builds.push(build);
        saveState(workspaceDir, state);
        return build;
    }
    const buildId = path.match(/\/build\/builds\/(\d+)/)?.[1];
    if (buildId) {
        return state.builds.find(b => String(b.id) === buildId) || { id: Number(buildId), status: 'completed', result: 'succeeded' };
    }
    const prId = path.match(/\/pullrequests\/(\d+)/)?.[1];
    if (prId) {
        return state.prs.find(p => String(p.pullRequestId || p.id) === prId) || { pullRequestId: Number(prId), createdBy: { id: 'mock-user' } };
    }
    if (path.includes('/pullrequests') && method === 'GET') {
        const active = state.prs.filter(p => String(p.status ?? 'active') === 'active');
        return { count: active.length, value: active };
    }
    return { ok: true };
}
