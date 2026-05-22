import type { PullRequest } from '../types';
import { getPrUrl } from '../types';
import { PR_STATUS_COLORS, prStatusLabel } from '../agent-detail-utils';
import { Section } from './DetailHelpers';
import { agentDetailStyles as s } from './AgentDetail.styles';

export interface AgentDetailPullRequestsSectionProps {
    prs: PullRequest[];
}

export function AgentDetailPullRequestsSection({ prs }: AgentDetailPullRequestsSectionProps) {
    return (
        <Section title="Pull Requests">
            {prs.length === 0 ? (
                <p style={s.emptyText}>No PRs created yet</p>
            ) : (
                <div style={s.prCardList}>
                    {prs.map((pr: PullRequest) => (
                        <a
                            key={pr.id}
                            href={getPrUrl(pr)}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={s.prCard}
                        >
                            <span style={{ ...s.prCardDot, background: PR_STATUS_COLORS[pr.status] }} />
                            <div style={s.prCardBody}>
                                <div style={s.prCardTop}>
                                    <span style={s.prCardId}>#{pr.id}</span>
                                    <span
                                        style={{
                                            ...s.prStatusBadge,
                                            borderColor: PR_STATUS_COLORS[pr.status],
                                            color: PR_STATUS_COLORS[pr.status],
                                        }}
                                    >
                                        {prStatusLabel(pr.status)}
                                    </span>
                                </div>
                                <span style={s.prCardTitle} title={pr.title}>{pr.title}</span>
                                <div style={s.prCardMeta}>
                                    <span style={s.prMetaPill}>
                                        {pr.comments} comment{pr.comments === 1 ? '' : 's'}
                                    </span>
                                    <span style={{ ...s.prMetaPill, color: 'var(--success)', borderColor: 'rgba(34, 197, 94, 0.35)' }}>
                                        {pr.approvals} approval{pr.approvals === 1 ? '' : 's'}
                                    </span>
                                </div>
                            </div>
                            <span style={s.prCardLink} aria-hidden="true">{'\u2197'}</span>
                        </a>
                    ))}
                </div>
            )}
        </Section>
    );
}
AgentDetailPullRequestsSection.displayName = 'AgentDetailPullRequestsSection';
