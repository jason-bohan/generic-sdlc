import {
    getSdlcPhaseContract,
    getSdlcWorkflow,
    isAllowedSdlcTransition,
    validateSdlcPhaseOutput,
    type SdlcAgentId,
    type SdlcOutputKey,
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
    skillFile?: string;
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

function phaseSpecificInstructions(item: WorkflowItemRow, serverBaseUrl: string): string {
    if (item.active_phase !== 'reading-story') return '';

    return [
        'Phase 1 tasking requirements:',
        `- Fetch or read story ${item.story_number} before planning.`,
        `- Create/refine implementation tasks through ${serverBaseUrl}/api/scheduler/create-task so mock mode and live mode use the same API boundary.`,
        '- For each task call: POST /api/scheduler/create-task with agentId, storyNumber, name, and estimate.',
        '- Use the returned task numbers as taskIds.',
        '- Include tasks, taskIds, affected repo, branch plan, test matrix, risks, open questions, and auditEvent in the completion payload.',
    ].join('\n');
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
    const skillFile = input.skillFile ?? `skills/${agentId}/SKILL.md`;
    const nextPhases = workflow.transitions[phase] ?? contract.allowedNext;
    const prompt = [
        `You are ${agentId}. Run SDLC phase "${phase}" for story ${item.story_number}.`,
        '',
        'Read first:',
        `- ${statusFile}`,
        `- ${skillFile}`,
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
                  `  The main working tree belongs to the developer's active IDE session - never modify it directly.`
            : null,
        '',
        `Purpose: ${contract.purpose}`,
        '',
        'Required context keys:',
        formatKeyList(contract.requires),
        '',
        'You must produce these output keys exactly:',
        formatKeyList(contract.produces),
        '',
        'Gates before completing the phase:',
        formatKeyList(contract.gates),
        '',
        phaseSpecificInstructions(item, serverBaseUrl),
        '',
        'When the phase is complete, POST this contract payload:',
        `${serverBaseUrl}/api/workflows/complete-phase`,
        JSON.stringify({
            workflowItemId: item.id,
            agentId,
            phase,
            nextPhase: nextPhases[0] ?? 'complete',
            outputs: Object.fromEntries(contract.produces.map(key => [key, '<required>'])),
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

    return {
        classification: hasFrontend ? 'frontend' : 'unknown',
        primaryAgent: 'frontend',
        collaboratorAgents: hasQa ? ['qa'] : [],
        startPhase: getSdlcWorkflow('frontend').start,
        affectedRepo: story.affectedRepo ?? null,
    };
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

    if (!isAllowedSdlcTransition(input.agentId, input.phase, input.nextPhase)) {
        return { ok: false, error: `${input.agentId} cannot transition ${input.phase} -> ${input.nextPhase}` };
    }

    const next = getDb().transaction((): WorkflowItemRow => {
        dbRecordPhaseEvent({
            workflowItemId: item.id,
            agentId: input.agentId,
            phase: input.phase,
            eventType: 'phase-completed',
            outputs: input.outputs,
            message: input.message ?? null,
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
            nextPhase: input.nextPhase,
            outputs: { auditEvent: { from: input.phase, to: input.nextPhase } },
            message: `Transitioned ${input.phase} -> ${input.nextPhase}`,
        });
    })();

    return { ok: true, value: next };
}

export function getWorkflowAudit(workflowItemId: number): PhaseEventRow[] {
    return dbGetPhaseEvents(workflowItemId);
}
