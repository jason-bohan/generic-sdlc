import type { Dispatch, SetStateAction } from 'react';
import type { AgentRole, Phase } from '../types';
import { agentDetailStyles as s } from './AgentDetail.styles';
import { pluralize } from '../agent-detail-utils';

export interface ContextualActionBarProps {
    agentId: string;
    agentRole: AgentRole;
    shownName: string;
    currentPhase: Phase;
    continuing: boolean;
    globalStepMode: boolean;
    assigningMore: boolean;
    assignMoreTasks: () => void;
    handleContinue: (opts?: { phaseHint?: string }) => Promise<unknown>;
    setCheckpointBanner: Dispatch<SetStateAction<{ tone: 'success' | 'error'; text: string } | null>>;
    checkpointBanner: { tone: 'success' | 'error'; text: string } | null;
    hasOpenRequests: boolean;
    hasSelectedRequests: boolean;
    selectedOpenRequestCount: number;
    contextualBarTasksAllComplete: boolean;
    selectableTasksCount: number;
    selectedTaskIdsCount: number;
    taskSelectionAllowed: boolean;
    continueAutonomously: () => void;
    setAssigningMore: Dispatch<SetStateAction<boolean>>;
    isRunning?: boolean;
    hasActivePr?: boolean;
}

export function ContextualActionBar({
    agentId,
    agentRole,
    shownName,
    currentPhase,
    continuing,
    globalStepMode,
    assigningMore,
    setAssigningMore,
    assignMoreTasks,
    handleContinue,
    setCheckpointBanner,
    checkpointBanner,
    hasOpenRequests,
    hasSelectedRequests,
    selectedOpenRequestCount,
    contextualBarTasksAllComplete,
    selectableTasksCount,
    selectedTaskIdsCount,
    taskSelectionAllowed,
    continueAutonomously,
    isRunning,
    hasActivePr,
}: ContextualActionBarProps) {
    const busy = continuing || !!isRunning;
    return (
        <div
            style={s.contextActionBar}
            data-testid={`${agentId}-context-action-bar`}
            role="region"
            aria-label="Next steps when work is complete or at a pipeline checkpoint"
        >
            <style>{`[data-testid="${agentId}-context-action-bar"] button:not(:disabled){cursor:pointer}[data-testid="${agentId}-context-action-bar"] button:disabled{cursor:not-allowed;opacity:0.45}`}</style>
            <div style={s.contextActionBarTitleRow}>
                <span style={s.contextActionBarKicker}>Step mode</span>
                <h2 style={s.contextActionBarHeading}>
                    {agentRole === 'reviewer'
                        ? (currentPhase === 'pending-review'
                            ? `PR ready for ${shownName} - click Start Review to begin.`
                            : currentPhase === 'reviewing' || currentPhase === 'commenting'
                                ? `${shownName} is reviewing the PR...`
                                : currentPhase === 'changes-requested'
                                    ? `${shownName} requested changes - waiting for the author to push fixes.`
                                    : currentPhase === 'waiting-for-fixes'
                                        ? `Author pushed fixes - re-review to check the changes.`
                                        : currentPhase === 'approved'
                                            ? `PR approved - hand off to DevOps for CI.`
                                            : currentPhase === 'watching-build'
                                                ? `${shownName} approved the PR - watching the CI build.`
                                                : `${shownName} is at a review checkpoint.`)
                        : agentRole === 'devops'
                            ? (currentPhase === 'build-passed'
                                ? `CI passed - ${shownName} should run story wrap-up.`
                                : currentPhase === 'build-failed'
                                    ? `${shownName} should triage the failed build.`
                                    : `${shownName} is at a build checkpoint - how should we proceed?`)
                            : agentRole === 'ux'
                                ? `${shownName} is ready for design review - how should we proceed?`
                                : (currentPhase === 'analyzing' || currentPhase === 'generating-code') && !hasOpenRequests
                                    ? `Select tasks for ${shownName} and click Start Work.`
                                    : assigningMore
                                        ? `Select tasks for ${shownName}'s next run, then click Continue.`
                                        : hasOpenRequests
                                            ? `${shownName} has feedback to address - choose the requests to work on.`
                                            : contextualBarTasksAllComplete
                                                ? `${shownName} completed all assigned tasks - what's next?`
                                                : `${shownName} is at a pipeline checkpoint - what would you like to do next?`}
                </h2>
            </div>
            <div style={s.contextActionBarButtons}>
                {agentRole === 'reviewer' ? (<>
                    {currentPhase === 'pending-review' && (
                        <button
                            type="button"
                            style={s.contextActionBtnPrimary}
                            onClick={() => {
                                void handleContinue({ phaseHint: 'start-review' })
                                    .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is reviewing the PR - will comment and approve or request changes.` }))
                                    .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                            }}
                            disabled={busy}
                            data-testid={`${agentId}-action-start-review`}
                        >
                            {busy ? 'Starting...' : 'Start Review'}
                        </button>
                    )}
                    {currentPhase === 'waiting-for-fixes' && (
                        <button
                            type="button"
                            style={s.contextActionBtnPrimary}
                            onClick={() => {
                                void handleContinue({ phaseHint: 'start-review' })
                                    .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is re-reviewing after fixes.` }))
                                    .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                            }}
                            disabled={busy}
                            data-testid={`${agentId}-action-re-review`}
                        >
                            {busy ? 'Starting...' : 'Re-review'}
                        </button>
                    )}
                    {currentPhase === 'approved' && (
                        <button
                            type="button"
                            style={s.contextActionBtnPrimary}
                            onClick={() => {
                                void handleContinue({ phaseHint: 'handoff-devops' })
                                    .then(() => setCheckpointBanner({ tone: 'success', text: 'Handing off to DevOps for CI build.' }))
                                    .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                            }}
                            disabled={busy}
                            data-testid={`${agentId}-action-handoff-devops`}
                        >
                            {busy ? 'Starting...' : 'Hand Off to DevOps'}
                        </button>
                    )}
                </>) : agentRole === 'devops' ? (<>
                    {currentPhase === 'build-passed' ? (
                        <button
                            type="button"
                            style={{ ...s.contextActionBtnPrimary, ...(busy ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
                            onClick={() => {
                                void handleContinue()
                                    .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is running story wrap-up.` }))
                                    .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                            }}
                            disabled={busy}
                            data-testid={`${agentId}-action-run-wrapup`}
                        >
                            {busy ? 'Starting...' : 'Run story wrap-up'}
                        </button>
                    ) : currentPhase === 'build-failed' ? (
                        <button
                            type="button"
                            style={{ ...s.contextActionBtnPrimary, ...(busy ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
                            onClick={() => {
                                void handleContinue()
                                    .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is addressing the build failure.` }))
                                    .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                            }}
                            disabled={busy}
                            data-testid={`${agentId}-action-address-build-failure`}
                        >
                            {busy ? 'Starting...' : 'Address build failure'}
                        </button>
                    ) : (
                        <button
                            type="button"
                            style={{ ...s.contextActionBtnPrimary, ...(busy ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
                            onClick={() => {
                                void handleContinue({ phaseHint: 'monitor-build' })
                                    .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is monitoring the build pipeline.` }))
                                    .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                            }}
                            disabled={busy}
                            data-testid={`${agentId}-action-monitor-build`}
                        >
                            {busy ? 'Starting...' : 'Monitor Build'}
                        </button>
                    )}
                </>) : (currentPhase === 'analyzing' || currentPhase === 'generating-code') && !hasOpenRequests ? (<>
                    <button
                        type="button"
                        style={s.contextActionBtnPrimary}
                        onClick={() => {
                            void handleContinue()
                                .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is starting work on ${selectedTaskIdsCount || 'all'} task(s).` }))
                                .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                        }}
                        disabled={busy || (taskSelectionAllowed && selectedTaskIdsCount === 0 && selectableTasksCount > 0)}
                        data-testid={`${agentId}-action-start-work`}
                    >
                        {busy ? 'Working...' : selectedTaskIdsCount > 0 ? `Start Work on ${selectedTaskIdsCount} task${selectedTaskIdsCount > 1 ? 's' : ''}` : 'Start Work'}
                    </button>
                    <button
                        type="button"
                        style={s.contextActionBtnSecondary}
                        onClick={assignMoreTasks}
                        disabled={busy || selectableTasksCount === 0}
                        title={selectableTasksCount === 0 ? 'No pending tasks to assign' : 'Clear completed tasks from your selection and pick new ones'}
                        data-testid={`${agentId}-action-assign-more`}
                    >
                        Assign More Tasks
                    </button>
                </>) : assigningMore ? (<>
                    <button
                        type="button"
                        style={s.contextActionBtnPrimary}
                        onClick={() => {
                            void handleContinue()
                                .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is continuing with ${selectedTaskIdsCount || 'all'} task(s).` }))
                                .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                        }}
                        disabled={busy || (taskSelectionAllowed && selectedTaskIdsCount === 0 && selectableTasksCount > 0)}
                        data-testid={`${agentId}-action-continue-selected`}
                    >
                        {busy ? 'Working...' : selectedTaskIdsCount > 0 ? `Continue with ${selectedTaskIdsCount} task${selectedTaskIdsCount > 1 ? 's' : ''}` : 'Continue'}
                    </button>
                    <button
                        type="button"
                        style={s.contextActionBtnSecondary}
                        onClick={() => setAssigningMore(false)}
                        disabled={busy}
                        data-testid={`${agentId}-action-cancel-assign`}
                    >
                        Cancel
                    </button>
                </>) : agentRole === 'ux' ? (<>
                    <button
                        type="button"
                        style={s.contextActionBtnPrimary}
                        onClick={() => {
                            void handleContinue({ phaseHint: 'design-review' })
                                .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is reviewing the design.` }))
                                .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                        }}
                            disabled={busy}
                            data-testid={`${agentId}-action-design-review`}
                        >
                            {busy ? 'Starting...' : 'Review Design'}
                    </button>
                    <button
                        type="button"
                        style={s.contextActionBtnSecondary}
                        onClick={assignMoreTasks}
                        disabled={busy || selectableTasksCount === 0}
                        title={selectableTasksCount === 0 ? 'No pending tasks to assign' : 'Clear completed tasks from your selection and pick new ones'}
                        data-testid={`${agentId}-action-assign-more`}
                    >
                        Assign More Tasks
                    </button>
                </>) : hasOpenRequests ? (<>
                    <button
                        type="button"
                        style={s.contextActionBtnWarning}
                        onClick={() => {
                            void handleContinue()
                                .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is addressing selected feedback.` }))
                                .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                        }}
                        disabled={busy}
                        data-testid={`${agentId}-action-address-feedback`}
                    >
                        {busy ? 'Working...' : 'Address Feedback'}
                    </button>
                    <button
                        type="button"
                        style={s.contextActionBtnSecondary}
                        onClick={assignMoreTasks}
                        disabled={busy || selectableTasksCount === 0}
                        title={selectableTasksCount === 0 ? 'No pending tasks to assign' : 'Clear completed tasks from your selection and pick new ones'}
                        data-testid={`${agentId}-action-assign-more`}
                    >
                        Assign More Tasks
                    </button>
                </>) : (<>
                    <button
                        type="button"
                        style={{
                            ...s.contextActionBtnPrimary,
                            ...((busy || hasActivePr) ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
                        }}
                        onClick={() => {
                            void handleContinue({ phaseHint: 'creating-pr' })
                                .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} will create or register the PR. Phase updates when that run finishes.` }))
                                .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                        }}
                        disabled={busy || !!hasActivePr}
                        title={hasActivePr ? 'PR already created — merge it before creating another' : undefined}
                        data-testid={`${agentId}-action-create-pr`}
                    >
                        {busy ? 'Working...' : 'Create PR'}
                    </button>
                    <button
                        type="button"
                        style={s.contextActionBtnSecondary}
                        onClick={assignMoreTasks}
                        disabled={busy || selectableTasksCount === 0}
                        title={selectableTasksCount === 0 ? 'No pending tasks to assign' : 'Clear completed tasks from your selection and pick new ones'}
                        data-testid={`${agentId}-action-assign-more`}
                    >
                        Assign More Tasks
                    </button>
                </>)}
                <button
                    type="button"
                    style={s.contextActionBtnTertiary}
                    onClick={continueAutonomously}
                    disabled={busy || globalStepMode}
                    title={globalStepMode ? 'Turn off global step mode to continue autonomously for this agent' : 'Disable step mode for this agent and continue'}
                    data-testid={`${agentId}-action-continue-auto`}
                >
                    Continue Autonomously
                </button>
            </div>
            {checkpointBanner && (
                <p
                    style={{
                        ...s.contextActionBarBanner,
                        color: checkpointBanner.tone === 'error' ? 'var(--error)' : 'var(--success)',
                    }}
                    data-testid={`${agentId}-checkpoint-banner`}
                    role="status"
                >
                    {checkpointBanner.text}
                </p>
            )}
            <p style={s.contextActionBarHint}>
                {agentRole === 'reviewer'
                    ? (currentPhase === 'pending-review'
                        ? `Start Review spawns ${shownName} to read the diff, comment, and approve or request changes - all in one run.`
                        : currentPhase === 'reviewing' || currentPhase === 'commenting'
                            ? `${shownName} is actively reviewing. The verdict (approve or request changes) will be set automatically when the run finishes.`
                            : currentPhase === 'changes-requested'
                                ? `The PR stays on ${shownName}'s desk until the author pushes fixes. Re-review will be available then.`
                                : currentPhase === 'waiting-for-fixes'
                                    ? `Re-review spawns ${shownName} to check the author's fixes, comment, and approve or request more changes.`
                                    : currentPhase === 'approved'
                                        ? `Hand Off to DevOps triggers the CI build pipeline.`
                                        : currentPhase === 'watching-build'
                                            ? `${shownName} approved the PR and is passively watching CI. The desk clears automatically when the build result arrives.`
                                            : `Use the buttons to advance ${shownName} through the review workflow.`)
                    : agentRole === 'devops'
                        ? (currentPhase === 'build-passed'
                            ? `Run story wrap-up starts ${shownName} with the handoff wrap-up instructions. Dismiss the wrap-up task on this list when the run is finished.`
                            : currentPhase === 'build-failed'
                                ? `Continue tells ${shownName} to triage the failed build using the skill and status file.`
                                : `Monitor Build tells ${shownName} to watch the CI pipeline and report results when complete.`)
                        : agentRole === 'ux'
                            ? `Review Design tells ${shownName} to begin the UX review of the PR changes.`
                            : (currentPhase === 'analyzing' || currentPhase === 'generating-code') && !hasOpenRequests
                                ? selectedTaskIdsCount > 0
                                    ? `${shownName} will implement the ${pluralize(selectedTaskIdsCount, 'selected task')}.`
                                    : `Select one or more tasks to scope ${shownName}'s implementation run, or click Start Work to begin all tasks.`
                                : hasOpenRequests
                                    ? hasSelectedRequests
                                        ? `${pluralize(selectedOpenRequestCount, 'selected request')} will be passed into ${shownName}'s next run.`
                                        : `Select one or more feedback requests to scope ${shownName}'s next run, or continue with all open feedback in view.`
                                    : hasActivePr
                                        ? `${shownName} already has an active PR — waiting for review and merge before another can be created.`
                                        : `Create PR tells ${shownName} to create or register the PR. Azure DevOps updates when that run completes.`}
            </p>
        </div>
    );
}
ContextualActionBar.displayName = 'ContextualActionBar';
