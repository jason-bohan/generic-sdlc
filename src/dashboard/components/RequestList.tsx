import type { Phase, RequestItem } from '../types';
import { agentDetailStyles as s } from './AgentDetail.styles';
import { REQUEST_TYPE_COLORS, REQUEST_TYPE_LABELS } from '../agent-detail-utils';

export interface RequestListProps {
    agentId: string;
    requests: RequestItem[];
    dismissedIds: Set<string>;
    selectedRequestIds: Set<string>;
    toggleRequest: (reqId: string) => void;
    dismissItem: (itemId: string, itemType: 'task' | 'request') => void;
    isPausedAtStep: boolean;
    currentPhase: Phase;
    isWrapUpDeskRequestId: (id: string) => boolean;
}

export function RequestList({
    agentId,
    requests,
    dismissedIds,
    selectedRequestIds,
    toggleRequest,
    dismissItem,
    isPausedAtStep,
    currentPhase,
    isWrapUpDeskRequestId,
}: RequestListProps) {
    return (
        <>
            {requests.filter((r) => !dismissedIds.has(r.id)).map((req) => {
                const colors = REQUEST_TYPE_COLORS[req.type] ?? REQUEST_TYPE_COLORS.review;
                const isResolved = req.status === 'resolved';
                const isSelected = selectedRequestIds.has(req.id);
                const canSelect = !isResolved && (isPausedAtStep || (agentId === 'devops' && currentPhase === 'build-passed' && isWrapUpDeskRequestId(req.id)));
                const location = req.file ? `${req.file}${req.line ? `:${req.line}` : ''}` : '';
                return (
                    <button
                        key={req.id}
                        data-testid={`${agentId}-request-${req.id}`}
                        onClick={canSelect ? () => toggleRequest(req.id) : undefined}
                        style={{
                            ...s.taskPill,
                            ...s.requestPill,
                            borderColor: isSelected ? colors.dot : 'rgba(245, 158, 11, 0.55)',
                            background: isSelected ? 'rgba(245, 158, 11, 0.2)' : colors.bg,
                            opacity: isResolved ? 0.55 : 1,
                            cursor: canSelect ? 'pointer' : 'default',
                            boxShadow: isSelected ? '0 0 0 2px rgba(245, 158, 11, 0.28)' : 'none',
                        }}
                    >
                        <span style={{ ...s.pillStatusDot, background: isResolved ? 'var(--text-tertiary)' : colors.dot }} />
                        <span style={{ ...s.pillId, color: isResolved ? 'var(--text-tertiary)' : colors.fg }}>{req.id}</span>
                        <span style={{ ...s.pillName, ...(isResolved ? { textDecoration: 'line-through', color: 'var(--text-tertiary)' } : {}) }} title={req.summary}>{req.summary}</span>
                        <span style={{ ...s.pillCategory, background: colors.bg, color: colors.fg, ...(isResolved ? { opacity: 0.5 } : {}) }}>{REQUEST_TYPE_LABELS[req.type] ?? req.type}</span>
                        {req.severity && <span style={{ ...s.requestSeverity, ...(isResolved ? { opacity: 0.5 } : {}) }}>{req.severity}</span>}
                        {location && <span style={s.requestLocation} title={location}>{location}</span>}
                        {(isResolved || isWrapUpDeskRequestId(req.id)) && (
                            <span
                                role="button"
                                data-testid={`${agentId}-dismiss-request-${req.id}`}
                                onClick={(e) => { e.stopPropagation(); dismissItem(req.id, 'request'); }}
                                style={s.dismissBtn}
                                title="Dismiss"
                            >&times;</span>
                        )}
                    </button>
                );
            })}
        </>
    );
}
RequestList.displayName = 'RequestList';
