import type { TaskItem } from '../types';
import { agentDetailStyles as s } from './AgentDetail.styles';
import { getPlanningStatusColor, CATEGORY_BADGE_COLORS } from '../agent-detail-utils';

export interface TaskListProps {
    agentId: string;
    tasks: TaskItem[];
    dismissedIds: Set<string>;
    selectedTaskIds: Set<string>;
    toggleTask: (taskId: string) => void;
    dismissItem: (itemId: string, itemType: 'task' | 'request') => void;
    isPausedAtStep: boolean;
    taskSelectionAllowed: boolean;
    isRunning?: boolean;
}

export function TaskList({
    agentId,
    tasks,
    dismissedIds,
    selectedTaskIds,
    toggleTask,
    dismissItem,
    isPausedAtStep,
    taskSelectionAllowed,
    isRunning,
}: TaskListProps) {
    return (
        <>
            {tasks.filter((t) => !dismissedIds.has(t.id ?? (t as { number?: string }).number ?? '')).map((task) => {
                const normalizedStatus = (task.status as string) === 'complete' ? 'completed' : task.status;
                const taskId = task.id ?? (task as { number?: string }).number ?? '\u2014';
                const isDone = normalizedStatus === 'completed' || normalizedStatus === 'failed';
                const isInProgress = normalizedStatus === 'in_progress';
                const isSelected = selectedTaskIds.has(taskId);
                const statusColor = getPlanningStatusColor(task.agilityStatus, normalizedStatus);
                const catColors = task.category ? (CATEGORY_BADGE_COLORS[task.category] ?? { bg: 'rgba(120,113,108,0.12)', fg: '#78716c' }) : null;
                const rowTestId = `${agentId}-task-${String(taskId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                const canSelect = isPausedAtStep && taskSelectionAllowed && !isDone && !isInProgress && !isRunning;
                return (
                    <button
                        key={taskId}
                        data-testid={rowTestId}
                        onClick={canSelect ? () => toggleTask(taskId) : undefined}
                        style={{
                            ...s.taskPill,
                            borderColor: isSelected ? 'var(--accent)' : isInProgress ? '#0ea5e9' : statusColor,
                            background: isSelected ? 'rgba(99,102,241,0.08)' : isInProgress ? 'rgba(14,165,233,0.08)' : 'var(--bg-secondary)',
                            opacity: isDone ? 0.55 : 1,
                            cursor: canSelect ? 'pointer' : 'default',
                            boxShadow: isSelected ? '0 0 0 2px var(--accent)' : 'none',
                        }}
                    >
                        <span style={{ ...s.pillStatusDot, background: isInProgress ? '#0ea5e9' : statusColor }} />
                        <span style={{ ...s.pillId, ...(isDone ? { color: 'var(--text-tertiary)' } : isInProgress ? { color: '#0ea5e9' } : {}) }}>{taskId}</span>
                        <span style={{ ...s.pillName, ...(isDone ? { textDecoration: 'line-through', color: 'var(--text-tertiary)' } : {}) }} title={task.name}>{task.name}</span>
                        {catColors && (
                            <span style={{ ...s.pillCategory, background: catColors.bg, color: catColors.fg, ...(isDone ? { opacity: 0.5 } : {}) }}>{task.category}</span>
                        )}
                        {task.hours != null && <span style={s.pillHours}>{task.hours}h</span>}
                        {isDone && (
                            <span
                                role="button"
                                data-testid={`${agentId}-dismiss-task-${taskId}`}
                                onClick={(e) => { e.stopPropagation(); dismissItem(taskId, 'task'); }}
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
TaskList.displayName = 'TaskList';
