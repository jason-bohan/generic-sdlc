export type SdlcAgentId = 'frontend' | 'backend' | 'qa' | 'ux' | 'reviewer' | 'devops' | 'orchestrator';

export type SdlcPhaseId =
    | 'story-intake'
    | 'pre-planning'
    | 'reading-story'
    | 'analyzing'
    | 'generating-code'
    | 'committing'
    | 'validating'
    | 'creating-pr'
    | 'watching-reviews'
    | 'addressing-feedback'
    | 'researching'
    | 'designing'
    | 'spec-ready'
    | 'collaborating'
    | 'reviewing'
    | 'commenting'
    | 'approved'
    | 'changes-requested'
    | 'pending-build'
    | 'monitoring-build'
    | 'build-passed'
    | 'build-failed'
    | 'running-cypress'
    | 'complete'
    | 'error';

export type SdlcOutputKey =
    | 'story'
    | 'classification'
    | 'affectedRepo'
    | 'branchPlan'
    | 'tasks'
    | 'taskIds'
    | 'testMatrix'
    | 'risks'
    | 'openQuestions'
    | 'codeChanges'
    | 'validationResults'
    | 'staticAnalysis'
    | 'pr'
    | 'mockPr'
    | 'reviewVerdict'
    | 'reviewThreads'
    | 'build'
    | 'testResults'
    | 'designSpec'
    | 'handoff'
    | 'auditEvent';

export interface SdlcPhaseContract {
    id: SdlcPhaseId;
    ownerAgents: readonly SdlcAgentId[];
    purpose: string;
    requires: readonly SdlcOutputKey[];
    produces: readonly SdlcOutputKey[];
    gates: readonly string[];
    allowedNext: readonly SdlcPhaseId[];
}

export interface SdlcWorkflowGraph {
    agentId: SdlcAgentId;
    start: SdlcPhaseId;
    terminal: readonly SdlcPhaseId[];
    phases: readonly SdlcPhaseId[];
    transitions: Readonly<Partial<Record<SdlcPhaseId, readonly SdlcPhaseId[]>>>;
}

export interface SdlcContractValidation {
    ok: boolean;
    missing: SdlcOutputKey[];
}

