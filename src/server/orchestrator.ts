import {
    getSdlcPhaseContract,
    getSdlcWorkflow,
    isAllowedSdlcTransition,
    validateSdlcPhaseOutput,
    type SdlcAgentId,
    type SdlcOutputKey,
    type SdlcPhaseContract,
    type SdlcPhaseId,
} from '../shared/sdlcContracts';
import {
    getDb,
    dbCreateWorkflowItem,
    dbGetPhaseEvents,
    dbGetWorkflowArtifacts,
    dbGetWorkflowItem,
    dbRecordPhaseEvent,
    dbTransitionWorkflowItem,
    dbUpsertWorkflowArtifact,
    type PhaseEventRow,
    type WorkflowArtifactRow,
    type WorkflowItemRow,
} from './db';
import { resolve, isAbsolute } from 'path';
import { parseJsonUtf8File } from './json-file';

export type StoryClassification =
    | 'frontend'
    | 'backend'
    | 'full-stack'
    | 'design-first'
    | 'qa-heavy'
    | 'devops'
    | 'unknown';

export interface StoryForOrchestration {
    number: string;
    name?: string | null;
    description?: string | null;
    frontend?: string | null;
    backend?: string | null;
    qa?: string | null;
    designSpec?: string | null;
    projectKey?: string | null;
    affectedRepo?: string | null;
}

export interface AssignmentDecision {
    classification: StoryClassification;
    primaryAgent: SdlcAgentId;
    collaboratorAgents: SdlcAgentId[];
    startPhase: SdlcPhaseId;
    affectedRepo: string | null;
}

export interface StartWorkflowInput {
    story: StoryForOrchestration;
    externalMode: 'live' | 'mock';
    assignedAgentId?: SdlcAgentId;
}

export interface CompletePhaseInput {
    workflowItemId: number;
    agentId: SdlcAgentId;
    phase: SdlcPhaseId;
    outputs: Partial<Record<SdlcOutputKey, unknown>>;
    nextPhase: SdlcPhaseId;
    message?: string | null;
}

export interface BuildPhasePromptInput {
    workflowItemId: number;
    serverBaseUrl?: string;
    statusFile?: string;
    skillFile?: string | null;
    targetCodebase?: string | null;
}

export interface PhaseRunPlan {
    item: WorkflowItemRow;
    prompt: string;
}

export type SupervisorActionType =
    | 'run-active-phase'
    | 'assign-collaborator'
    | 'wait-for-review'
    | 'start-devops'
    | 'return-to-owner'
    | 'complete'
    | 'no-op';

export interface SupervisorAction {
    type: SupervisorActionType;
    priority: 'low' | 'normal' | 'high';
    agentId?: SdlcAgentId | string;
    phase?: SdlcPhaseId | string;
    reason: string;
    payload?: Record<string, unknown>;
}

export interface SupervisorDecision {
    workflow: WorkflowItemRow;
    actions: SupervisorAction[];
}

export interface OrchestratorResult<T> {
    ok: boolean;
    value?: T;
    error?: string;
    missing?: SdlcOutputKey[];
}

