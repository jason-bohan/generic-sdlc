import type { Dispatch, SetStateAction } from 'react';
import type { Phase } from '../types';
import { agentDetailStyles as s } from './AgentDetail.styles';

export interface ReviewerPrDeskUi {
    kind: 'none' | 'pending' | 'working' | 'changes_on_desk' | 'approved_done' | 'changes_followup' | 'watching_build';
    commentCount: number;
}

export interface ReviewerPrCandidate {
    id: number;
    title: string;
    status: string;
    sourceBranch: string;
    targetBranch: string;
    url: string;
    storyNumber?: string | null;
    projectKey?: string | null;
    createdBy?: { displayName?: string; uniqueName?: string };
    deskUi?: ReviewerPrDeskUi;
    /** When false, hide Pick Up and exclude from auto-list pickup (dismissed card, completed PR, etc.). */
    reviewerPickupEligible?: boolean;
}

export interface ReviewerFeedbackThread {
    id?: string;
    file?: string;
    line?: number;
    category?: string;
    status?: string;
    comment: string;
}

export interface ReviewerDeskPanelProps {
    shownName: string;
    currentPhase: Phase;
    reviewerDeskPrs: ReviewerPrCandidate[];
    reviewerAvailablePrs: ReviewerPrCandidate[];
    reviewerPrError: string | null;
    reviewerPrLoading: boolean;
    reviewerBranchFilter: string;
    setReviewerBranchFilter: Dispatch<SetStateAction<string>>;
    reviewerQuery: string;
    setReviewerQuery: Dispatch<SetStateAction<string>>;
    reviewerPrBanner: { tone: 'success' | 'error'; text: string } | null;
    reviewerAutoPick: boolean;
    reviewerAutoPickBlocked: boolean;
    loadReviewerPrs: () => Promise<void>;
    pickingReviewerPrId: number | null;
    pickReviewerPr: (pr: ReviewerPrCandidate) => Promise<boolean>;
    openReviewerFeedback: (pr: ReviewerPrCandidate) => void;
    dismissReviewerDeskRow: (prId: number) => Promise<void>;
    removeActivePrFromReviewerDesk: (prId: number) => Promise<void>;
    reviewerFeedbackOpen: { prId: number; title: string } | null;
    setReviewerFeedbackOpen: Dispatch<SetStateAction<{ prId: number; title: string } | null>>;
    reviewerFeedbackThreads: ReviewerFeedbackThread[];
    reviewerFeedbackLoading: boolean;
    onStartReview?: () => Promise<unknown>;
    isRunning?: boolean;
}