export const SDLC_PHASE_CONTRACTS: Readonly<Record<SdlcPhaseId, SdlcPhaseContract>> = {
    'story-intake': {
        id: 'story-intake',
        ownerAgents: ['orchestrator'],
        purpose: 'Classify a backlog or outside-backlog story and decide which agents should participate.',
        requires: ['story'],
        produces: ['classification', 'affectedRepo', 'handoff', 'auditEvent'],
        gates: ['Story source is known', 'Target repo/project can be resolved', 'Mock/live mode is recorded'],
        allowedNext: ['pre-planning', 'reading-story', 'researching', 'error'],
    },
    'pre-planning': {
        id: 'pre-planning',
        ownerAgents: ['orchestrator', 'frontend', 'backend', 'qa', 'ux'],
        purpose: 'Review requirements, design, risk, and questions before implementation starts.',
        requires: ['story', 'classification', 'affectedRepo'],
        produces: ['openQuestions', 'risks', 'testMatrix', 'handoff', 'auditEvent'],
        gates: ['Questions are captured', 'Known risk is explicit', 'Planning meeting decision is recorded'],
        allowedNext: ['reading-story', 'researching', 'error'],
    },
    'reading-story': {
        id: 'reading-story',
        ownerAgents: ['frontend', 'backend', 'qa', 'ux'],
        purpose: 'Read the story, create/refine tasks, and produce the implementation plan.',
        requires: ['story', 'classification', 'affectedRepo'],
        produces: ['tasks', 'taskIds', 'branchPlan', 'testMatrix', 'risks', 'openQuestions', 'auditEvent'],
        gates: ['Tasks exist or an explicit no-task rationale exists', 'Branch plan is known', 'Test matrix is started'],
        allowedNext: ['analyzing', 'researching', 'error'],
    },
    analyzing: {
        id: 'analyzing',
        ownerAgents: ['frontend', 'backend', 'devops'],
        purpose: 'Analyze affected code, existing patterns, environment constraints, and implementation shape.',
        requires: ['story', 'tasks', 'affectedRepo', 'branchPlan'],
        produces: ['codeChanges', 'risks', 'auditEvent'],
        gates: ['Affected files/components are identified', 'Implementation approach is explicit'],
        allowedNext: ['generating-code', 'validating', 'error'],
    },
    'generating-code': {
        id: 'generating-code',
        ownerAgents: ['frontend', 'backend'],
        purpose: 'Implement the planned code and supporting tests/docs in the target repository.',
        requires: ['tasks', 'branchPlan', 'codeChanges'],
        produces: ['codeChanges', 'auditEvent'],
        gates: ['Each completed task maps to changed files or an explicit no-op'],
        allowedNext: ['validating', 'committing', 'addressing-feedback', 'error'],
    },
    committing: {
        id: 'committing',
        ownerAgents: ['frontend', 'backend'],
        purpose: 'Create branch, stage all changes, commit, and push (or simulate in mock mode).',
        requires: ['codeChanges', 'branchPlan'],
        produces: ['branchPlan', 'auditEvent'],
        gates: ['Branch name follows branchPlan', 'All task changes are staged and committed', 'Mock mode does not push to remote'],
        allowedNext: ['creating-pr', 'error'],
    },
    validating: {
        id: 'validating',
        ownerAgents: ['frontend', 'backend', 'devops'],
        purpose: 'Run local validation before PR creation or after feedback/build failure.',
        requires: ['codeChanges', 'testMatrix'],
        produces: ['validationResults', 'staticAnalysis', 'testResults', 'risks', 'auditEvent'],
        gates: ['Build/test commands are recorded', 'Failures are fixed or explicitly accepted as risk'],
        allowedNext: ['committing', 'creating-pr', 'generating-code', 'error'],
    },
    'creating-pr': {
        id: 'creating-pr',
        ownerAgents: ['frontend', 'backend'],
        purpose: 'Create or simulate the PR and register it with SDLC Framework for review handoff.',
        requires: ['validationResults', 'branchPlan'],
        produces: ['pr', 'mockPr', 'handoff', 'auditEvent'],
        gates: ['Mock mode produces mockPr only', 'Live mode produces PR metadata', '/api/pr/created is called'],
        allowedNext: ['watching-reviews', 'error'],
    },
    'watching-reviews': {
        id: 'watching-reviews',
        ownerAgents: ['frontend', 'backend'],
        purpose: 'Wait for code/design review and route feedback.',
        requires: ['pr'],
        produces: ['reviewThreads', 'reviewVerdict', 'auditEvent'],
        gates: ['Review source is mock-safe in mock mode', 'Reviewer verdict is recorded when present'],
        allowedNext: ['addressing-feedback', 'pending-build', 'complete', 'error'],
    },
    'addressing-feedback': {
        id: 'addressing-feedback',
        ownerAgents: ['frontend', 'backend', 'ux'],
        purpose: 'Resolve reviewer, design, QA, or build feedback.',
        requires: ['reviewThreads'],
        produces: ['codeChanges', 'validationResults', 'auditEvent'],
        gates: ['Each actionable comment has a response or explicit deferral', 'Validation is rerun when code changes'],
        allowedNext: ['validating', 'watching-reviews', 'error'],
    },
    researching: {
        id: 'researching',
        ownerAgents: ['ux'],
        purpose: 'Research the story, requirements, usability constraints, and design dependencies.',
        requires: ['story'],
        produces: ['openQuestions', 'risks', 'auditEvent'],
        gates: ['Research notes are captured', 'Design dependencies are known'],
        allowedNext: ['designing', 'error'],
    },
    designing: {
        id: 'designing',
        ownerAgents: ['ux'],
        purpose: 'Create the design spec and implementation guidance.',
        requires: ['story', 'openQuestions'],
        produces: ['designSpec', 'testMatrix', 'auditEvent'],
        gates: ['Design spec path is recorded', 'Accessibility considerations are documented'],
        allowedNext: ['spec-ready', 'collaborating', 'error'],
    },
    'spec-ready': {
        id: 'spec-ready',
        ownerAgents: ['ux'],
        purpose: 'Make the design available to implementation agents.',
        requires: ['designSpec'],
        produces: ['handoff', 'auditEvent'],
        gates: ['Target implementation agents are identified'],
        allowedNext: ['collaborating', 'complete', 'error'],
    },
    collaborating: {
        id: 'collaborating',
        ownerAgents: ['ux', 'frontend', 'backend', 'qa'],
        purpose: 'Coordinate a design-first or full-stack story across agents.',
        requires: ['handoff'],
        produces: ['reviewThreads', 'auditEvent'],
        gates: ['Collaboration participants are recorded'],
        allowedNext: ['reviewing', 'complete', 'error'],
    },
    reviewing: {
        id: 'reviewing',
        ownerAgents: ['reviewer'],
        purpose: 'Review PR contents against story, code quality, tests, and risk.',
        requires: ['pr'],
        produces: ['reviewThreads', 'risks', 'auditEvent'],
        gates: ['Diff and acceptance criteria are reviewed'],
        allowedNext: ['commenting', 'approved', 'changes-requested', 'error'],
    },
    commenting: {
        id: 'commenting',
        ownerAgents: ['reviewer'],
        purpose: 'Record review findings and decide whether the PR can proceed.',
        requires: ['reviewThreads'],
        produces: ['reviewVerdict', 'auditEvent'],
        gates: ['Verdict is approved or changes-requested'],
        allowedNext: ['approved', 'changes-requested', 'error'],
    },
    approved: {
        id: 'approved',
        ownerAgents: ['reviewer'],
        purpose: 'Signal code review approval and hand off to build/release gates.',
        requires: ['reviewVerdict'],
        produces: ['handoff', 'auditEvent'],
        gates: ['Approval is recorded exactly once'],
        allowedNext: ['pending-build', 'complete'],
    },
    'changes-requested': {
        id: 'changes-requested',
        ownerAgents: ['reviewer'],
        purpose: 'Signal that the story owner must address review feedback.',
        requires: ['reviewVerdict', 'reviewThreads'],
        produces: ['handoff', 'auditEvent'],
        gates: ['Feedback has enough detail for the owner to act'],
        allowedNext: ['addressing-feedback', 'complete'],
    },
    'pending-build': {
        id: 'pending-build',
        ownerAgents: ['devops'],
        purpose: 'Queue or simulate the build after review approval.',
        requires: ['pr', 'handoff'],
        produces: ['build', 'auditEvent'],
        gates: ['Build target and pipeline are known'],
        allowedNext: ['monitoring-build', 'build-passed', 'build-failed', 'error'],
    },
    'monitoring-build': {
        id: 'monitoring-build',
        ownerAgents: ['devops'],
        purpose: 'Track build status and collect failure details.',
        requires: ['build'],
        produces: ['build', 'testResults', 'auditEvent'],
        gates: ['Build result is terminal or still explicitly pending'],
        allowedNext: ['build-passed', 'build-failed', 'error'],
    },
    'build-passed': {
        id: 'build-passed',
        ownerAgents: ['devops'],
        purpose: 'Record successful build and move toward merge/completion.',
        requires: ['build'],
        produces: ['handoff', 'auditEvent'],
        gates: ['Build result is succeeded'],
        allowedNext: ['complete'],
    },
    'build-failed': {
        id: 'build-failed',
        ownerAgents: ['devops'],
        purpose: 'Record failed build and route the story back to the owner.',
        requires: ['build'],
        produces: ['handoff', 'risks', 'auditEvent'],
        gates: ['Failure details are captured'],
        allowedNext: ['validating', 'addressing-feedback', 'error'],
    },
    'running-cypress': {
        id: 'running-cypress',
        ownerAgents: ['frontend', 'qa'],
        purpose: 'Run UI/API automation or manual test matrix validation.',
        requires: ['testMatrix'],
        produces: ['testResults', 'risks', 'auditEvent'],
        gates: ['Failures are routed to owner or explicitly accepted'],
        allowedNext: ['complete', 'addressing-feedback', 'error'],
    },
    complete: {
        id: 'complete',
        ownerAgents: ['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops', 'orchestrator'],
        purpose: 'Record story/workflow completion and close the loop.',
        requires: ['auditEvent'],
        produces: ['auditEvent'],
        gates: ['Completion event is recorded'],
        allowedNext: [],
    },
    error: {
        id: 'error',
        ownerAgents: ['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops', 'orchestrator'],
        purpose: 'Pause workflow because a contract, tool, test, or external dependency failed.',
        requires: ['risks'],
        produces: ['auditEvent'],
        gates: ['Error is actionable and visible'],
        allowedNext: ['pre-planning', 'reading-story', 'analyzing', 'validating', 'addressing-feedback'],
    },
};

