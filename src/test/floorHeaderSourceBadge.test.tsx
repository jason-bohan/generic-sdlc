import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FloorHeader, type FloorHeaderProps } from '../dashboard/components/FloorHeader';

function renderHeader(overrides: Partial<FloorHeaderProps> = {}) {
    const props: FloorHeaderProps = {
        profileName: 'Jason',
        globalStepMode: false,
        toggleGlobalStepMode: vi.fn(),
        pausedAgentCount: 0,
        cursorAiEnabled: true,
        toggleCursorAi: vi.fn(),
        claudeEnabled: true,
        toggleClaudeAi: vi.fn(),
        onOpenCreateStory: vi.fn(),
        onRefreshStatus: vi.fn(),
        notificationCount: 0,
        colorScheme: 'dark',
        setColorScheme: vi.fn(),
        ...overrides,
    };
    return render(<FloorHeader {...props} />);
}

describe('FloorHeader source badge', () => {
    it('labels the primary checkout as Main/Prod', () => {
        renderHeader({ worktreeBranch: 'Main/Prod', isWorktree: false, worktreeHue: 200 });

        const badge = screen.getByText('MAIN/PROD: Main/Prod');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveAttribute('title', 'Running from the main production checkout');
    });

    it('keeps branch names visible for git worktrees', () => {
        renderHeader({ worktreeBranch: 'test/regression-hardening', isWorktree: true, worktreeHue: 330 });

        const badge = screen.getByText('WORKTREE: test/regression-hardening');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveAttribute('title', 'Running from a git worktree');
    });

    it('does not show a source badge before worktree info loads', () => {
        renderHeader({ worktreeBranch: null });

        expect(screen.queryByText(/MAIN\/PROD:/)).not.toBeInTheDocument();
        expect(screen.queryByText(/WORKTREE:/)).not.toBeInTheDocument();
    });
});
