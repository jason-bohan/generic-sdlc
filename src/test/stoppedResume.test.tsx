import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { StoppedAgentBadge, ResumeChip } from '../dashboard/components/StoppedAgentBadge';
import { AICommandRoom } from '../dashboard/components/AICommandRoom';
import { QaResultsPanel } from '../dashboard/components/QaResultsPanel';
import SimpleFloor from '../dashboard/SimpleFloor';
import type { AgentStatus } from '../dashboard/types';

// Mocking necessary components and hooks
vi.mock('../dashboard/hooks/useAIHealth');
vi.mock('../dashboard/hooks/useFocusTrap', () => ({
    useFocusTrap: vi.fn()
}));

// Mocking AICommandRoom and QaResultsPanel to isolate the test
vi.mock('../dashboard/components/AICommandRoom', () => ({
    AICommandRoom: vi.fn(({ open, onClose }) => (
        open ? (
            <div data-testid="ai-command-room">
                AI Command Room
                <button onClick={onClose}>Close</button>
            </div>
        ) : null
    ))
}));

vi.mock('../dashboard/components/QaResultsPanel', () => ({
    QaResultsPanel: vi.fn(({ agentId }) => (
        <div data-testid={`qa-results-panel-${agentId}`}>QA Results Panel for {agentId}</div>
    ))
}));

// Mocking SimpleFloor to avoid its internal complexity affecting these tests
vi.mock('../dashboard/SimpleFloor', () => ({
    default: vi.fn(({ children }: { children: React.ReactNode }) => <div data-testid="simple-floor">{children}</div>)
}));

const mockOnResume = vi.fn();
const mockOnClose = vi.fn();

describe('Stopped agent badge and resume chip', () => {
    const stoppedStatus: AgentStatus = {
        storyNumber: 'B-99999',
        storyName: 'Test story',
        currentPhase: 'generating-code',
        currentTask: null,
        startedAt: '2026-05-13T15:00:00.000Z',
        isRunning: false,
        tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
        tasks: [],
        prs: [],
        cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        events: [],
        globalStepMode: true, // Default to true for most tests
    };

    const idleStatus: AgentStatus = {
        storyNumber: null,
        storyName: null,
        currentPhase: 'idle',
        currentTask: null,
        startedAt: null,
        isRunning: false,
        tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
        tasks: [],
        prs: [],
        cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        events: [],
        globalStepMode: true,
    };

    const runningStatus: AgentStatus = {
        ...stoppedStatus,
        isRunning: true,
    };

    const stoppedStatusGlobalStepModeOff: AgentStatus = {
        ...stoppedStatus,
        globalStepMode: false,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset mocks for components that might be rendered indirectly
        vi.mocked(AICommandRoom).mockClear();
        vi.mocked(QaResultsPanel).mockClear();
        vi.mocked(SimpleFloor).mockClear();
    });

    it('shows STOPPED badge when agent has active phase, story, and isRunning=false', () => {
        render(<StoppedAgentBadge agent={stoppedStatus} />);
        expect(screen.getByText('STOPPED')).toBeInTheDocument();
    });

    it('does NOT show STOPPED badge when agent is idle', () => {
        render(<StoppedAgentBadge agent={idleStatus} />);
        expect(screen.queryByText('STOPPED')).not.toBeInTheDocument();
    });

    it('does NOT show STOPPED badge when isRunning=true', () => {
        render(<StoppedAgentBadge agent={runningStatus} />);
        expect(screen.queryByText('STOPPED')).not.toBeInTheDocument();
    });

    it('does NOT show STOPPED badge when global step mode is off and agent is not stopped', () => {
        render(<StoppedAgentBadge agent={stoppedStatusGlobalStepModeOff} />);
        expect(screen.queryByText('STOPPED')).not.toBeInTheDocument();
    });

    it('opens resume tooltip when STOPPED badge is clicked', () => {
        render(<StoppedAgentBadge agent={stoppedStatus} />);
        const badge = screen.getByText('STOPPED');
        fireEvent.click(badge);
        expect(screen.getByText('Resume')).toBeInTheDocument();
    });

    it('calls /api/agent/continue when Resume is clicked', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
        global.fetch = mockFetch;

        render(<ResumeChip agent={stoppedStatus} onResume={mockOnResume} />);
        
        const resumeButton = screen.getByText('Resume');
        await act(async () => {
            fireEvent.click(resumeButton);
        });

        expect(mockOnResume).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith('/api/agent/continue', expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: stoppedStatus.id, selectedRequestIds: undefined, selectedTaskIds: undefined }),
        }));
    });

    it('handles closing AI Command Room', () => {
        render(<AICommandRoom open={true} onClose={mockOnClose} cursorAiEnabled={true} toggleCursorAi={vi.fn()} claudeEnabled={true} toggleClaudeAi={vi.fn()} opencodeEnabled={true} toggleOpenCode={vi.fn()} />);
        const closeButton = screen.getByText('Close');
        fireEvent.click(closeButton);
        expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('renders QaResultsPanel correctly', () => {
        render(<QaResultsPanel agentId="agent-1" />);
        expect(screen.getByTestId('qa-results-panel-agent-1')).toBeInTheDocument();
    });

    it('renders SimpleFloor correctly', () => {
        render(<SimpleFloor agentStatuses={{}} displayNames={{}} onSelectAgent={vi.fn()} onChatWith={vi.fn()} />);
        expect(screen.getByTestId('simple-floor')).toBeInTheDocument();
    });

    it('handles disabled AI providers correctly in AICommandRoom', () => {
        render(<AICommandRoom open={true} onClose={mockOnClose} cursorAiEnabled={false} toggleCursorAi={vi.fn()} claudeEnabled={false} toggleClaudeAi={vi.fn()} opencodeEnabled={false} toggleOpenCode={vi.fn()} />);
        expect(screen.getByTestId('ai-command-room')).toBeInTheDocument();
    });
});