export const SDLC_WORKFLOW_GRAPHS: Readonly<Record<SdlcAgentId, SdlcWorkflowGraph>> = {
    orchestrator: {
        agentId: 'orchestrator',
        start: 'story-intake',
        terminal: ['complete', 'error'],
        phases: ['story-intake', 'pre-planning', 'reading-story', 'researching', 'pending-build', 'complete', 'error'],
        transitions: {
            'story-intake': ['pre-planning', 'reading-story', 'researching', 'error'],
            'pre-planning': ['reading-story', 'researching', 'error'],
            'reading-story': ['complete', 'error'],
            researching: ['complete', 'error'],
            'pending-build': ['complete', 'error'],
            complete: [],
            error: ['story-intake', 'pre-planning'],
        },
    },
    frontend: {
        agentId: 'frontend',
        start: 'reading-story',
        terminal: ['complete', 'error'],
        phases: ['reading-story', 'analyzing', 'generating-code', 'committing', 'validating', 'creating-pr', 'watching-reviews', 'addressing-feedback', 'running-cypress', 'complete', 'error'],
        transitions: {
            'reading-story': ['analyzing', 'error'],
            analyzing: ['generating-code', 'error'],
            'generating-code': ['validating', 'committing', 'error'],
            committing: ['creating-pr', 'error'],
            validating: ['committing', 'creating-pr', 'generating-code', 'error'],
            'creating-pr': ['watching-reviews', 'error'],
            'watching-reviews': ['addressing-feedback', 'running-cypress', 'complete', 'error'],
            'addressing-feedback': ['validating', 'watching-reviews', 'error'],
            'running-cypress': ['complete', 'addressing-feedback', 'error'],
            complete: [],
            error: ['reading-story', 'analyzing', 'validating', 'addressing-feedback'],
        },
    },
    backend: {
        agentId: 'backend',
        start: 'reading-story',
        terminal: ['complete', 'error'],
        phases: ['reading-story', 'analyzing', 'generating-code', 'committing', 'validating', 'creating-pr', 'watching-reviews', 'addressing-feedback', 'complete', 'error'],
        transitions: {
            'reading-story': ['analyzing', 'error'],
            analyzing: ['generating-code', 'error'],
            'generating-code': ['validating', 'committing', 'error'],
            committing: ['creating-pr', 'error'],
            validating: ['committing', 'creating-pr', 'generating-code', 'error'],
            'creating-pr': ['watching-reviews', 'error'],
            'watching-reviews': ['addressing-feedback', 'complete', 'error'],
            'addressing-feedback': ['validating', 'watching-reviews', 'error'],
            complete: [],
            error: ['reading-story', 'analyzing', 'validating', 'addressing-feedback'],
        },
    },
    qa: {
        agentId: 'qa',
        start: 'reading-story',
        terminal: ['complete', 'error'],
        phases: ['reading-story', 'running-cypress', 'addressing-feedback', 'complete', 'error'],
        transitions: {
            'reading-story': ['running-cypress', 'error'],
            'running-cypress': ['complete', 'addressing-feedback', 'error'],
            'addressing-feedback': ['running-cypress', 'error'],
            complete: [],
            error: ['reading-story', 'running-cypress'],
        },
    },
    ux: {
        agentId: 'ux',
        start: 'researching',
        terminal: ['complete', 'error'],
        phases: ['researching', 'designing', 'spec-ready', 'collaborating', 'reviewing', 'addressing-feedback', 'complete', 'error'],
        transitions: {
            researching: ['designing', 'error'],
            designing: ['spec-ready', 'error'],
            'spec-ready': ['collaborating', 'complete', 'error'],
            collaborating: ['reviewing', 'complete', 'error'],
            reviewing: ['complete', 'addressing-feedback', 'error'],
            'addressing-feedback': ['reviewing', 'collaborating', 'error'],
            complete: [],
            error: ['researching', 'designing', 'addressing-feedback'],
        },
    },
    reviewer: {
        agentId: 'reviewer',
        start: 'reviewing',
        terminal: ['approved', 'changes-requested', 'complete', 'error'],
        phases: ['reviewing', 'commenting', 'approved', 'changes-requested', 'complete', 'error'],
        transitions: {
            reviewing: ['commenting', 'approved', 'changes-requested', 'error'],
            commenting: ['approved', 'changes-requested', 'error'],
            approved: ['complete'],
            'changes-requested': ['complete'],
            complete: [],
            error: ['reviewing'],
        },
    },
    devops: {
        agentId: 'devops',
        start: 'pending-build',
        terminal: ['build-passed', 'build-failed', 'complete', 'error'],
        phases: ['pending-build', 'monitoring-build', 'build-passed', 'build-failed', 'complete', 'error'],
        transitions: {
            'pending-build': ['monitoring-build', 'build-passed', 'build-failed', 'error'],
            'monitoring-build': ['build-passed', 'build-failed', 'error'],
            'build-passed': ['complete'],
            'build-failed': ['complete'],
            complete: [],
            error: ['pending-build', 'monitoring-build'],
        },
    },
};

export function getSdlcPhaseContract(phase: SdlcPhaseId): SdlcPhaseContract {
    return SDLC_PHASE_CONTRACTS[phase];
}

export function getSdlcWorkflow(agentId: SdlcAgentId): SdlcWorkflowGraph {
    return SDLC_WORKFLOW_GRAPHS[agentId];
}

export function isAllowedSdlcTransition(agentId: SdlcAgentId, from: SdlcPhaseId, to: SdlcPhaseId): boolean {
    return SDLC_WORKFLOW_GRAPHS[agentId].transitions[from]?.includes(to) ?? false;
}

export function validateSdlcPhaseOutput(phase: SdlcPhaseId, output: Partial<Record<SdlcOutputKey, unknown>>): SdlcContractValidation {
    const contract = getSdlcPhaseContract(phase);
    const missing = contract.produces.filter(key => output[key] === undefined || output[key] === null);
    return { ok: missing.length === 0, missing };
}
