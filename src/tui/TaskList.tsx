import React from 'react';
import { Box, Text } from 'ink';

interface Task { id?: string; number?: string; name: string; status: string; hours?: number }
interface Props { tasks: Task[]; currentTask: string | null }

const STATUS_ICON: Record<string, { icon: string; color: string }> = {
    pending:     { icon: '○', color: 'white' },
    in_progress: { icon: '◉', color: 'yellow' },
    complete:    { icon: '✓', color: 'green' },
    completed:   { icon: '✓', color: 'green' },
    failed:      { icon: '✖', color: 'red' },
};

export function TaskList({ tasks, currentTask }: Props) {
    if (tasks.length === 0) return <Text dimColor>No tasks</Text>;

    return (
        <Box flexDirection="column">
            <Text bold>Tasks</Text>
            {tasks.map((t, i) => {
                const key = t.number ?? t.id ?? String(i);
                const s = STATUS_ICON[t.status] ?? { icon: '?', color: 'gray' };
                const isCurrent = currentTask != null && (t.number === currentTask || t.id === currentTask);
                return (
                    <Box key={key} gap={1}>
                        <Text color={s.color}>{s.icon}</Text>
                        <Text dimColor={!isCurrent} bold={isCurrent}>
                            {(t.number ?? t.id ?? '').padEnd(10)}
                        </Text>
                        <Text dimColor={!isCurrent}>{t.name}</Text>
                        {t.hours != null && t.hours > 0 && <Text dimColor> ({t.hours}h)</Text>}
                    </Box>
                );
            })}
        </Box>
    );
}
TaskList.displayName = 'TaskList';
