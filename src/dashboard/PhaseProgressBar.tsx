import React from 'react';
import type { Phase } from './types';

const WORKFLOW_PHASES: { key: Phase; label: string }[] = [
  { key: 'reading-story', label: 'Read' },
  { key: 'planning', label: 'Plan' },
  { key: 'analyzing', label: 'Analyze' },
  { key: 'generating-code', label: 'Code' },
  { key: 'validating', label: 'Validate' },
  { key: 'creating-pr', label: 'PR' },
  { key: 'watching-reviews', label: 'Review' },
  { key: 'complete', label: 'Done' },
];

interface PhaseProgressBarProps {
  currentPhase: Phase;
  accentColor?: string;
}

export function PhaseProgressBar({ currentPhase, accentColor = '#D97706' }: PhaseProgressBarProps) {
  const currentIndex = WORKFLOW_PHASES.findIndex((p) => p.key === currentPhase);

  return (
    <div style={styles.container}>
      <div style={styles.track}>
        {WORKFLOW_PHASES.map((phase, i) => {
          const isComplete = i < currentIndex;
          const isCurrent = i === currentIndex;
          const isUpcoming = i > currentIndex;

          return (
            <React.Fragment key={phase.key}>
              {i > 0 && (
                <div
                  style={{
                    ...styles.connector,
                    backgroundColor: isComplete ? accentColor : 'var(--surface-3, #333)',
                  }}
                />
              )}
              <div style={styles.step}>
                <div
                  style={{
                    ...styles.dot,
                    backgroundColor: isComplete || isCurrent ? accentColor : 'var(--surface-3, #333)',
                    boxShadow: isCurrent ? `0 0 8px ${accentColor}` : 'none',
                    transform: isCurrent ? 'scale(1.3)' : 'scale(1)',
                  }}
                />
                <span
                  style={{
                    ...styles.label,
                    color: isCurrent ? accentColor : isComplete ? '#ccc' : '#666',
                    fontWeight: isCurrent ? 700 : 400,
                  }}
                >
                  {phase.label}
                </span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
PhaseProgressBar.displayName = 'PhaseProgressBar';

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '8px 0',
  },
  track: {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
  },
  connector: {
    flex: 1,
    height: 2,
    minWidth: 8,
    transition: 'background-color 0.3s',
  },
  step: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    transition: 'all 0.3s',
  },
  label: {
    fontSize: 9,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
    transition: 'color 0.3s',
  },
};