function ReviewerPrRowView({
    pr,
    shownName,
    pickingReviewerPrId,
    pickReviewerPr,
    openReviewerFeedback,
    dismissReviewerDeskRow,
    removeActivePrFromReviewerDesk,
    onStartReview,
    isRunning,
}: {
    pr: ReviewerPrCandidate;
    shownName: string;
    pickingReviewerPrId: number | null;
    pickReviewerPr: (pr: ReviewerPrCandidate) => Promise<boolean>;
    openReviewerFeedback: (pr: ReviewerPrCandidate) => void;
    dismissReviewerDeskRow: (prId: number) => Promise<void>;
    removeActivePrFromReviewerDesk: (prId: number) => Promise<void>;
    onStartReview?: () => Promise<unknown>;
    isRunning?: boolean;
}) {
    const kind = pr.deskUi?.kind ?? 'none';
    const nComments = pr.deskUi?.commentCount ?? 0;
    let badgeStyle = s.reviewerDeskBadgeWorking;
    let badgeLabel = 'Working';
    if (kind === 'pending') {
        badgeStyle = s.reviewerDeskBadgePending ?? s.reviewerDeskBadgeWorking;
        badgeLabel = 'Pending';
    } else if (kind === 'changes_on_desk') {
        badgeStyle = s.reviewerDeskBadgeChanges;
        badgeLabel = 'Changes requested';
    } else if (kind === 'changes_followup') {
        badgeStyle = s.reviewerDeskBadgeAwaiting;
        badgeLabel = 'Awaiting author';
    } else if (kind === 'approved_done') {
        badgeStyle = s.reviewerDeskBadgeApproved;
        badgeLabel = 'Approved';
    } else if (kind === 'watching_build') {
        badgeStyle = s.reviewerDeskBadgeApproved;
        badgeLabel = 'Watching CI';
    } else if (kind === 'working') {
        badgeStyle = s.reviewerDeskBadgeWorking;
        badgeLabel = 'Reviewing';
    }
    const showFeedbackBtn = kind !== 'none';
    const showDismiss = kind === 'approved_done' || kind === 'changes_followup';
    const showRemoveFromDesk = kind === 'pending' || kind === 'working' || kind === 'changes_on_desk';
    return (
        <div style={s.reviewerPrRow} data-testid={`reviewer-pr-${pr.id}`}>
            <div style={s.reviewerPrMain}>
                <a href={pr.url} target="_blank" rel="noopener noreferrer" style={s.reviewerPrId} title={`Open review request #${pr.id}`}>#{pr.id}</a>
                <a href={pr.url} target="_blank" rel="noopener noreferrer" style={s.reviewerPrTitle} title={pr.title}>{pr.title}</a>
                {pr.storyNumber && <span style={s.reviewerPrStory}>{pr.storyNumber}</span>}
            </div>
            <div style={s.reviewerPrMeta}>
                <span style={s.reviewerPrBranch} title={pr.sourceBranch || undefined}>{pr.sourceBranch || 'unknown branch'}</span>
                <span>{pr.createdBy?.displayName || pr.createdBy?.uniqueName || 'Unknown author'}</span>
                {nComments > 0 && (
                    <span style={s.reviewerPrCommentCount}>{nComments} local thread{nComments === 1 ? '' : 's'}</span>
                )}
            </div>
            <div style={s.reviewerPrActions}>
                {kind === 'none' ? (
                    pr.reviewerPickupEligible === false ? (
                        <span style={s.reviewerPickExcluded} title="Dismissed from the desk card, or completed in the review adapter / story status. Not offered for pickup.">
                            Not available for pickup
                        </span>
                    ) : (
                        <button
                            type="button"
                            style={s.reviewerPickBtn}
                            onClick={() => { void pickReviewerPr(pr); }}
                            disabled={pickingReviewerPrId === pr.id}
                            data-testid={`reviewer-pick-pr-${pr.id}`}
                            aria-label={`Pick up PR #${pr.id}`}
                        >
                            {pickingReviewerPrId === pr.id ? 'Picking...' : 'Pick Up'}
                        </button>
                    )
                ) : (
                    <>
                        {kind === 'watching_build' ? (
                            <span
                                style={badgeStyle}
                                data-testid={`reviewer-desk-badge-${pr.id}`}
                                role="status"
                                title="PR approved — waiting for CI build result. Desk clears automatically."
                            >
                                Watching CI
                            </span>
                        ) : kind === 'pending' ? (
                            isRunning ? (
                                <span
                                    style={s.reviewerDeskBadgeWorking}
                                    data-testid={`reviewer-desk-badge-${pr.id}`}
                                    role="status"
                                >
                                    Reviewing
                                </span>
                            ) : (
                                <button
                                    type="button"
                                    style={s.reviewerPickBtn}
                                    onClick={() => { void (onStartReview ? onStartReview() : pickReviewerPr(pr)); }}
                                    disabled={pickingReviewerPrId === pr.id}
                                    data-testid={`reviewer-start-review-${pr.id}`}
                                    aria-label={`Start review of PR #${pr.id}`}
                                >
                                    {pickingReviewerPrId === pr.id ? 'Starting...' : 'Start Review'}
                                </button>
                            )
                        ) : (
                            <span
                                style={badgeStyle}
                                data-testid={`reviewer-desk-badge-${pr.id}`}
                                role="status"
                                aria-label={`PR #${pr.id}: ${badgeLabel}`}
                            >
                                {badgeLabel}
                            </span>
                        )}
                        <div style={s.reviewerPrActionRow}>
                            {showFeedbackBtn && (
                                <button
                                    type="button"
                                    style={s.reviewerTextBtn}
                                    onClick={() => { openReviewerFeedback(pr); }}
                                >
                                    View feedback{nComments > 0 ? ` (${nComments})` : ''}
                                </button>
                            )}
                            {showRemoveFromDesk && (
                                <button
                                    type="button"
                                    style={s.reviewerTextBtn}
                                    onClick={() => {
                                        if (window.confirm(`Remove PR #${pr.id} from ${shownName}'s desk? This does not change the review adapter; you can pick it up again later.`)) {
                                            void removeActivePrFromReviewerDesk(pr.id);
                                        }
                                    }}
                                >
                                    Remove from desk
                                </button>
                            )}
                            {showDismiss && (
                                <button
                                    type="button"
                                    style={s.reviewerTextBtn}
                                    onClick={() => { void dismissReviewerDeskRow(pr.id); }}
                                >
                                    Dismiss
                                </button>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export function ReviewerDeskPanel(props: ReviewerDeskPanelProps) {
    const {
        shownName,
        currentPhase,
        reviewerDeskPrs,
        reviewerAvailablePrs,
        reviewerPrError,
        reviewerPrLoading,
        reviewerBranchFilter,
        setReviewerBranchFilter,
        reviewerQuery,
        setReviewerQuery,
        reviewerPrBanner,
        reviewerAutoPick,
        reviewerAutoPickBlocked,
        loadReviewerPrs,
        pickingReviewerPrId,
        pickReviewerPr,
        openReviewerFeedback,
        dismissReviewerDeskRow,
        removeActivePrFromReviewerDesk,
        reviewerFeedbackOpen,
        setReviewerFeedbackOpen,
        reviewerFeedbackThreads,
        reviewerFeedbackLoading,
        onStartReview,
        isRunning,
    } = props;

    const rowProps = {
        shownName,
        pickingReviewerPrId,
        pickReviewerPr,
        openReviewerFeedback,
        dismissReviewerDeskRow,
        removeActivePrFromReviewerDesk,
        onStartReview,
        isRunning,
    };

    return (
        <>
            {currentPhase === 'pending-review' && (
                <p style={s.reviewerPendingReviewHint} role="note">
                    PR on desk in <strong>pending-review</strong>. When <strong>global and reviewer step mode are both off</strong>, the server starts the reviewer CLI headless (no new terminal): logs under{' '}
                    <span style={s.inlinePath}>.agent-output/reviewer-*.log</span> and{' '}
                    <span style={s.inlinePath}>.agent-spawns.log</span>; PID in{' '}
                    <span style={s.inlinePath}>.reviewer-status.json</span> as{' '}
                    <span style={s.inlinePath}>spawnedPid</span> when started.
                    If step mode prevents auto-spawn or spawn failed, read <span style={s.inlinePath}>skills/reviewer/SKILL.md</span> and run the review yourself.
                    Reviewer on the floor: <strong>{shownName}</strong> (configurable).
                </p>
            )}
            <div style={s.reviewerPrPanelsColumn}>
                {reviewerPrError && (
                    <p role="alert" style={{ ...s.emptyText, color: 'var(--error)' }}>{reviewerPrError}</p>
                )}
                <section style={s.reviewerDeskPanel} aria-label={`Pull requests on ${shownName}'s desk`}>
                    <h2 style={s.reviewerPickupTitle}>On {shownName}&apos;s desk</h2>
                    <p style={s.reviewerPickupSub}>
                        <strong>Pick Up</strong> and <span style={s.inlinePath}>/api/pr/created</span> assign a PR here even when global or reviewer step mode is on. Auto-spawn of the reviewer CLI (headless) runs only when <strong>both</strong> step modes are off; otherwise the PR is still on the desk in <span style={s.inlinePath}>pending-review</span> and you run the review from <span style={s.inlinePath}>skills/reviewer/SKILL.md</span>.
                    </p>
                    {!reviewerPrError && reviewerPrLoading && reviewerDeskPrs.length === 0 ? (
                        <p style={s.emptyText}>Loading desk...</p>
                    ) : !reviewerPrError && reviewerDeskPrs.length === 0 ? (
                        <p style={s.emptyText}>Nothing on desk. Choose a PR under Available, or wait for the workflow to assign one.</p>
                    ) : !reviewerPrError ? (
                        <div style={s.reviewerPrList}>{reviewerDeskPrs.map((pr) => <ReviewerPrRowView key={pr.id} pr={pr} {...rowProps} />)}</div>
                    ) : null}
                </section>

                <section style={s.reviewerPickupPanel} aria-label="Available pull requests for review">
                    <div style={s.reviewerPickupHeader}>
                        <div>
                            <h2 style={s.reviewerPickupTitle}>Available PRs</h2>
                            <p style={s.reviewerPickupSub}>
                                Active review requests matching the filters below (manual <strong>Pick Up</strong> per row). This list does not include requests already on the desk above.
                                {reviewerAutoPick && ' Optional `scheduler.agents.reviewer.autoPickAdoList`: while idle, auto-pick the first row here (blocked when global or reviewer step mode is on).'}
                                {reviewerAutoPickBlocked && ' (That auto-list pick is waiting: turn off global or reviewer step mode.)'}
                            </p>
                        </div>
                        <button type="button" style={s.reviewerRefreshBtn} onClick={() => { void loadReviewerPrs(); }} disabled={reviewerPrLoading}>
                            {reviewerPrLoading ? 'Loading...' : 'Refresh'}
                        </button>
                    </div>
                    <div style={s.reviewerFilters}>
                        <label style={s.reviewerFilterLabel}>
                            Branch prefix
                            <input value={reviewerBranchFilter} onChange={(e) => setReviewerBranchFilter(e.target.value)} placeholder="teams/" style={s.reviewerFilterInput} />
                        </label>
                        <label style={s.reviewerFilterLabel}>
                            Search
                            <input value={reviewerQuery} onChange={(e) => setReviewerQuery(e.target.value)} placeholder="story, title, author" style={s.reviewerFilterInput} />
                        </label>
                    </div>
                    {reviewerPrBanner && (
                        <p role="status" style={{ ...s.reviewerPickupBanner, color: reviewerPrBanner.tone === 'error' ? 'var(--error)' : 'var(--success)' }}>
                            {reviewerPrBanner.text}
                        </p>
                    )}
                    {!reviewerPrError && reviewerPrLoading && reviewerAvailablePrs.length === 0 ? (
                        <p style={s.emptyText}>Loading PRs...</p>
                    ) : !reviewerPrError && reviewerAvailablePrs.length === 0 ? (
                        <p style={s.emptyText}>{reviewerDeskPrs.length > 0 ? 'No other PRs match these filters (or everything on desk is filtered out of this view).' : 'No active PRs match those filters'}</p>
                    ) : !reviewerPrError ? (
                        <div style={s.reviewerPrList}>{reviewerAvailablePrs.map((pr) => <ReviewerPrRowView key={pr.id} pr={pr} {...rowProps} />)}</div>
                    ) : null}
                </section>
            </div>
            {reviewerFeedbackOpen && (
                <div
                    style={s.reviewerFeedbackBackdrop}
                    role="presentation"
                    onClick={() => { setReviewerFeedbackOpen(null); }}
                >
                    <div
                        style={s.reviewerFeedbackPanel}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="reviewer-feedback-title"
                        onClick={(e) => { e.stopPropagation(); }}
                    >
                        <div style={s.reviewerFeedbackHeader}>
                            <h2 id="reviewer-feedback-title" style={s.reviewerFeedbackTitle}>
                                PR #{reviewerFeedbackOpen.prId}
                                <span style={s.reviewerFeedbackTitleSub}>{reviewerFeedbackOpen.title}</span>
                            </h2>
                            <button
                                type="button"
                                style={s.reviewerFeedbackClose}
                                onClick={() => { setReviewerFeedbackOpen(null); }}
                                aria-label="Close"
                            >
                                Close
                            </button>
                        </div>
                        <p style={s.reviewerFeedbackHint}>
                            Local threads from `.reviewer-comments.json` and review items copied onto the story owner when changes were requested. Does not call the review adapter.
                        </p>
                        {reviewerFeedbackLoading ? (
                            <p style={s.emptyText}>Loading feedback...</p>
                        ) : reviewerFeedbackThreads.length === 0 ? (
                            <p style={s.emptyText}>No local review threads found for this PR.</p>
                        ) : (
                            <div style={s.reviewerFeedbackList}>
                                {reviewerFeedbackThreads.map((t, i) => (
                                    <div key={t.id || `thread-${i}`} style={s.reviewerFeedbackThread}>
                                        <div style={s.reviewerFeedbackThreadMeta}>
                                            {t.file && <span style={s.reviewerFeedbackFile}>{t.file}{t.line != null ? `:${t.line}` : ''}</span>}
                                            {t.category && <span style={s.reviewerFeedbackCat}>{t.category}</span>}
                                            {t.status && <span style={s.reviewerFeedbackCat}>{t.status}</span>}
                                        </div>
                                        <p style={s.reviewerFeedbackBody}>{t.comment}</p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
ReviewerDeskPanel.displayName = 'ReviewerDeskPanel';
