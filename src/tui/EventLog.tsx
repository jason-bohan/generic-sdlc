import React from 'react';
import { Box, Text } from 'ink';

interface StatusEvent { timestamp: string; type: string; message: string }
interface Props { events: StatusEvent[]; maxItems?: number }

const TYPE_COLOR: Record<string, string> = {
    success: 'green', info: 'gray', warning: 'yellow', error: 'red',
};

function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h`;
}

export function EventLog({ events, maxItems = 8 }: Props) {
    const recent = [...events].reverse().slice(0, maxItems);
    const hiddenCount = events.length - recent.length;

    if (recent.length === 0) return <Text dimColor>No events</Text>;

    return (
        <Box flexDirection="column">
            <Text bold>Events</Text>
            {hiddenCount > 0 && <Text dimColor>... {hiddenCount} earlier events</Text>}
            {recent.map((e, i) => (
                <Box key={i} gap={1}>
                    <Text dimColor>{relativeTime(e.timestamp).padStart(4)}</Text>
                    <Text color={TYPE_COLOR[e.type] ?? 'white'}>│</Text>
                    <Text wrap="truncate">{e.message}</Text>
                </Box>
            ))}
        </Box>
    );
}
EventLog.displayName = 'EventLog';
