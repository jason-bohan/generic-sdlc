import { describe, it, expect } from 'vitest';
import type { Phase } from '../dashboard/types';
import type { StatusEvent } from '../dashboard/types';
import {
    PHASE_LABELS,
    PHASE_LABELS_DESK,
    PHASE_COLORS,
    EVENT_COLORS,
} from '../dashboard/phase-labels';

const ALL_PHASES: Phase[] = [
    'idle', 'pending-approval', 'reading-story', 'planning', 'analyzing',
    'creating-tasks', 'generating-code', 'validating', 'creating-pr',
    'watching-reviews', 'addressing-feedback', 'running-cypress',
    'complete', 'error',
    'pending-review', 'reviewing', 'commenting', 'approved',
    'changes-requested', 'waiting-for-fixes',
    'pending-build', 'monitoring-build', 'build-passed', 'build-failed',
    'researching', 'designing', 'spec-ready', 'collaborating',
];

const ALL_EVENT_TYPES: StatusEvent['type'][] = ['info', 'success', 'warning', 'error', 'phase', 'verdict'];

/**
 * Verifies that a PHASE_LABELS record covers every Phase union member.
 */

function assertAllPhasesCovered(labels: Record<string, string>, source: string) {
    for (const phase of ALL_PHASES) {
        expect(labels[phase], `${source} is missing label for phase "${phase}"`).toBeDefined();
        expect(typeof labels[phase]).toBe('string');
        expect(labels[phase].length).toBeGreaterThan(0);
    }
}

describe('PHASE_LABELS completeness', () => {
    it('phase-labels PHASE_LABELS covers all phases', () => {
        assertAllPhasesCovered(PHASE_LABELS, 'PHASE_LABELS');
    });

    it('phase-labels PHASE_LABELS_DESK covers all phases', () => {
        assertAllPhasesCovered(PHASE_LABELS_DESK, 'PHASE_LABELS_DESK');
    });

    it('phase-labels PHASE_COLORS covers all phases', () => {
        assertAllPhasesCovered(PHASE_COLORS, 'PHASE_COLORS');
    });

    it('phase-labels EVENT_COLORS covers all event types', () => {
        for (const t of ALL_EVENT_TYPES) {
            expect(EVENT_COLORS[t], `EVENT_COLORS missing "${t}"`).toBeDefined();
            expect(typeof EVENT_COLORS[t]).toBe('string');
            expect(EVENT_COLORS[t]!.length).toBeGreaterThan(0);
        }
    });

    it('Floor3D HUD uses shared PHASE_LABELS from phase-labels', async () => {
        const fs = await import('fs');
        const source = fs.readFileSync('src/dashboard/floor3d/HudPanels.tsx', 'utf-8');
        expect(
            /from ['"]\.\.\/phase-labels['"]/.test(source),
            'HudPanels must import PHASE_LABELS from ../phase-labels',
        ).toBe(true);
        expect(source.includes('PHASE_LABELS['), 'HudPanels must use PHASE_LABELS for phase display').toBe(true);
    });

    it('DashboardContext drives phase notifications via hooks/usePolling', async () => {
        const fs = await import('fs');
        const source = fs.readFileSync('src/dashboard/DashboardContext.tsx', 'utf-8');
        expect(
            /from ['"]\.\/hooks\/usePolling['"]/.test(source),
            'DashboardContext must drive phase notifications via hooks/usePolling',
        ).toBe(true);
        const hookSource = fs.readFileSync('src/dashboard/hooks/usePolling.ts', 'utf-8');
        expect(
            /from ['"]\.\.\/phase-labels['"]/.test(hookSource),
            'usePolling must import PHASE_LABELS from ../phase-labels',
        ).toBe(true);
        expect(hookSource.includes('PHASE_LABELS['), 'usePolling must use PHASE_LABELS for notifications').toBe(true);
    });
});
