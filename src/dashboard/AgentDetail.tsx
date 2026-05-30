import type { AgentProfile, AgentStatus } from './types';
import { isWrapUpDeskRequestId } from './types';
import { agentDetailStyles as s } from './components/AgentDetail.styles';
import { htmlToPlainText } from './agent-detail-utils';
import { ReviewerDeskPanel } from './components/ReviewerDeskPanel';
import { TaskList } from './components/TaskList';
import { RequestList } from './components/RequestList';
import { EventLog } from './components/EventLog';
import { ContextualActionBar } from './components/ContextualActionBar';
import { Section } from './components/DetailHelpers';
import { useReviewerDesk } from './hooks/useReviewerDesk';
import { useAgentDetailState } from './hooks/useAgentDetailState';
import { AgentDetailHeader } from './components/AgentDetailHeader';
import { AgentDetailStats } from './components/AgentDetailStats';
import { AgentDetailDevopsWrapUpBanner } from './components/AgentDetailDevopsWrapUpBanner';
import { AgentDetailIdleHero } from './components/AgentDetailIdleHero';
import { AgentDetailPullRequestsSection } from './components/AgentDetailPullRequestsSection';
import { AiCostGaugePanel } from './components/AiCostGaugePanel';
import { AiQaQualityPanel } from './components/AiQaQualityPanel';
import { AiQaObservabilityPanel } from './components/AiQaObservabilityPanel';
import { AgentDetailCypressColumn } from './components/AgentDetailCypressColumn';
import { AgentTerminal } from './components/AgentTerminal';

interface AgentDetailProps {
    agent: AgentProfile;
    displayName?: string;
    /** Config/dashboard overrides used when messaging references another agent (e.g. reviewer pickup). */
    agentDisplayNameOverrides?: Record<string, string>;
    status: AgentStatus;
    elapsed: string;
    onBack: () => void;
    onChat?: () => void;
    onPickUpStory?: () => void;
    /** After reviewer picks up a review request from the adapter list, refresh status from disk. */
    onReviewerDeskChanged?: () => void;
    pendingMessages?: number;
}