function artifactPayload(artifact: WorkflowArtifactRow): Record<string, unknown> {
    try {
        const parsed = JSON.parse(artifact.payload_json || '{}');
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function hasPhaseStarted(events: PhaseEventRow[], item: WorkflowItemRow): boolean {
    return events.some(e =>
        e.event_type === 'phase-started'
        && e.agent_id === item.active_agent_id
        && e.phase === item.active_phase,
    );
}

/**
 * Returns actions ordered by descending priority (high → normal → low).
 * Multiple actions may be present (e.g., full-stack assign-collaborator + failed-build return-to-owner).
 * Callers should treat the first action as the most urgent and may execute them in sequence.
 */
export function recommendSupervisorActions(
    item: WorkflowItemRow,
    events: PhaseEventRow[],
    artifacts: WorkflowArtifactRow[],
): SupervisorDecision {
    const actions: SupervisorAction[] = [];
    const artifactTypes = new Set(artifacts.map(a => a.artifact_type));

    if (item.status === 'complete' || item.active_phase === 'complete') {
        return {
            workflow: item,
            actions: [{
                type: 'complete',
                priority: 'low',
                agentId: item.active_agent_id,
                phase: item.active_phase,
                reason: `Story ${item.story_number} is already complete.`,
            }],
        };
    }

    if (item.classification === 'full-stack' && !artifacts.some(a => a.artifact_type === 'collaborator' && a.artifact_key === 'frontend')) {
        actions.push({
            type: 'assign-collaborator',
            priority: 'high',
            agentId: 'frontend',
            phase: getSdlcWorkflow('frontend').start,
            reason: 'Full-stack story needs a frontend collaborator workflow.',
            payload: { storyNumber: item.story_number, primaryAgent: item.active_agent_id },
        });
    }

    if (item.active_phase === 'watching-reviews' && !artifactTypes.has('review')) {
        actions.push({
            type: 'wait-for-review',
            priority: 'normal',
            agentId: item.active_agent_id,
            phase: item.active_phase,
            reason: 'PR is registered but no review artifact has been recorded yet.',
            payload: { storyNumber: item.story_number },
        });
    }

    const failedBuild = artifacts
        .filter(a => a.artifact_type === 'build')
        .map(a => artifactPayload(a))
        .find(payload => payload.result === 'failed');
    if (failedBuild && !['validating', 'addressing-feedback', 'error'].includes(item.active_phase)) {
        actions.push({
            type: 'return-to-owner',
            priority: 'high',
            agentId: item.active_agent_id,
            phase: 'validating',
            reason: 'A failed build artifact exists and the story is not back in a fix/validation phase.',
            payload: { storyNumber: item.story_number, build: failedBuild },
        });
    }

    if (item.active_agent_id === 'devops' && item.active_phase === 'pending-build') {
        actions.push({
            type: 'start-devops',
            priority: 'high',
            agentId: 'devops',
            phase: 'pending-build',
            reason: 'Review approval routed this story to the DevOps build gate.',
            payload: { storyNumber: item.story_number },
        });
    }

    if (!hasPhaseStarted(events, item)) {
        actions.push({
            type: 'run-active-phase',
            priority: 'normal',
            agentId: item.active_agent_id,
            phase: item.active_phase,
            reason: 'Active phase has not been started through the contract phase runner.',
            payload: { workflowItemId: item.id },
        });
    }

    if (actions.length === 0) {
        actions.push({
            type: 'no-op',
            priority: 'low',
            agentId: item.active_agent_id,
            phase: item.active_phase,
            reason: 'No supervisor action is needed for the current workflow state.',
        });
    }

    const priorityOrder = { high: 0, normal: 1, low: 2 };
    actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
    return { workflow: item, actions };
}

export function superviseWorkflow(workflowItemId: number): OrchestratorResult<SupervisorDecision> {
    const item = dbGetWorkflowItem(workflowItemId);
    if (!item) return { ok: false, error: `Workflow item ${workflowItemId} not found` };
    return {
        ok: true,
        value: recommendSupervisorActions(
            item,
            dbGetPhaseEvents(workflowItemId),
            dbGetWorkflowArtifacts(workflowItemId),
        ),
    };
}

function formatKeyList(keys: readonly string[]): string {
    return keys.length ? keys.map(k => `- ${k}`).join('\n') : '- none';
}

/** Maps each output key to the one-of group it belongs to (if any). */
function oneOfGroupFor(contract: SdlcPhaseContract, key: SdlcOutputKey): readonly SdlcOutputKey[] | undefined {
    return contract.producesOneOf?.find(group => group.includes(key));
}

/**
 * The produced-keys list shown in the prompt, annotating mode-alternative keys so
 * the model isn't told to supply two mutually-exclusive outputs (e.g. pr + mockPr).
 */
function producedKeyHints(contract: SdlcPhaseContract): string[] {
    return contract.produces.map(key => {
        const group = oneOfGroupFor(contract, key);
        if (!group) return key;
        const others = group.filter(k => k !== key);
        return `${key} (provide this OR ${others.join(' / ')}, not both)`;
    });
}

/**
 * The example outputs payload. Keys in a one-of group are rendered as alternatives
 * so the contract's "at least one" rule is obvious from the skeleton alone.
 */
function buildOutputsSkeleton(contract: SdlcPhaseContract): Record<string, string> {
    return Object.fromEntries(contract.produces.map(key => {
        const group = oneOfGroupFor(contract, key);
        const hint = group ? `<one of: ${group.join(' | ')}>` : '<required>';
        return [key, hint];
    }));
}

function phaseSpecificInstructions(item: WorkflowItemRow, serverBaseUrl: string, priorValidationFailure?: string, reviewFeedback?: string, analysisPlan?: string): string {
    if (item.active_phase === 'addressing-feedback') {
        return [
            ...(reviewFeedback ? [
                '⚠️ THE REVIEWER REQUESTED CHANGES. Address EXACTLY these comments:',
                '```',
                reviewFeedback.trim(),
                '```',
                '',
            ] : ['The reviewer requested changes — read your status file `requests` for the comments.', '']),
            'Addressing-feedback phase:',
            '- Make the MINIMAL change to resolve each comment above (usually a wrong',
            '  route/name/value or a missing piece) — do NOT rewrite working code.',
            '- Edit files in your worktree with edit_file, then call run_validation.',
            '- When validation passes, call complete_phase so the fix flows back through review.',
        ].join('\n');
    }

    if (item.active_phase === 'reading-story') {
        return [
            'Phase 1 tasking requirements:',
            `- Fetch or read story ${item.story_number} before planning.`,
            `- Create/refine implementation tasks by calling the create_task tool (it handles the API call for you).`,
            '- Call create_task{name, estimate} once per task.',
            '- Use the returned task numbers as taskIds.',
            '- Include tasks, taskIds, affected repo, branch plan, test matrix, risks, open questions, and auditEvent in the completion payload.',
        ].join('\n');
    }

    if (item.active_phase === 'analyzing') {
        return [
            'Analyzing phase — find the REAL files, then write a grounded PLAN. No code yet.',
            'Two failures get PRs rejected: (a) changing one file and missing another it touches,',
            'and (b) editing files that DO NOT EXIST. Your plan must name ONLY files you have',
            'actually opened or found in THIS repo — never a guessed or conventional path.',
            '',
            '1. read_file the status file for the story + task list.',
            '2. Locate the real file(s). Use search_in_files / grep for the EXACT route, path, or',
            '   symbol the story names (e.g. search the literal "/health"). The search results give',
            '   you the TRUE paths — do NOT assume a layout like src/routes/ or src/tests/; use what',
            '   the search actually returns. Then search for anything else that references that symbol',
            '   (a test, a spec) and read it ONLY if the search actually finds it. Reads here come back',
            '   SUMMARIZED (cheap), so read each file the search turned up.',
            '3. complete_phase with `code_changes` = an explicit PLAN, one line per REAL file to change:',
            '       PLAN:',
            '       - <exact path you opened>: <the exact change>',
            '   Plan rules — follow strictly:',
            '   - List ONLY paths you actually opened with read_file or that appeared in search_in_files',
            '     results. If you did not see a path in this repo, do NOT put it in the plan.',
            '   - If the search found NO test or spec for the symbol, do NOT invent one — many repos',
            '     have neither, and a made-up test/spec path is itself a rejection.',
            '   - It is correct for the plan to be a single file if that is all that references the symbol.',
            'DO NOT write code or prose — produce the PLAN as code_changes.',
            'STRICT LIMIT: complete_phase within your first 10 tool calls. Find → plan → complete_phase.',
        ].join('\n');
    }

    if (item.active_phase === 'validating') {
        return [
            'Validating phase — READ-ONLY. Exactly two tool calls:',
            '1. Call run_validation. The framework runs the type-check, build, and tests for you and returns a PASS/FAIL report — you do NOT run npm, tsc, or git yourself.',
            '2. Call complete_phase, copying run_validation\'s results into validation_results, test_results, and static_analysis:',
            '   - If the report says OVERALL: PASSED → next_phase="committing".',
            '   - If it says OVERALL: FAILED → next_phase="generating-code" and put the failing checks into risks (the developer will fix them).',
            'CRITICAL: Do NOT call write_file or modify ANY files, and do NOT try to fix failures here — that is the generating-code phase.',
            'DO NOT describe what you plan to do. Call run_validation immediately.',
        ].join('\n');
    }

    if (item.active_phase === 'generating-code') {
        // The plan made in analyzing (read-broadly → file:change list). Execute it instead of
        // re-researching from scratch — and crucially, edit EVERY file it names (incl. the test),
        // which is the fix for the 8B's narrow-execution failure (changes the route, forgets the test).
        const planBlock = analysisPlan && analysisPlan.trim()
            ? [
                '📋 EXECUTE THE PLAN YOU MADE IN ANALYZING — edit EVERY file it lists, including the test:',
                '```',
                analysisPlan.trim(),
                '```',
                'Do NOT stop after the implementation file. If the plan lists a test or spec, change those too —',
                'a PR that updates the code but not its test is the most common rejection. You already did the',
                'research in analyzing; spend your calls here EDITING, not re-reading.',
                '',
            ]
            : [];
        const priorFailureBlock = priorValidationFailure
            ? [
                '⚠️ YOUR PREVIOUS ATTEMPT FAILED VALIDATION. Fix EXACTLY these errors:',
                '```',
                priorValidationFailure.trim(),
                '```',
                'Make the MINIMAL change needed to resolve the errors above — they are usually a',
                'missing import or a typo, NOT a reason to rewrite working code. In particular, every',
                'name you reference (e.g. readFileSync) MUST be imported at the top of the file; if an',
                'error says a name is not defined, add it to the existing import from its module.',
                'After editing, call run_validation again to confirm the errors are gone.',
                '',
            ]
            : [];
        const storyContract = item.story_name
            ? [
                '🎯 IMPLEMENT EXACTLY WHAT THE STORY ASKS — this is the contract the reviewer grades you on:',
                `   STORY: ${item.story_name}`,
                '   Use the EXACT route/path, HTTP method, identifier names, and response shape the story',
                '   states. Do NOT invent a different or generic name, and do NOT return a placeholder',
                '   response. If what you build does not match the story, the PR will be rejected.',
                '',
            ]
            : [];
        return [
            ...planBlock,
            ...priorFailureBlock,
            ...storyContract,
            'Generating-code phase:',
            '',
            '## Research first — then edit (LIMIT research to 5 calls)',
            '',
            'You have at most **5 research calls** (read_file, search_in_files/grep, list_directory) total.',
            'After 5 research calls you MUST write code — even if you are not 100% sure of the patterns.',
            '',
            '### Recommended plan (use for any language/framework):',
            '',
            'Step 1 — Discover the tech stack (1-2 calls):',
            '  Read the project\'s package.json (or Cargo.toml, pyproject.toml, Gemfile, go.mod)',
            '  to find the language, framework, and test runner.',
            '',
            'Step 2 — Read the entry point (1-2 calls):',
            '  Read the main server file (index.ts, main.rs, app.py, main.go, server.js)',
            '  to understand route patterns, import style, and error handling conventions.',
            '',
            'Step 3 — Search for patterns (1 call):',
            '  Search for existing route definitions so your code matches the project style.',
            '',
            'Step 4 — Write code:',
            '  Use **edit_file** on existing files (it replaces an exact snippet).',
            '  **CRITICAL: NEVER use write_file on an existing file** — it will destroy the entire file.',
            '  Use **write_file** only for NEW files.',
            '  write_file and edit_file automatically redirect into your git worktree.',
            '',
            'Step 4b — TypeScript strict-mode conventions (rules, NOT code to copy):',
            '  Write the route THIS story requires. The notes below are conventions to follow,',
            '  not a snippet to paste — there is deliberately no full handler example here.',
            '  - Handler params: write `(_req, res)` with NO type annotations (TypeScript infers',
            '    them from the app.get/app.post overload). Never `(req: Request, res: Response)`.',
            '  - Every identifier you reference MUST be defined or imported in the same file',
            '    (e.g. to read package.json, import `readFileSync` and parse it into a variable',
            '    you declare — do not reference an undefined `pkg`).',
            '  - Match the path, method, and response shape from the story contract above — exactly.',
            '  - Add the route the story specifies (NOT a generic/placeholder name) before the',
            '    `export { app }` line; do NOT rewrite the whole file.',
            '',
            'Step 5 — Call **complete_phase** after writing all files.',
            '',
            'CRITICAL: After 5 research calls, stop researching and start writing.',
            'If you research more than 5 times you are wasting time.',
        ].join('\n');
    }

    if (item.active_phase === 'committing') {
        return [
            'Committing phase:',
            '',
            '## Do NOT run any git commands — the framework handles git automatically',
            '',
            'The framework will automatically run `git add` and `git commit` when complete_phase succeeds.',
            'Do NOT call run_command with git commands. Do NOT run git worktree add, git add, git commit, etc.',
            '',
            'Just call: complete_phase with next_phase="creating-pr"',
            '',
            'If there are no changes committed, the phase will fail — go back to generating-code.',
        ].join('\n');
    }

    if (item.active_phase === 'creating-pr') {
        return [
            'Creating-PR phase:',
            '',
            '## Do NOT run any git commands — the framework handles PR creation automatically',
            '',
            'The framework will automatically push the branch and create the PR (or mock PR in mock mode).',
            'Do NOT call run_command with git/gh commands. Do NOT call http_request to create a PR manually.',
            '',
            'Just call: complete_phase with next_phase="watching-reviews"',
        ].join('\n');
    }

    return '';
}

export function buildPhaseRunPrompt(input: BuildPhasePromptInput): OrchestratorResult<PhaseRunPlan> {
    const item = dbGetWorkflowItem(input.workflowItemId);
    if (!item) return { ok: false, error: `Workflow item ${input.workflowItemId} not found` };

    const agentId = item.active_agent_id as SdlcAgentId;
    const phase = item.active_phase as SdlcPhaseId;
    const contract = getSdlcPhaseContract(phase);
    const workflow = getSdlcWorkflow(agentId);
    if (!workflow.phases.includes(phase)) {
        return { ok: false, error: `${agentId} workflow does not include phase ${phase}` };
    }
    if (!contract.ownerAgents.includes(agentId)) {
        return { ok: false, error: `${agentId} cannot own phase ${phase}` };
    }

    const serverBaseUrl = input.serverBaseUrl ?? 'http://localhost:3001';
    const statusFile = input.statusFile ?? `.${agentId}-status.json`;
    // skillFile defaults to the standard path, but passing null explicitly suppresses it
    const skillFile = input.skillFile !== null ? (input.skillFile ?? `skills/${agentId}/SKILL.md`) : null;
    const nextPhases = workflow.transitions[phase] ?? contract.allowedNext;
    // On a re-entry into generating-code after a failed validation, surface the exact
    // errors (captured by run_validation) so the model targets the fix instead of
    // blindly regenerating the same broken code.
    let priorValidationFailure: string | undefined;
    let analysisPlan: string | undefined;
    if (phase === 'generating-code') {
        try {
            const sfPath = isAbsolute(statusFile) ? statusFile : resolve(process.cwd(), statusFile);
            const s = parseJsonUtf8File(sfPath) as Record<string, unknown>;
            if (typeof s.lastValidationFailure === 'string' && s.lastValidationFailure.trim()) {
                priorValidationFailure = s.lastValidationFailure;
            }
            // The plan persisted at the end of analyzing — surface it so generating-code
            // executes it (edits every affected file) instead of re-researching.
            if (typeof s.analysisPlan === 'string' && s.analysisPlan.trim()) {
                analysisPlan = s.analysisPlan;
            }
        } catch { /* no prior failure / plan recorded — first attempt */ }
    }
    // On a rework after the reviewer requested changes, surface the open review
    // comments (applyReviewComplete stored them in status.requests) so the dev fixes
    // exactly what the reviewer flagged instead of guessing.
    let reviewFeedback: string | undefined;
    if (phase === 'addressing-feedback') {
        try {
            const sfPath = isAbsolute(statusFile) ? statusFile : resolve(process.cwd(), statusFile);
            const s = parseJsonUtf8File(sfPath) as Record<string, unknown>;
            const reqs = Array.isArray(s.requests) ? s.requests as Array<Record<string, unknown>> : [];
            const open = reqs.filter(r => r.type === 'review' && r.status === 'open');
            if (open.length > 0) {
                reviewFeedback = open.map((r, i) => {
                    const loc = r.file ? ` (${r.file}${r.line ? `:${r.line}` : ''})` : '';
                    const sev = r.severity ? `[${String(r.severity).toUpperCase()}] ` : '';
                    return `${i + 1}. ${sev}${String(r.summary ?? '').trim()}${loc}`;
                }).join('\n');
            }
        } catch { /* no review feedback recorded */ }
    }
    const prompt = [
        `You are ${agentId}. Run SDLC phase "${phase}" for story ${item.story_number}.`,
        '',
        'Read first:',
        `- ${statusFile}`,
        skillFile ? `- ${skillFile}` : null,
        input.targetCodebase ? `- Target codebase: ${input.targetCodebase}` : null,
        (input.targetCodebase || agentId === 'qa')
            ? item.external_mode === 'mock'
                ? `- Mock mode: do NOT create git worktrees. Work directly in the main repo. ` +
                  `Simulated changes only - do not commit or push to any remote.`
                : `- Worktree isolation is required: work inside a git worktree, not the main repo root.\n` +
                  `  Suggested worktree path: .claude/worktrees/${agentId}-${item.story_number}\n` +
                  `  Create (new branch):   git worktree add -b <branch> .claude/worktrees/${agentId}-${item.story_number} <base>\n` +
                  `  Attach (existing):     git worktree add .claude/worktrees/${agentId}-${item.story_number} <branch>\n` +
                  `  Run all git commands (commit, push, status) from inside that worktree directory.\n` +
                  `  The main working tree belongs to the developer's active IDE session - never modify it directly.\n` +
                  `  NOTE: write_file and edit_file automatically redirect into the worktree — you do not need to do anything special.`
            : null,
        '',
        `Purpose: ${contract.purpose}`,
        '',
        'Required context keys:',
        formatKeyList(contract.requires),
        '',
        'You must produce these output keys exactly:',
        formatKeyList(producedKeyHints(contract)),
        '',
        'Gates before completing the phase:',
        formatKeyList(contract.gates),
        '',
        phaseSpecificInstructions(item, serverBaseUrl, priorValidationFailure, reviewFeedback, analysisPlan),
        '',
        'When the phase is complete, POST this contract payload:',
        `${serverBaseUrl}/api/workflows/complete-phase`,
        JSON.stringify({
            workflowItemId: item.id,
            agentId,
            phase,
            nextPhase: nextPhases[0] ?? 'complete',
            outputs: buildOutputsSkeleton(contract),
            message: '<short phase summary>',
        }, null, 2),
        '',
        `Allowed next phases: ${nextPhases.join(', ') || 'none'}`,
        'Do not update workflow phase by editing JSON directly; use the completion endpoint so the SQLite audit trail remains authoritative.',
    ].filter(Boolean).join('\n');

    return { ok: true, value: { item, prompt } };
}

export function startPhaseRun(input: BuildPhasePromptInput): OrchestratorResult<PhaseRunPlan> {
    const plan = buildPhaseRunPrompt(input);
    if (!plan.ok || !plan.value) return plan;
    dbRecordPhaseEvent({
        workflowItemId: plan.value.item.id,
        agentId: plan.value.item.active_agent_id,
        phase: plan.value.item.active_phase,
        eventType: 'phase-started',
        outputs: { auditEvent: { promptContract: true } },
        message: `Started ${plan.value.item.active_agent_id}/${plan.value.item.active_phase}`,
    });
    return plan;
}

function hasWork(value: string | null | undefined): boolean {
    if (!value) return false;
    const normalized = value.replace(/<[^>]+>/g, '').trim().toLowerCase();
    return Boolean(normalized) && normalized !== 'n/a' && normalized !== 'none';
}

export function classifyStory(story: StoryForOrchestration): AssignmentDecision {
    const hasFrontend = hasWork(story.frontend);
    const hasBackend = hasWork(story.backend);
    const hasQa = hasWork(story.qa);
    const hasDesign = hasWork(story.designSpec) || /\b(figma|design|ux|prototype|wireframe)\b/i.test(`${story.name ?? ''} ${story.description ?? ''}`);
    const mentionsDevops = /\b(devops|pipeline|build|deploy|helm|docker|ci|cd)\b/i.test(`${story.name ?? ''} ${story.description ?? ''} ${story.backend ?? ''}`);

    if (hasDesign) {
        return {
            classification: 'design-first',
            primaryAgent: 'ux',
            collaboratorAgents: [hasBackend ? 'backend' : 'frontend'].filter(Boolean) as SdlcAgentId[],
            startPhase: getSdlcWorkflow('ux').start,
            affectedRepo: story.affectedRepo ?? null,
        };
    }

    if (hasFrontend && hasBackend) {
        return {
            classification: 'full-stack',
            primaryAgent: 'backend',
            collaboratorAgents: ['frontend'],
            startPhase: getSdlcWorkflow('backend').start,
            affectedRepo: story.affectedRepo ?? null,
        };
    }

    if (mentionsDevops && !hasFrontend && !hasBackend) {
        return {
            classification: 'devops',
            primaryAgent: 'devops',
            collaboratorAgents: [],
            startPhase: getSdlcWorkflow('devops').start,
            affectedRepo: story.affectedRepo ?? null,
        };
    }

    if (hasBackend) {
        return {
            classification: 'backend',
            primaryAgent: 'backend',
            collaboratorAgents: hasQa ? ['qa'] : [],
            startPhase: getSdlcWorkflow('backend').start,
            affectedRepo: story.affectedRepo ?? null,
        };
    }

    if (hasQa && !hasFrontend) {
        return {
            classification: 'qa-heavy',
            primaryAgent: 'qa',
            collaboratorAgents: [],
            startPhase: getSdlcWorkflow('qa').start,
            affectedRepo: story.affectedRepo ?? null,
        };
    }

    // No discipline fields were pre-tagged. Infer the specialist from the story
    // text the same way design/devops already do — so a plain story like
    // "Add a GET /health route" routes to backend, not the frontend default.
    // Truly ambiguous stories stay `unknown` so the caller can escalate to an
    // LLM triage step (orchestrator/reviewer run cloud-first, local-second).
    const text = `${story.name ?? ''} ${story.description ?? ''}`;
    const mentionsBackend = /\b(route|endpoint|api|server|handler|controller|middleware|migration|schema|database|sql|query|auth|token|webhook|cron|job|service)\b/i.test(text);
    const mentionsFrontend = /\b(component|page|ui|css|style|button|form|modal|dialog|render|view|layout|responsive|accessibility|a11y|screen)\b/i.test(text);
    const mentionsQaText = /\b(test|tests|cypress|e2e|coverage|regression|qa)\b/i.test(text);

    if (mentionsBackend && !mentionsFrontend) {
        return {
            classification: 'backend',
            primaryAgent: 'backend',
            collaboratorAgents: hasQa || mentionsQaText ? ['qa'] : [],
            startPhase: getSdlcWorkflow('backend').start,
            affectedRepo: story.affectedRepo ?? null,
        };
    }
    if (mentionsFrontend && !mentionsBackend) {
        return {
            classification: 'frontend',
            primaryAgent: 'frontend',
            collaboratorAgents: hasQa || mentionsQaText ? ['qa'] : [],
            startPhase: getSdlcWorkflow('frontend').start,
            affectedRepo: story.affectedRepo ?? null,
        };
    }
    if (mentionsQaText && !mentionsBackend && !mentionsFrontend) {
        return {
            classification: 'qa-heavy',
            primaryAgent: 'qa',
            collaboratorAgents: [],
            startPhase: getSdlcWorkflow('qa').start,
            affectedRepo: story.affectedRepo ?? null,
        };
    }

    return {
        classification: hasFrontend ? 'frontend' : 'unknown',
        primaryAgent: 'frontend',
        collaboratorAgents: hasQa ? ['qa'] : [],
        startPhase: getSdlcWorkflow('frontend').start,
        affectedRepo: story.affectedRepo ?? null,
    };
}

// Agents that can be the primary owner of implementation work (reviewer/orchestrator excluded).
const TRIAGE_AGENTS: SdlcAgentId[] = ['backend', 'frontend', 'qa', 'ux', 'devops'];

export interface TriageOptions {
    /** Injectable completion fn (defaults to the cloud-first→local brain model). Lets tests run offline. */
    chat?: (prompt: string) => Promise<string>;
    /** Config path used to resolve the brain model when `chat` is not provided. */
    configPath?: string;
}

function parseTriageAgent(raw: string): SdlcAgentId | null {
    const lc = (raw || '').toLowerCase();
    for (const agent of TRIAGE_AGENTS) {
        if (new RegExp(`\\b${agent}\\b`).test(lc)) return agent;
    }
    return null;
}

/**
 * Ask the brain model (cloud-first, local-second) which specialist owns a story.
 * Returns null on any failure so callers fall back deterministically.
 */
export async function triageStoryAgent(story: StoryForOrchestration, opts?: TriageOptions): Promise<SdlcAgentId | null> {
    const chat = opts?.chat ?? (async (p: string) => {
        const { smartChat } = await import('./brainModel');
        return smartChat(p, opts?.configPath ?? '.sdlc-framework.config.json');
    });
    const prompt =
        'You are an engineering tech lead routing a user story to exactly ONE specialist agent.\n' +
        `Options: ${TRIAGE_AGENTS.join(', ')}.\n` +
        'Reply with ONLY the single agent name, nothing else.\n\n' +
        `Story: ${story.name ?? ''}\n${story.description ?? ''}`;
    let raw = '';
    try { raw = await chat(prompt); } catch { return null; }
    return parseTriageAgent(raw);
}

/**
 * The orchestrator's authoritative "who does this work" decision:
 * deterministic heuristic first ({@link classifyStory}), LLM triage when the
 * heuristic is ambiguous (`classification: 'unknown'`), and frontend as the
 * final fallback. This is what the assign flow should use when a caller did not
 * specify a valid specialist.
 */
export async function resolveStoryAgent(story: StoryForOrchestration, opts?: TriageOptions): Promise<SdlcAgentId> {
    const decision = classifyStory(story);
    if (decision.classification !== 'unknown') return decision.primaryAgent;
    const triaged = await triageStoryAgent(story, opts);
    return triaged ?? decision.primaryAgent;
}

export function startWorkflow(input: StartWorkflowInput): OrchestratorResult<{ item: WorkflowItemRow; decision: AssignmentDecision }> {
    const inferred = classifyStory(input.story);
    const decision = input.assignedAgentId
        ? {
            ...inferred,
            primaryAgent: input.assignedAgentId,
            // Remove the overridden agent from collaborators to prevent self-collaboration
            collaboratorAgents: inferred.collaboratorAgents.filter(a => a !== input.assignedAgentId),
            startPhase: getSdlcWorkflow(input.assignedAgentId).start,
        }
        : inferred;
    const item = dbCreateWorkflowItem({
        storyNumber: input.story.number,
        storyName: input.story.name ?? null,
        classification: decision.classification,
        activeAgentId: decision.primaryAgent,
        activePhase: decision.startPhase,
        affectedRepo: decision.affectedRepo,
        projectKey: input.story.projectKey ?? null,
        externalMode: input.externalMode,
    });

    dbRecordPhaseEvent({
        workflowItemId: item.id,
        agentId: 'orchestrator',
        phase: 'story-intake',
        eventType: 'assigned',
        outputs: {
            story: input.story,
            classification: decision.classification,
            affectedRepo: decision.affectedRepo,
            handoff: {
                primaryAgent: decision.primaryAgent,
                collaborators: decision.collaboratorAgents,
                startPhase: decision.startPhase,
            },
            auditEvent: { externalMode: input.externalMode },
        },
        message: `Assigned ${input.story.number} to ${decision.primaryAgent}`,
    });

    return { ok: true, value: { item, decision } };
}

/**
 * Phases that mean "go back and rework" rather than advance. A `validating` phase
 * whose own evidence reports PASSED must not bounce back to one of these — that's a
 * model misnavigation (observed with the local 14B: it received OVERALL: PASSED yet
 * set next_phase="generating-code"), which stalls the story until the auto-resume
 * retry cap trips. The guard is deterministic and server-side, so it holds for any
 * driver/model and costs no tokens.
 */
const REWORK_PHASES = new Set<SdlcPhaseId>(['generating-code', 'analyzing', 'reading-story']);

/**
 * Anti-error-escape guard (dev-side 14B flakiness). When the local 14B can't satisfy a
 * phase contract it tends to bail by routing next_phase="error", which permanently kills
 * a story over a single confused turn (observed: a backend agent that couldn't produce
 * the reading-story tasking contract completed the phase to "error" instead of advancing
 * to "analyzing"). An implementation agent has no business self-terminating an early dev
 * phase: "error" is for genuinely unrecoverable states, and a real failure still resurfaces
 * when the coerced-forward phase re-attempts and re-fails. So we refuse a spurious "error"
 * from these phases and coerce to the phase's canonical forward transition. Deterministic
 * and server-side, like the forward-progress guard.
 */
const ERROR_ESCAPE_GUARDED_PHASES = new Set<SdlcPhaseId>(['reading-story', 'analyzing', 'generating-code']);
const IMPLEMENTATION_AGENTS = new Set<SdlcAgentId>(['frontend', 'backend', 'qa', 'ux']);

/**
 * True only when the validating-phase evidence positively reports PASSED with no
 * FAILED signal. Conservative: if the evidence is absent or ambiguous we return
 * false so a genuine FAILED → generating-code rework route is never overridden.
 */
function validationEvidencePassed(outputs: Partial<Record<SdlcOutputKey, unknown>>): boolean {
    const evidence = (['validationResults', 'testResults', 'staticAnalysis'] as SdlcOutputKey[])
        .map((k) => outputs[k])
        .filter((v): v is string => typeof v === 'string')
        .join('\n');
    if (!evidence) return false;
    if (/\bFAILED\b/i.test(evidence)) return false;
    return /\bPASSED\b/i.test(evidence);
}

export function completePhase(input: CompletePhaseInput): OrchestratorResult<WorkflowItemRow> {
    const item = dbGetWorkflowItem(input.workflowItemId);
    if (!item) return { ok: false, error: `Workflow item ${input.workflowItemId} not found` };
    if (item.active_agent_id !== input.agentId) {
        return { ok: false, error: `Workflow item is assigned to ${item.active_agent_id}, not ${input.agentId}` };
    }
    if (item.active_phase !== input.phase) {
        return { ok: false, error: `Workflow item is in ${item.active_phase}, not ${input.phase}` };
    }

    const outputValidation = validateSdlcPhaseOutput(input.phase, input.outputs);
    if (!outputValidation.ok) {
        return { ok: false, error: `Phase ${input.phase} output contract is incomplete`, missing: outputValidation.missing };
    }

    // Forward-progress guard: a validating phase that passed may not route backward.
    let effectiveNextPhase = input.nextPhase;
    let guardNote: string | null = null;
    let guardLabel: string | null = null;
    if (input.phase === 'validating' && REWORK_PHASES.has(input.nextPhase) && validationEvidencePassed(input.outputs)) {
        effectiveNextPhase = 'committing';
        guardLabel = 'forward-progress guard';
        guardNote = `Forward-progress guard: validation reported PASSED, so '${input.phase}' was not allowed to return to '${input.nextPhase}'. Advanced to '${effectiveNextPhase}'.`;
        console.warn(`[forward-progress] ${input.agentId}: validating PASSED but next_phase='${input.nextPhase}' — coerced to '${effectiveNextPhase}'`);
    }

    // Anti-error-escape guard: an implementation agent may not self-terminate an early
    // dev phase to 'error'. Coerce to that phase's canonical forward transition (the first
    // non-error allowedNext) so a single confused turn can't kill the story.
    if (input.nextPhase === 'error'
        && IMPLEMENTATION_AGENTS.has(input.agentId)
        && ERROR_ESCAPE_GUARDED_PHASES.has(input.phase)) {
        const forward = getSdlcPhaseContract(input.phase).allowedNext.find((p) => p !== 'error');
        if (forward) {
            effectiveNextPhase = forward;
            guardLabel = 'anti-error guard';
            guardNote = `Anti-error guard: '${input.agentId}' tried to fail '${input.phase}' to 'error'; coerced forward to '${forward}'.`;
            console.warn(`[anti-error] ${input.agentId}: next_phase='error' from '${input.phase}' — coerced to '${forward}'`);
        }
    }

    if (!isAllowedSdlcTransition(input.agentId, input.phase, effectiveNextPhase)) {
        return { ok: false, error: `${input.agentId} cannot transition ${input.phase} -> ${effectiveNextPhase}` };
    }

    const next = getDb().transaction((): WorkflowItemRow => {
        dbRecordPhaseEvent({
            workflowItemId: item.id,
            agentId: input.agentId,
            phase: input.phase,
            eventType: 'phase-completed',
            outputs: input.outputs,
            message: [input.message, guardNote].filter(Boolean).join(' | ') || null,
        });

        const taskIds = Array.isArray(input.outputs.taskIds) ? input.outputs.taskIds.map(id => String(id)) : [];
        const tasks = Array.isArray(input.outputs.tasks) ? input.outputs.tasks : [];
        tasks.forEach((task, index) => {
            const taskRecord: Record<string, unknown> = task && typeof task === 'object' ? task as Record<string, unknown> : { value: task };
            const key = String(taskRecord.number ?? taskRecord.id ?? taskIds[index] ?? `task-${index + 1}`);
            dbUpsertWorkflowArtifact({
                workflowItemId: item.id,
                artifactType: 'task',
                artifactKey: key,
                payload: { ...taskRecord, id: taskRecord.id ?? key, number: taskRecord.number ?? key, sourcePhase: input.phase },
            });
        });

        return dbTransitionWorkflowItem({
            workflowItemId: item.id,
            agentId: input.agentId,
            nextPhase: effectiveNextPhase,
            outputs: { auditEvent: { from: input.phase, to: effectiveNextPhase, ...(guardLabel ? { guardCoerced: guardLabel } : {}) } },
            message: `Transitioned ${input.phase} -> ${effectiveNextPhase}${guardLabel ? ` (${guardLabel})` : ''}`,
        });
    })();

    return { ok: true, value: next };
}

export function getWorkflowAudit(workflowItemId: number): PhaseEventRow[] {
    return dbGetPhaseEvents(workflowItemId);
}
