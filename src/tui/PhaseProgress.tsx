import React from 'react';
import { Box, Text } from 'ink';

const PHASES = [
    'idle',
    'pending-approval',
    'reading-story',
    'planning',
    'creating-tasks',
    'analyzing',
    'generating-code',
    'validating',
    'creating-pr',
    'watching-reviews',
    'addressing-feedback',
    'running-cypress',
    'complete',
] as const;

const LABELS: Record<string, string> = {
    'idle': 'Idle',
    'pending-approval': 'Pending Approval',
    'reading-story': 'Reading Story',
    'planning': 'Planning',
    'creating-tasks': 'Creating Tasks',
    'analyzing': 'Analyzing',
    'generating-code': 'Coding',
    'validating': 'Validating',
    'creating-pr': 'Creating PR',
    'watching-reviews': 'Reviews',
    'addressing-feedback': 'Feedback',
    'running-cypress': 'Cypress',
    'complete': 'Done',
    'error': 'Error',
    'pending-review': 'Pending Review',
    'reviewing': 'Reviewing',
    'commenting': 'Commenting',
    'approved': 'Approved',
    'changes-requested': 'Changes Requested',
    'waiting-for-fixes': 'Waiting for Fixes',
    'pending-build': 'Pending Build',
    'monitoring-build': 'Building',
    'build-passed': 'Build Passed',
    'build-failed': 'Build Failed',
};

interface Props { currentPhase: string }

export function PhaseProgress({ currentPhase }: Props) {
    const currentIdx = PHASES.indexOf(currentPhase as any);
    const isKnownPhase = currentIdx >= 0;
    const isSpecialPhase = !isKnownPhase && currentPhase !== 'error';

    return (
        <Box flexDirection="column">
            <Text bold>Phase</Text>
            {PHASES.map((phase, i) => {
                const isCurrent = phase === currentPhase;
                const isPast = isKnownPhase && currentIdx > i && currentPhase !== 'error';
                const prefix = isCurrent ? '▸ ' : isPast ? '✓ ' : '  ';
                const color = isCurrent ? 'green' : isPast ? 'gray' : 'white';
                return (
                    <Text key={phase} color={color} bold={isCurrent} dimColor={!isCurrent && !isPast}>
                        {prefix}{LABELS[phase] ?? phase}
                    </Text>
                );
            })}
            {currentPhase === 'error' && (
                <Text color="red" bold>✖ Error</Text>
            )}
            {isSpecialPhase && (
                <Text color="yellow" bold>▸ {LABELS[currentPhase] ?? currentPhase}</Text>
            )}
        </Box>
    );
}
PhaseProgress.displayName = 'PhaseProgress';