export default function AgentDetail({ agent, displayName, agentDisplayNameOverrides, status, elapsed, onBack, onChat, onPickUpStory, onReviewerDeskChanged, pendingMessages = 0 }: AgentDetailProps) {
    const detail = useAgentDetailState(agent, status);
    const reviewerDesk = useReviewerDesk({
        agent,
        agentDisplayNameOverrides,
        currentPhase: status.currentPhase,
        onReviewerDeskChanged,
    });

    const shownName = displayName || agent.name;
    const tasks = status.tasks ?? [];
    const prs = status.prs ?? [];
    const cypress = status.cypress ?? { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };
    const events = Array.isArray(status.events) ? status.events : [];
    const actionIsRunning = status.isRunning && !detail.stepPauseReady;
    const controlStatus = actionIsRunning === status.isRunning ? status : { ...status, isRunning: actionIsRunning };

    const isIdle = (status.currentPhase === 'idle' || status.currentPhase === 'complete') && !status.storyNumber;

    return (
        <div style={s.container}>
            <AgentDetailHeader
                agent={agent}
                shownName={shownName}
                status={controlStatus}
                pendingMessages={pendingMessages}
                onBack={onBack}
                onChat={onChat}
                onPickUpStory={onPickUpStory}
                toggleStepMode={detail.toggleStepMode}
                handleContinue={detail.handleContinue}
                continuing={detail.continuing}
                effectiveStepMode={detail.effectiveStepMode}
                isPausedAtStep={detail.isPausedAtStep}
                globalStepMode={detail.globalStepMode}
                totalSelected={detail.totalSelected}
            />

            {status.storyName && <p style={s.storyName}>{status.storyName}</p>}

            {agent.role === 'aiqa' && (
                <>
                    <AiCostGaugePanel accentColor={agent.accentColor} />
                    <AiQaQualityPanel accentColor={agent.accentColor} />
                    <AiQaObservabilityPanel accentColor={agent.accentColor} />
                </>
            )}

            {agent.role === 'reviewer' && (
                <ReviewerDeskPanel
                    shownName={shownName}
                    currentPhase={status.currentPhase}
                    {...reviewerDesk}
                    onStartReview={() => detail.handleContinue({ phaseHint: 'start-review' })}
                    isRunning={actionIsRunning}
                />
            )}

            {agent.id === 'frontend' && status.storyNumber && (status.storyDescription ?? '').trim().length > 0 && (
                <section style={{ ...s.frontendStepCallout, borderColor: `${agent.accentColor}55` }} aria-label="Story front-end step">
                    <div style={{ ...s.frontendStepBadge, background: `${agent.accentColor}22`, color: agent.accentColor }}>Front end step</div>
                    <p style={s.frontendStepBody}>{htmlToPlainText(status.storyDescription ?? '')}</p>
                </section>
            )}

            {isIdle && (
                <AgentDetailIdleHero agent={agent} onPickUpStory={onPickUpStory} onChat={onChat} />
            )}

            {!isIdle && (
                <>
                    <AgentDetailStats elapsed={elapsed} status={status} />

                    {detail.showDevopsWrapUpRun && (
                        <AgentDetailDevopsWrapUpBanner
                            agent={agent}
                            shownName={shownName}
                            continuing={detail.continuing}
                            handleContinue={detail.handleContinue}
                            setCheckpointBanner={detail.setCheckpointBanner}
                        />
                    )}

                    {status.taskReconciliation?.status === 'pending' && (
                        <section style={s.taskReconciliationBanner} data-testid={`${agent.id}-task-reconciliation`}>
                            <p style={s.taskReconciliationTitle}>Task plan needs confirmation</p>
                            <p style={s.taskReconciliationBody}>
                                Existing tasks were found for story {status.taskReconciliation.storyNumber}. Reuse the current dashboard list, or archive it locally and recreate Phase 1 tasks.
                            </p>
                            <div style={s.taskReconciliationActions}>
                                <button
                                    style={s.contextActionBtnPrimary}
                                    onClick={() => detail.resolveTaskReconciliation('reuse').catch((e) => detail.setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }))}
                                    data-testid={`${agent.id}-reuse-tasks`}
                                >
                                    Reuse Existing Tasks
                                </button>
                                <button
                                    style={s.contextActionBtnWarning}
                                    onClick={() => detail.resolveTaskReconciliation('recreate').catch((e) => detail.setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }))}
                                    data-testid={`${agent.id}-recreate-tasks`}
                                >
                                    Recreate Tasks
                                </button>
                            </div>
                        </section>
                    )}

                    {detail.showContextualActionBar && (
                        <ContextualActionBar
                            agentId={agent.id}
                            agentRole={agent.role}
                            shownName={shownName}
                            currentPhase={status.currentPhase}
                            continuing={detail.continuing}
                            globalStepMode={detail.globalStepMode}
                            assigningMore={detail.assigningMore}
                            setAssigningMore={detail.setAssigningMore}
                            assignMoreTasks={detail.assignMoreTasks}
                            handleContinue={detail.handleContinue}
                            setCheckpointBanner={detail.setCheckpointBanner}
                            checkpointBanner={detail.checkpointBanner}
                            hasOpenRequests={detail.hasOpenRequests}
                            hasSelectedRequests={detail.hasSelectedRequests}
                            selectedOpenRequestCount={detail.selectedOpenRequests.length}
                            contextualBarTasksAllComplete={detail.contextualBarTasksAllComplete}
                            selectableTasksCount={detail.selectableTasks.length}
                            selectedTaskIdsCount={detail.selectedTaskIds.size}
                            taskSelectionAllowed={detail.taskSelectionAllowed}
                            continueAutonomously={detail.continueAutonomously}
                            isRunning={actionIsRunning}
                        />
                    )}

                    <div style={s.mainGrid}>
                        <div style={s.column}>
                            <Section title={detail.openRequests.length > 0 ? 'Tasks & Requests' : 'Tasks'}>
                                {tasks.length === 0 && detail.requestsForDesk.length === 0 ? (
                                    <p style={s.emptyText}>No tasks yet</p>
                                ) : (
                                    <>
                                        { (detail.isPausedAtStep || detail.showDevopsWrapUpRun) && ((detail.taskSelectionAllowed && detail.selectableTasks.length > 0) || detail.openRequests.length > 0) && (
                                            <div style={s.selectActions} data-testid={`${agent.id}-select-actions`}>
                                                <button style={s.selectActionBtn} onClick={detail.selectAll} data-testid={`${agent.id}-select-all`}>Select All</button>
                                                <button style={s.selectActionBtn} onClick={detail.deselectAll} data-testid={`${agent.id}-deselect-all`}>Deselect All</button>
                                                {detail.totalSelected > 0 && (
                                                    <span style={s.selectedCount} data-testid={`${agent.id}-selected-count`}>{detail.selectedCountLabel}</span>
                                                )}
                                            </div>
                                        )}
                                        {detail.isPausedAtStep && tasks.length > 0 && !detail.taskSelectionAllowed && (
                                            <p style={s.stepTaskScopeHint} data-testid={`${agent.id}-task-scope-hint`}>
                                                Finish this phase first. Task pick-list for Continue applies in generating-code or addressing-feedback.
                                            </p>
                                        )}
                                        <div style={s.taskPillList} data-testid={`${agent.id}-task-list`}>
                                            <TaskList
                                                agentId={agent.id}
                                                tasks={tasks}
                                                dismissedIds={detail.dismissedIds}
                                                selectedTaskIds={detail.selectedTaskIds}
                                                toggleTask={detail.toggleTask}
                                                dismissItem={detail.dismissItem}
                                                isPausedAtStep={detail.isPausedAtStep}
                                                taskSelectionAllowed={detail.taskSelectionAllowed}
                                                isRunning={actionIsRunning}
                                            />
                                            <RequestList
                                                agentId={agent.id}
                                                requests={detail.requestsForDesk}
                                                dismissedIds={detail.dismissedIds}
                                                selectedRequestIds={detail.selectedRequestIds}
                                                toggleRequest={detail.toggleRequest}
                                                dismissItem={detail.dismissItem}
                                                isPausedAtStep={detail.isPausedAtStep}
                                                currentPhase={status.currentPhase}
                                                isWrapUpDeskRequestId={isWrapUpDeskRequestId}
                                            />
                                        </div>
                                    </>
                                )}
                            </Section>

                            <AgentDetailPullRequestsSection prs={prs} />
                        </div>

                        <div style={s.column}>
                            <AgentDetailCypressColumn agent={agent} cypress={cypress} />

                            <EventLog events={events} />
                        </div>
                    </div>

                    <AgentTerminal
                        agentId={agent.id}
                        active={!!status.isRunning}
                        collapsed={false}
                        onToggleCollapse={() => {}}
                        embedded
                    />
                </>
            )}
        </div>
    );
}

AgentDetail.displayName = 'AgentDetail';
