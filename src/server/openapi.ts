/**
 * OpenAPI 3.1 spec for the SDLC Framework API.
 * Auto-served at /api/openapi.json and rendered by Scalar at /.
 */
export const openApiSpec = {
    openapi: '3.1.0',
    info: {
        title: 'SDLC Framework API',
        version: '3.0.0',
        description: 'SDLC automation pipeline — agent orchestration, planning integration, token tracking, and review/build adapters.',
    },
    servers: [
        { url: 'http://localhost:3001', description: 'Local standalone server (Scalar at `/`)' },
        { url: 'http://localhost:3847', description: 'Vite dashboard (proxies `/api/*` and `/mock-v1/*` to the API port)' },
    ],
    tags: [
        { name: 'Status', description: 'Agent status and configuration' },
        { name: 'Workflows', description: 'SQLite SDLC workflow items, phase runner, supervisor, complete-phase' },
        { name: 'Planning', description: 'Planning work item, team, and task operations' },
        { name: 'Scheduler', description: 'Agent workflow scheduling and task management' },
        { name: 'Agents', description: 'Model selection, step mode, continue, hooks, test helpers' },
        { name: 'Reviewer', description: 'Review request pickup and listing for the reviewer agent' },
        { name: 'Handoff', description: 'SDLC pipeline handoff events' },
        { name: 'Tokens', description: 'LLM token usage tracking' },
        { name: 'Chat', description: 'Agent messaging system' },
        { name: 'Help', description: 'In-dashboard help assistant' },
        { name: 'Ollama', description: 'Local LLM management' },
        { name: 'Testing', description: 'Test results, Cypress spec stub, integrated test runner' },
        { name: 'Config', description: 'Project and mode configuration' },
        { name: 'Mock', description: 'Local VersionOne-compatible API (externalMode mock only)' },
    ],
    paths: {
        '/api/status': {
            get: {
                tags: ['Status'],
                summary: 'Get agent status',
                parameters: [{ name: 'agentId', in: 'query', schema: { type: 'string', default: 'frontend' }, description: 'Agent ID (frontend, backend, qa, ux, reviewer, devops)' }],
                responses: { '200': { description: 'Agent status object', content: { 'application/json': { schema: { type: 'object' } } } } },
            },
        },
        '/api/active-project': {
            get: {
                tags: ['Config'],
                summary: 'Get active project profile',
                responses: { '200': { description: 'Active project name, available projects, and profile', content: { 'application/json': { schema: { type: 'object', properties: { active: { type: 'string' }, available: { type: 'array', items: { type: 'string' } }, profile: { type: 'object' } } } } } } },
            },
            put: {
                tags: ['Config'],
                summary: 'Switch active project',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['project'], properties: { project: { type: 'string', example: 'YourProject' } } } } } },
                responses: { '200': { description: 'Updated project profile' } },
            },
        },
        '/api/execution-mode': {
            get: { tags: ['Config'], summary: 'Get execution mode', responses: { '200': { description: 'Current mode', content: { 'application/json': { schema: { type: 'object', properties: { mode: { type: 'string', enum: ['local', 'balanced', 'speed'] } } } } } } } },
            put: {
                tags: ['Config'],
                summary: 'Set execution mode',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['local', 'balanced', 'speed'] } } } } } },
                responses: { '200': { description: 'Updated mode' } },
            },
        },
        '/api/scheduler-mode': {
            get: { tags: ['Config'], summary: 'Get scheduler workflow mode', responses: { '200': { description: 'Current scheduler mode (notify or autonomous)' } } },
            put: {
                tags: ['Config'],
                summary: 'Set scheduler workflow mode',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['notify', 'autonomous'] } } } } } },
                responses: { '200': { description: 'Updated mode' } },
            },
        },
        '/api/external-mode': {
            get: { tags: ['Config'], summary: 'Get external mode (live or mock)', responses: { '200': { description: 'External mode' } } },
            put: {
                tags: ['Config'],
                summary: 'Set external mode',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['mock', 'live'] } } } } } },
                responses: { '200': { description: 'Updated' } },
            },
        },
        '/api/workflows': {
            get: {
                tags: ['Workflows'],
                summary: 'List active workflow items or get one by id',
                parameters: [{ name: 'id', in: 'query', schema: { type: 'integer' }, description: 'Workflow item id (omit to list all active)' }],
                responses: { '200': { description: 'workflow + events + artifacts, or { workflows: [...] }' } },
            },
        },
        '/api/workflows/run-phase': {
            post: {
                tags: ['Workflows'],
                summary: 'Build phase prompt and optionally spawn agent for current workflow phase',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object', properties: {
                        workflowItemId: { type: 'integer' },
                        storyNumber: { type: 'string', description: 'Alternative lookup when workflowItemId omitted' },
                        agentId: { type: 'string', description: 'Optional disambiguator for story lookup' },
                        spawn: { type: 'boolean', default: true },
                    } } } },
                },
                responses: { '200': { description: 'prompt + workflow row' }, '400': { description: 'Missing id' }, '409': { description: 'Orchestrator error' } },
            },
        },
        '/api/workflows/supervise': {
            post: {
                tags: ['Workflows'],
                summary: 'Run supervisor decision on a workflow item',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object', properties: {
                        workflowItemId: { type: 'integer' },
                        storyNumber: { type: 'string' },
                        agentId: { type: 'string' },
                        record: { type: 'boolean', default: true },
                    } } } },
                },
                responses: { '200': { description: 'Supervisor actions' }, '404': { description: 'Workflow not found' } },
            },
        },
        '/api/workflows/complete-phase': {
            post: {
                tags: ['Workflows'],
                summary: 'Complete current SDLC phase and transition workflow (authoritative audit)',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object', required: ['workflowItemId', 'agentId', 'phase', 'nextPhase'], properties: {
                        workflowItemId: { type: 'integer' },
                        agentId: { type: 'string' },
                        phase: { type: 'string', description: 'Must match workflow active_phase / orchestrator id' },
                        nextPhase: { type: 'string' },
                        outputs: { type: 'object', description: 'Phase contract fields' },
                        message: { type: 'string' },
                    } } } },
                },
                responses: {
                    '200': { description: 'ok + workflow row' },
                    '400': { description: 'Invalid request body or unknown phase/agent (fieldErrors)' },
                    '409': { description: 'Transition or output contract rejected (missing keys)' },
                },
            },
        },
        '/api/agent/step-mode/global': {
            get: { tags: ['Agents'], summary: 'Get global step mode', responses: { '200': { description: '{ globalStepMode }' } } },
            post: {
                tags: ['Agents'],
                summary: 'Set or toggle global step mode',
                requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { globalStepMode: { type: 'boolean' } } } } } },
                responses: { '200': { description: 'Updated' } },
            },
        },
        '/api/agent/step-mode/{agentId}': {
            get: {
                tags: ['Agents'],
                summary: 'Per-agent step mode (and global flag for UI)',
                parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
                responses: { '200': { description: '{ agentId, stepMode, globalStepMode }' } },
            },
            post: {
                tags: ['Agents'],
                summary: 'Toggle or set per-agent step mode (blocked while global step mode is on)',
                parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' }, description: 'Agent id path suffix; body.agentId overrides when both are set' }],
                requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { agentId: { type: 'string' }, stepMode: { type: 'boolean' }, enabled: { type: 'boolean' } } } } } },
                responses: {
                    '200': { description: 'Updated' },
                    '409': { description: 'Global step mode is on; turn it off before changing per-agent step mode' },
                },
            },
        },
        '/api/agent/models': {
            get: { tags: ['Agents'], summary: 'List selectable models for the active driver', responses: { '200': { description: '{ models }' } } },
        },
        '/api/agent/model/{agentId}': {
            get: {
                tags: ['Agents'],
                summary: 'Get persisted model id for an agent',
                parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
                responses: { '200': { description: '{ agentId, model }' } },
            },
            post: {
                tags: ['Agents'],
                summary: 'Set model for an agent',
                parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' }, description: 'Agent id path suffix; body.agentId overrides when both are set' }],
                requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { agentId: { type: 'string' }, model: { type: 'string' } } } } } },
                responses: { '200': { description: 'Updated' } },
            },
        },
        '/api/agent/display-names': {
            get: { tags: ['Agents'], summary: 'Custom display names from config', responses: { '200': { description: '{ displayNames }' } } },
            post: {
                tags: ['Agents'],
                summary: 'Set or clear custom display name',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId', 'displayName'], properties: { agentId: { type: 'string' }, displayName: { type: 'string', description: 'Empty string clears' } } } } } },
                responses: { '200': { description: 'Updated' } },
            },
        },
        '/api/agent/continue': {
            post: {
                tags: ['Agents'],
                summary: 'Resume agent from step mode (spawn with continue prompt)',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object', required: ['agentId'], properties: {
                        agentId: { type: 'string' },
                        selectedTaskIds: { type: 'array', items: { type: 'string' } },
                        selectedRequestIds: { type: 'array', items: { type: 'string' } },
                        phaseHint: { type: 'string' },
                    } } } },
                },
                responses: { '200': { description: 'spawn result' } },
            },
        },
        '/api/agent/dismiss-item': {
            post: {
                tags: ['Agents'],
                summary: 'Remove a task or change-request from agent status file',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId', 'itemId'], properties: {
                    agentId: { type: 'string' },
                    itemId: { type: 'string' },
                    itemType: { type: 'string', enum: ['request', 'task'], description: 'Default task' },
                } } } } },
                responses: { '200': { description: 'ok' } },
            },
        },
        '/api/agent/write-status': {
            post: { tags: ['Agents'], summary: 'Test helper: write agent status JSON (mock mode only)', responses: { '200': { description: 'ok' }, '403': { description: 'Not mock mode' } } },
        },
        '/api/agent/write-reviewer-comments': {
            post: { tags: ['Agents'], summary: 'Test helper: seed reviewer PR comments file (mock mode only)', responses: { '200': { description: 'ok' }, '403': { description: 'Not mock mode' } } },
        },
        '/api/hook/agent-stop': {
            post: {
                tags: ['Agents'],
                summary: 'IDE hook: agent stopped; returns followup_message for session injection',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId'], properties: { agentId: { type: 'string' } } } } } },
                responses: { '200': { description: 'followup_message or {}' } },
            },
        },
        '/api/agents/reset-to-idle': {
            post: {
                tags: ['Agents'],
                summary: 'Reset all agent status files to idle (requires confirm phrase)',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'string' } } } } } },
                responses: { '200': { description: 'Reset summary' } },
            },
        },
        '/api/worktrees/sweep': {
            post: {
                tags: ['Config'],
                summary: 'Prune stale git worktrees under configured project workspaces',
                requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { dryRun: { type: 'boolean' }, force: { type: 'boolean' }, repo: { type: 'string' } } } } } },
                responses: { '200': { description: 'removed/skipped counts' } },
            },
        },
        '/api/reviewer/prs': {
            get: {
                tags: ['Reviewer'],
                summary: 'List active review requests for reviewer pickup',
                parameters: [
                    { name: 'projectKey', in: 'query', schema: { type: 'string' } },
                    { name: 'team', in: 'query', schema: { type: 'string' } },
                    { name: 'branchPrefix', in: 'query', schema: { type: 'string' } },
                    { name: 'q', in: 'query', schema: { type: 'string' } },
                ],
                responses: { '200': { description: 'Filtered PR list' }, '400': { description: 'Missing repositoryId' } },
            },
        },
        '/api/reviewer/auto-pick-config': {
            get: {
                tags: ['Reviewer'],
                summary: 'Whether dashboard auto-picks first review adapter list row (scheduler.agents.reviewer.autoPickAdoList only)',
                responses: { '200': { description: '{ autoPickPullRequests, autoPickAdoList, workflowMode, reviewerAutoStart, blockedByStepMode, globalStepMode, reviewerStepMode }' } },
            },
        },
        '/api/reviewer/pick-pr': {
            post: {
                tags: ['Reviewer'],
                summary: 'Assign reviewer desk to a review request',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prId'], properties: { prId: { type: 'number' }, projectKey: { type: 'string' } } } } } },
                responses: { '200': { description: 'ok + pr + spawn flags' } },
            },
        },
        '/api/reviewer/pr-comments': {
            get: {
                tags: ['Reviewer'],
                summary: 'Merged PR comment threads for reviewer feedback panel',
                parameters: [{ name: 'prId', in: 'query', required: true, schema: { type: 'integer' } }],
                responses: { '200': { description: 'threads' }, '400': { description: 'Missing prId' } },
            },
        },
        '/api/reviewer/dismiss-pr': {
            post: {
                tags: ['Reviewer'],
                summary: 'Dismiss a PR row from reviewer pickup / desk eligibility',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prId'], properties: { prId: { type: 'number' } } } } } },
                responses: { '200': { description: 'ok' } },
            },
        },
        '/api/reviewer/clear-desk': {
            post: {
                tags: ['Reviewer'],
                summary: 'Reset reviewer desk to idle (optional prId to clear active pick)',
                requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { prId: { type: 'number' } } } } } },
                responses: { '200': { description: 'ok' }, '409': { description: 'Invalid state' } },
            },
        },
        '/api/reviewer/spawn-from-desk': {
            post: {
                tags: ['Reviewer'],
                summary: 'Spawn reviewer CLI when desk is pending-review (retry / hook)',
                responses: { '200': { description: 'spawned flag' }, '404': { description: 'No desk' }, '409': { description: 'Wrong phase' } },
            },
        },
        '/api/test-results': {
            get: {
                tags: ['Testing'],
                summary: 'Cypress / QA test run history',
                parameters: [
                    { name: 'agentId', in: 'query', schema: { type: 'string' } },
                    { name: 'summary', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Aggregate counts' },
                    { name: 'latest', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Latest run for agentId' },
                ],
                responses: { '200': { description: 'runs, summary, or latest' } },
            },
            post: {
                tags: ['Testing'],
                summary: 'Record a test run',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId', 'specFile'], properties: {
                    agentId: { type: 'string' },
                    specFile: { type: 'string' },
                    passed: { type: 'number' },
                    failed: { type: 'number' },
                    skipped: { type: 'number' },
                    durationMs: { type: 'number' },
                    failures: { type: 'array' },
                } } } } },
                responses: { '200': { description: 'runId' } },
            },
        },
        '/api/project/standards': {
            get: {
                tags: ['Config'],
                summary: 'Discover Cursor rules/skills and key paths for a project workspace',
                parameters: [{ name: 'project', in: 'query', schema: { type: 'string' } }],
                responses: { '200': { description: 'rules, skills, keyPaths' } },
            },
        },
        '/api/test-spec/generate': {
            post: {
                tags: ['Testing'],
                summary: 'Generate stub Cypress spec from story id / AC',
                requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['storyNumber'], properties: { storyNumber: { type: 'string' }, storyName: { type: 'string' }, acceptanceCriteria: { type: 'array', items: { type: 'string' } } } } } } },
                responses: { '200': { description: 'specPath' } },
            },
        },
        '/api/test-runner/scenarios': {
            get: { tags: ['Testing'], summary: 'Built-in PowerShell E2E scenarios', responses: { '200': { description: '{ scenarios }' } } },
        },
        '/api/test-runner/run': {
            post: {
                tags: ['Testing'],
                summary: 'Run a scenario script in background',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['scenarioId'], properties: { scenarioId: { type: 'string' } } } } } },
                responses: { '200': { description: 'pid + logFile' }, '409': { description: 'Already running' } },
            },
        },
        '/api/test-runner/status': {
            get: { tags: ['Testing'], summary: 'Whether a scenario is running', responses: { '200': { description: 'running + metadata' } } },
        },
        '/api/test-runner/log': {
            get: {
                tags: ['Testing'],
                summary: 'Tail test runner log',
                parameters: [{ name: 'file', in: 'query', schema: { type: 'string' }, description: 'Optional absolute log path' }],
                responses: { '200': { description: 'text/plain' }, '400': { description: 'No log' } },
            },
        },
        '/api/test-runner/stop': {
            post: { tags: ['Testing'], summary: 'Kill active test runner child', responses: { '200': { description: 'ok' }, '404': { description: 'None running' } } },
        },
        '/api/help/chat': {
            post: {
                tags: ['Help'],
                summary: 'Help KB / Ollama assistant for the dashboard',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' }, history: { type: 'array' } } } } } },
                responses: { '200': { description: 'answer + source' } },
            },
        },
        '/api/openapi.json': {
            get: { tags: ['Config'], summary: 'OpenAPI 3.1 document (this spec)', responses: { '200': { description: 'JSON' } } },
        },
        '/mock-v1/rest-1.v1/Data/{assetPath}': {
            get: {
                tags: ['Mock'],
                summary: 'Mock planning GET (mock externalMode only)',
                description: 'The server matches any path under `/mock-v1/rest-1.v1/Data`; nested segments appear after the prefix. Scalar may show one path segment in `assetPath`; use the raw URL for multi-segment assets.',
                parameters: [{ name: 'assetPath', in: 'path', required: true, schema: { type: 'string' } }],
                responses: { '200': { description: 'VersionOne-shaped JSON' } },
            },
            post: {
                tags: ['Mock'],
                summary: 'Mock planning POST',
                description: 'See GET for path behavior.',
                parameters: [{ name: 'assetPath', in: 'path', required: true, schema: { type: 'string' } }],
                responses: { '200': { description: 'Created asset' } },
            },
        },
        '/api/user-profile': {
            get: {
                tags: ['Status'],
                summary: 'Get demo user profile (dashboard story DS-99001)',
                responses: { '200': { description: 'Profile fields', content: { 'application/json': { schema: {
                    type: 'object',
                    properties: {
                        displayName: { type: 'string' },
                        email: { type: 'string' },
                        bio: { type: 'string' },
                        avatarUrl: { type: ['string', 'null'] },
                    },
                } } } } },
            },
            put: {
                tags: ['Status'],
                summary: 'Update demo user profile (partial merge)',
                requestBody: {
                    required: false,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    displayName: { type: 'string' },
                                    email: { type: 'string' },
                                    bio: { type: 'string' },
                                    avatarUrl: { type: ['string', 'null'] },
                                },
                            },
                        },
                    },
                },
                responses: { '200': { description: 'Merged profile record' }, '400': { description: 'Invalid JSON body' } },
            },
        },
        '/api/planning/teams': {
            get: { tags: ['Planning'], summary: 'List planning teams', responses: { '200': { description: 'Array of teams', content: { 'application/json': { schema: { type: 'object', properties: { teams: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } } } } } } },
        },
        '/api/planning/stories': {
            get: {
                tags: ['Planning'],
                summary: 'List work items for a team',
                parameters: [
                    { name: 'team', in: 'query', schema: { type: 'string' }, description: 'Team name filter' },
                    { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Status filter' },
                    { name: 'text', in: 'query', schema: { type: 'string' }, description: 'Name text search' },
                    { name: 'maxResults', in: 'query', schema: { type: 'string', default: '20' }, description: 'Max results' },
                ],
                responses: { '200': { description: 'Filtered work items' } },
            },
        },
        '/api/planning/story': {
            get: {
                tags: ['Planning'],
                summary: 'Get work item detail',
                parameters: [
                    { name: 'number', in: 'query', schema: { type: 'string' }, description: 'Work item key (e.g. B-17013)' },
                    { name: 'oid', in: 'query', schema: { type: 'string' }, description: 'Work item OID (alternative to number)' },
                ],
                responses: { '200': { description: 'Full work item detail with description, AC, frontend, backend, QA fields' } },
            },
        },
        '/api/planning/class-of-service': {
            get: { tags: ['Planning'], summary: 'List Class of Service values', responses: { '200': { description: 'CoS values' } } },
        },
        '/api/planning/members': {
            get: { tags: ['Planning'], summary: 'List planning members', responses: { '200': { description: 'Members array' } } },
        },
        '/api/planning/tasks': {
            get: {
                tags: ['Planning'],
                summary: 'List tasks for a work item',
                parameters: [{ name: 'story', in: 'query', required: true, schema: { type: 'string' }, description: 'Work item key' }],
                responses: { '200': { description: 'Tasks for work item' } },
            },
        },
        '/api/planning/create-story': {
            post: {
                tags: ['Planning'],
                summary: 'Create and enrich a new work item',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object', required: ['name', 'classOfService'], properties: {
                        name: { type: 'string', example: 'Add dark mode toggle' },
                        description: { type: 'string' },
                        estimate: { type: 'number' },
                        team: { type: 'string' },
                        owner: { type: 'string' },
                        classOfService: { type: 'string', example: 'Standard' },
                        workspaceDir: { type: 'string', description: 'Optional workspace path for enrichment' },
                        source: { type: 'string', enum: ['local'], description: 'When local, create a SDLC Framework backlog story' },
                        storySource: { type: 'string', enum: ['local'], description: 'Alias for source=local' },
                        enrich: { type: 'boolean', description: 'When true, run Ollama field enrichment (local source path)' },
                        mode: { type: 'string', enum: ['local', 'balanced', 'speed'], description: 'Override execution mode' },
                    } } } },
                },
                responses: { '200': { description: 'Created work item with enrichment results' } },
            },
        },
        '/api/planning/story-status': {
            post: {
                tags: ['Planning'],
                summary: 'Update work item status (e.g. close/release)',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['number', 'status'], properties: { number: { type: 'string' }, status: { type: 'string' } } } } } },
                responses: { '200': { description: 'Status updated' } },
            },
        },
        '/api/planning/tasks/sync': {
            post: {
                tags: ['Planning'],
                summary: 'Sync agent tasks with the planning adapter',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId', 'storyNumber'], properties: { agentId: { type: 'string' }, storyNumber: { type: 'string' } } } } } },
                responses: { '200': { description: 'Merged task list' } },
            },
        },
        '/api/scheduler/assign': {
            post: {
                tags: ['Scheduler'],
                summary: 'Assign a story to an agent',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object', required: ['agentId', 'storyNumber'], properties: {
                        agentId: { type: 'string', example: 'frontend' },
                        storyNumber: { type: 'string', example: 'B-17013' },
                        storyName: { type: 'string' },
                        storyDescription: { type: 'string' },
                        teamId: { type: 'string' },
                        environment: { type: 'string', description: 'Dev-site environment (YourProject only)' },
                    } } } },
                },
                responses: { '200': { description: 'Assignment result with initial phase' } },
            },
        },
        '/api/scheduler/approve': {
            post: {
                tags: ['Scheduler'],
                summary: 'Approve a pending story to start workflow',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId'], properties: { agentId: { type: 'string' } } } } } },
                responses: { '200': { description: 'Approval result' } },
            },
        },
        '/api/scheduler/create-task': {
            post: {
                tags: ['Scheduler'],
                summary: 'Create a planning task under a work item',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId', 'storyNumber', 'name'], properties: { agentId: { type: 'string' }, storyNumber: { type: 'string' }, name: { type: 'string' }, estimate: { type: 'number' } } } } } },
                responses: { '200': { description: 'Created task' } },
            },
        },
        '/api/pr/created': {
            post: {
                tags: ['Handoff'],
                summary: 'PR created handoff — assigns reviewer agent for review',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId', 'prId'], properties: { agentId: { type: 'string' }, prId: { type: 'number' }, prTitle: { type: 'string' }, prUrl: { type: 'string' }, storyNumber: { type: 'string' }, branch: { type: 'string' }, projectKey: { type: 'string', description: 'Active SDLC Framework project key for PR URL resolution' } } } } } },
                responses: { '200': { description: 'Handoff result' } },
            },
        },
        '/api/handoff/review-complete': {
            post: {
                tags: ['Handoff'],
                summary: 'Review complete — approved or changes requested',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prId', 'verdict'], properties: { prId: { type: 'number' }, verdict: { type: 'string', enum: ['approved', 'changes-requested'] }, storyNumber: { type: 'string' }, branch: { type: 'string' }, commentCount: { type: 'number' } } } } } },
                responses: { '200': { description: 'Review handoff result' } },
            },
        },
        '/api/handoff/build-complete': {
            post: {
                tags: ['Handoff'],
                summary: 'Build complete — passed or failed',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prId', 'result'], properties: { prId: { type: 'number' }, result: { type: 'string', enum: ['passed', 'failed'] }, buildId: { type: 'number' } } } } } },
                responses: { '200': { description: 'Build handoff result' } },
            },
        },
        '/api/handoff/design-ready': {
            post: {
                tags: ['Handoff'],
                summary: 'Design spec ready — assigns implementation agent',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['storyNumber'], properties: { storyNumber: { type: 'string' }, storyName: { type: 'string' }, designSpec: { type: 'string' }, targetAgent: { type: 'string' } } } } } },
                responses: { '200': { description: 'Design handoff result' } },
            },
        },
        '/api/handoff/design-review-complete': {
            post: {
                tags: ['Handoff'],
                summary: 'UX design review outcome for parallel PR gate',
                requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { storyNumber: { type: 'string' }, prId: { type: 'number' }, verdict: { type: 'string' } } } } } },
                responses: { '200': { description: 'Handoff result' } },
            },
        },
        '/api/tokens/ledger': {
            get: {
                tags: ['Tokens'],
                summary: 'Get token usage ledger',
                parameters: [{ name: 'story', in: 'query', schema: { type: 'string' }, description: 'Filter by story number' }],
                responses: { '200': { description: 'Token ledger' } },
            },
        },
        '/api/tokens/update': {
            post: {
                tags: ['Tokens'],
                summary: 'Update token counts for an agent',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId', 'source', 'input', 'output'], properties: { agentId: { type: 'string' }, source: { type: 'string', enum: ['cloud', 'ollama'] }, input: { type: 'number' }, output: { type: 'number' } } } } } },
                responses: { '200': { description: 'Updated token state' } },
            },
        },
        '/api/tokens/cloud': {
            post: {
                tags: ['Tokens'],
                summary: 'Update cloud token counts (shorthand)',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { agentId: { type: 'string' }, input: { type: 'number' }, output: { type: 'number' } } } } } },
                responses: { '200': { description: 'Updated token state' } },
            },
        },
        '/api/chat/messages': {
            get: {
                tags: ['Chat'],
                summary: 'Get chat messages for an agent',
                parameters: [{ name: 'agentId', in: 'query', schema: { type: 'string', default: 'frontend' } }],
                responses: { '200': { description: 'Message list' } },
            },
            post: {
                tags: ['Chat'],
                summary: 'Send a message to an agent',
                parameters: [{ name: 'agentId', in: 'query', required: true, schema: { type: 'string' } }],
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } } } } },
                responses: { '200': { description: 'Message sent' } },
            },
        },
        '/api/chat': {
            post: {
                tags: ['Chat'],
                summary: 'Send a chat message with trigger matching',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agentId', 'message'], properties: { agentId: { type: 'string' }, message: { type: 'object', properties: { from: { type: 'string' }, message: { type: 'string' }, text: { type: 'string' } } } } } } } },
                responses: { '200': { description: 'Chat result with trigger info' } },
            },
        },
        '/api/ollama/health': {
            get: { tags: ['Ollama'], summary: 'Ollama health check', responses: { '200': { description: 'Ollama status and model info' } } },
        },
        '/health': {
            get: {
                tags: ['Status'],
                summary: 'Service health check (liveness/readiness)',
                responses: {
                    '200': {
                        description: 'Service is healthy',
                        content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, uptimeSeconds: { type: 'number' }, services: { type: 'object' } } } } },
                    },
                    '500': { description: 'Service is unhealthy', content: { 'application/json': { schema: { type: 'object' } } } },
                },
            },
        },
        '/api/ollama/generate': {
            post: {
                tags: ['Ollama'],
                summary: 'Generate text with local Ollama model',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, model: { type: 'string', default: 'llama3.2:latest' }, system: { type: 'string' }, agentId: { type: 'string' } } } } } },
                responses: { '200': { description: 'Generated text with token counts' } },
            },
        },
        '/api/ollama/reindex': {
            post: {
                tags: ['Ollama'],
                summary: 'Rebuild RAG embedding index',
                requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { workspaceDir: { type: 'string' } } } } } },
                responses: { '200': { description: 'Index rebuild result' } },
            },
        },
        '/api/notify': {
            post: {
                tags: ['Config'],
                summary: 'Send a Teams notification',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' }, color: { type: 'string' } } } } } },
                responses: { '200': { description: 'Notification sent' } },
            },
        },
        '/api/open-assistant': {
            post: { tags: ['Config'], summary: 'Launch the Assistant Electron app', responses: { '200': { description: 'App launched' } } },
        },
    },
};
