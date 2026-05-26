import { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusTrap } from './hooks/useFocusTrap';
import { useGridColumns } from './hooks/useGridColumns';
import { useAgentModels } from './hooks/useAgentModels';
import type { AgentProfile, AgentStatus } from './types';
import { AGENT_ROSTER, collectHeaderOpenPullRequests } from './types';
import { fetchUserProfile } from './userProfileApi';
import { useTheme } from './ThemeProvider';
import { simpleFloorLayoutStyles as styles } from './SimpleFloor.styles';
import { formatTokens } from './formatTokens';
import { AgentCard, STEP_MODE_CHECKPOINT_PHASES } from './components/AgentCard';
import { AgentTerminalSection } from './components/AgentTerminalSection';
import { CreateStoryModal } from './components/CreateStoryModal';
import { FloorStatsBar } from './components/FloorStatsBar';
import { FloorHeader } from './components/FloorHeader';

interface SimpleFloorProps {
    agentStatuses: Record<string, AgentStatus | null>;
    displayNames: Record<string, string>;
    onDisplayNamesChange?: (names: Record<string, string>) => void;
    onSelectAgent: (agent: AgentProfile) => void;
    onChatWith: (agent: AgentProfile) => void;
    onPickUpStory?: (agent: AgentProfile) => void;
    onRefreshStatus?: () => void;
    notificationCount?: number;
    onToggleNotifications?: () => void;
    externalMode?: string;
    onToggleTestRunner?: () => void;
    onSetExternalMode?: (mode: string) => void;
    onOpenLocalBacklog?: () => void;
    worktreeBranch?: string | null;
    isWorktree?: boolean;
    worktreeHue?: number;
}

export default function SimpleFloor({
    agentStatuses,
    displayNames: parentDisplayNames,
    onDisplayNamesChange,
    onSelectAgent,
    onChatWith,
    onPickUpStory,
    onRefreshStatus,
    notificationCount = 0,
    onToggleNotifications,
    externalMode,
    onToggleTestRunner,
    onSetExternalMode,
    onOpenLocalBacklog,
    worktreeBranch,
    isWorktree = false,
    worktreeHue,
}: SimpleFloorProps) {
    const gridCols = useGridColumns();
    const activeAgents = AGENT_ROSTER.filter((a) => a.active);
    const availableModels = useAgentModels();
    const [showCreateStory, setShowCreateStory] = useState(false);
    const createStoryRef = useRef<HTMLDivElement>(null);
    useFocusTrap(createStoryRef, showCreateStory);
    const [storyForm, setStoryForm] = useState({ name: '', description: '', estimate: '', team: '', owner: '', classOfService: '' });
    const [storyStatus, setStoryStatus] = useState<'idle' | 'enriching' | 'creating' | 'done' | 'error'>('idle');
    const [storyResult, setStoryResult] = useState('');
    const [storyUrl, setStoryUrl] = useState('');
    const [storyTeams, setStoryTeams] = useState<{ id: string; name: string }[]>([]);
    const [storyMembers, setStoryMembers] = useState<{ id: string; name: string }[]>([]);
    const [classOfServiceValues, setClassOfServiceValues] = useState<{ id: string; name: string }[]>([]);
    const [creationTokens, setCreationTokens] = useState<{ input: number; output: number } | null>(null);
    const [execMode, setExecMode] = useState<'local' | 'balanced' | 'speed'>('balanced');
    const [tokenLedger, setTokenLedger] = useState<Record<string, { storyName: string | null; totals: { input: number; output: number } }>>({});
    const [showLedger, setShowLedger] = useState(false);
    const [activeProject, setActiveProject] = useState('');
    const [availableProjects, setAvailableProjects] = useState<string[]>([]);
    const [testSummary, setTestSummary] = useState<{ total_passed: number; total_failed: number; last_run_at: string | null } | null>(null);
    const [showTestBreakdown, setShowTestBreakdown] = useState(false);
    const [testRuns, setTestRuns] = useState<Array<{ id: number; spec_file: string; passed: number; failed: number; skipped: number; duration_ms: number; recorded_at: string }>>([]);
    const [globalStepMode, setGlobalStepMode] = useState(false);
    const [cursorAiEnabled, setCursorAiEnabled] = useState(true);
    const [claudeEnabled, setClaudeEnabled] = useState(true);
    const [profileName, setProfileName] = useState('');
    const { colorScheme, setColorScheme } = useTheme();
    const integrationMock = externalMode === 'mock';
    useEffect(() => {
        fetch('/api/agent/step-mode/global').then(r => r.json()).then(d => setGlobalStepMode(!!d.globalStepMode)).catch(() => {});
        fetch('/api/cursor-ai').then(r => r.json()).then(d => {
            if (typeof d.enabled === 'boolean') setCursorAiEnabled(d.enabled);
        }).catch(() => {});
        fetch('/api/claude-ai').then(r => r.json()).then(d => {
            if (typeof d.enabled === 'boolean') setClaudeEnabled(d.enabled);
        }).catch(() => {});
        fetchUserProfile().then(p => { if (p.displayName) setProfileName(p.displayName); }).catch(() => {});
    }, []);
    const toggleCursorAi = useCallback(async () => {
        try {
            const next = !cursorAiEnabled;
            const res = await fetch('/api/cursor-ai', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            });
            if (res.ok) {
                const d = await res.json();
                if (typeof d.enabled === 'boolean') setCursorAiEnabled(d.enabled);
            }
        } catch { /* silent */ }
    }, [cursorAiEnabled]);
    const toggleClaudeAi = useCallback(async () => {
        try {
            const next = !claudeEnabled;
            const res = await fetch('/api/claude-ai', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            });
            if (res.ok) {
                const d = await res.json();
                if (typeof d.enabled === 'boolean') setClaudeEnabled(d.enabled);
            }
        } catch { /* silent */ }
    }, [claudeEnabled]);
    const toggleGlobalStepMode = useCallback(async () => {
        try {
            const turningOff = globalStepMode;
            const res = await fetch('/api/agent/step-mode/global', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ globalStepMode: !globalStepMode }),
            });
            if (res.ok) {
                const d = await res.json();
                setGlobalStepMode(!!d.globalStepMode);
                if (turningOff) {
                    const paused = AGENT_ROSTER.filter(a => {
                        const st = agentStatuses[a.id];
                        if (!st) return false;
                        return STEP_MODE_CHECKPOINT_PHASES.has(st.currentPhase ?? 'idle') && !st.isRunning;
                    });
                    void Promise.allSettled(paused.map(a =>
                        fetch('/api/agent/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: a.id }) })
                    ));
                }
            }
        } catch { /* silent */ }
    }, [globalStepMode, agentStatuses]);
    useEffect(() => {
        fetch('/api/execution-mode').then(r => r.json()).then(d => { if (d.mode) setExecMode(d.mode); }).catch(() => {});
        fetch('/api/tokens/ledger').then(r => r.json()).then(d => setTokenLedger(d ?? {})).catch(() => {});
        const fetchProjects = () => fetch('/api/active-project').then(r => r.json()).then(d => {
            if (d.active) setActiveProject(d.active);
            if (Array.isArray(d.available) && d.available.length > 0) setAvailableProjects(d.available);
        });
        // Retry once after 3s in case the server wasn't ready on first render
        fetchProjects().catch(() => { setTimeout(() => fetchProjects().catch(() => {}), 3000); });
        const fetchSummary = () => fetch('/api/test-results?summary=1').then(r => r.json()).then(setTestSummary).catch(() => {});
        fetchSummary();
        const testPoll = setInterval(fetchSummary, 10_000);
        return () => clearInterval(testPoll);
    }, []);

    useEffect(() => {
        if (!showCreateStory) return;
        if (storyTeams.length === 0) {
            fetch('/api/planning/teams').then(r => r.json()).then(d => setStoryTeams(d.teams ?? [])).catch(() => {});
        }
        if (storyMembers.length === 0) {
            fetch('/api/planning/members').then(r => r.json()).then(d => setStoryMembers(d.members ?? [])).catch(() => {});
        }
        if (classOfServiceValues.length === 0) {
            fetch('/api/planning/class-of-service').then(r => r.json()).then(d => setClassOfServiceValues(d.values ?? [])).catch(() => {});
        }
    }, [showCreateStory]);

    const handleCreateStory = useCallback(async () => {
        if (!storyForm.name.trim()) return;
        if (!storyForm.classOfService?.trim()) {
            setStoryStatus('error');
            setStoryResult('Class of Service is required');
            return;
        }
        setStoryStatus('enriching');
        try {
            const res = await fetch('/api/planning/create-story', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: storyForm.name.trim(),
                    description: storyForm.description.trim() || undefined,
                    estimate: storyForm.estimate ? Number(storyForm.estimate) : undefined,
                    team: storyForm.team || undefined,
                    owner: storyForm.owner || undefined,
                    classOfService: storyForm.classOfService.trim(),
                }),
            });
            setStoryStatus('creating');
            const data = await res.json();
            if (data.gooseLog) {
                console.group('[Goose] Story Creation Log');
                console.log(data.gooseLog);
                console.groupEnd();
            }
            if (data.success) {
                setStoryStatus('done');
                setStoryResult(data.number);
                setStoryUrl(data.url || '');
                fetch(`/api/tokens/ledger?story=${encodeURIComponent(data.number)}`)
                    .then(r => r.json())
                    .then(d => { if (d.totals) setCreationTokens(d.totals); })
                    .catch(() => {});
                fetch('/api/tokens/ledger').then(r => r.json()).then(d => setTokenLedger(d ?? {})).catch(() => {});
            } else {
                setStoryStatus('error');
                setStoryResult(data.error || 'Unknown error');
            }
        } catch (e: any) {
            setStoryStatus('error');
            setStoryResult(e.message);
        }
    }, [storyForm]);
    const allStatuses = Object.values(agentStatuses).filter(Boolean) as AgentStatus[];

    const totalCloudTokens = allStatuses.reduce((sum, s) => sum + (s.tokens?.cloud?.input ?? 0) + (s.tokens?.cloud?.output ?? 0), 0);
    const totalMeshllmTokens = allStatuses.reduce((sum, s) => sum + (s.tokens?.meshllm?.input ?? 0) + (s.tokens?.meshllm?.output ?? 0), 0);
    const totalOllamaTokens = allStatuses.reduce((sum, s) => sum + (s.tokens?.ollama?.input ?? 0) + (s.tokens?.ollama?.output ?? 0), 0);
    const ledgerEntries = Object.entries(tokenLedger);
    const ledgerTotalTokens = ledgerEntries.reduce((sum, [, v]) => sum + (v.totals?.input ?? 0) + (v.totals?.output ?? 0), 0);
    const activeWorkItemCount = allStatuses.reduce((sum, s) => {
        const inProg = s.tasks.filter((t) => t.status === 'in_progress').length;
        const openReqs = (s.requests ?? []).filter((r) => r.status === 'open').length;
        return sum + inProg + openReqs;
    }, 0);
    const pausedAgentCount = globalStepMode ? allStatuses.filter(s => {
        const p = s.currentPhase ?? 'idle';
        return STEP_MODE_CHECKPOINT_PHASES.has(p) && p !== 'idle';
    }).length : 0;
    const headerOpenPullRequests = collectHeaderOpenPullRequests(agentStatuses, parentDisplayNames);

    return (
        <div className="simple-floor" style={styles.container}>
            <div
                aria-hidden
                style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    zIndex: 10001,
                    pointerEvents: 'none',
                    background: integrationMock ? '#f59e0b' : '#22c55e',
                    transition: 'background-color 0.35s ease',
                }}
            />
            <style>{`
                .simple-floor [role="article"]:focus-visible {
                    outline: 2px solid var(--accent);
                    outline-offset: 2px;
                }
                .simple-floor [role="article"]:hover {
                    background: var(--bg-card-hover) !important;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.08);
                }
                @keyframes pausePulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
            `}</style>
            <FloorHeader
                profileName={profileName}
                globalStepMode={globalStepMode}
                toggleGlobalStepMode={toggleGlobalStepMode}
                pausedAgentCount={pausedAgentCount}
                cursorAiEnabled={cursorAiEnabled}
                toggleCursorAi={toggleCursorAi}
                claudeEnabled={claudeEnabled}
                toggleClaudeAi={toggleClaudeAi}
                onOpenCreateStory={() => { setShowCreateStory(true); setStoryStatus('idle'); setStoryResult(''); }}
                onOpenLocalBacklog={onOpenLocalBacklog}
                onRefreshStatus={onRefreshStatus}
                externalMode={externalMode}
                onToggleTestRunner={onToggleTestRunner}
                onResetMockState={externalMode === 'mock' ? async () => {
                    if (!confirm('Reset all mock state? This clears PRs, builds, and notifications.')) return;
                    try {
                        await fetch('/api/mock/reset', { method: 'POST' });
                        onRefreshStatus?.();
                    } catch { /* silent */ }
                } : undefined}
                notificationCount={notificationCount}
                onToggleNotifications={onToggleNotifications}
                colorScheme={colorScheme}
                setColorScheme={setColorScheme}
                worktreeBranch={worktreeBranch}
                isWorktree={isWorktree}
                worktreeHue={worktreeHue}
            />

            <FloorStatsBar
                integrationMock={integrationMock}
                activeAgents={activeAgents}
                totalCloudTokens={totalCloudTokens}
                totalMeshllmTokens={totalMeshllmTokens}
                totalOllamaTokens={totalOllamaTokens}
                agentStatuses={agentStatuses}
                displayNames={parentDisplayNames}
                onSelectAgent={onSelectAgent}
                headerOpenPullRequests={headerOpenPullRequests}
                activeWorkItemCount={activeWorkItemCount}
                formatTokens={formatTokens}
                testSummary={testSummary}
                showTestBreakdown={showTestBreakdown}
                setShowTestBreakdown={setShowTestBreakdown}
                testRuns={testRuns}
                setTestRuns={setTestRuns}
                externalMode={externalMode}
                onSetExternalMode={onSetExternalMode}
                availableProjects={availableProjects}
                activeProject={activeProject}
                setActiveProject={setActiveProject}
                ledgerEntries={ledgerEntries}
                showLedger={showLedger}
                setShowLedger={setShowLedger}
                ledgerTotalTokens={ledgerTotalTokens}
            />

            <div style={{ ...styles.agentGrid, gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}>
                {AGENT_ROSTER.map((agent) => (
                    <AgentCard
                        key={agent.id}
                        agent={agent}
                        displayName={parentDisplayNames[agent.id]}
                        globalStepMode={globalStepMode}
                        onRename={async (newName: string) => {
                            try {
                                await fetch('/api/agent/display-names', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ agentId: agent.id, displayName: newName }),
                                });
                                const next = { ...parentDisplayNames };
                                if (newName.trim()) next[agent.id] = newName.trim();
                                else delete next[agent.id];
                                onDisplayNamesChange?.(next);
                            } catch { /* silent */ }
                        }}
                        status={agentStatuses[agent.id] ?? null}
                        availableModels={availableModels}
                        onSelect={() => onSelectAgent(agent)}
                        onChat={() => onChatWith(agent)}
                        onPickUpStory={onPickUpStory ? () => onPickUpStory(agent) : undefined}
                        onApprove={async () => {
                            try {
                                const res = await fetch(`${window.location.origin}/api/scheduler/approve`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ agentId: agent.id }),
                                });
                                if (!res.ok) {
                                    const err = await res.json().catch(() => ({}));
                                    alert(`Approve failed: ${err.error || res.statusText}`);
                                }
                                onRefreshStatus?.();
                            } catch (e: any) {
                                alert(`Approve failed: ${e.message}`);
                            }
                        }}
                    />
                ))}
            </div>

            <AgentTerminalSection agentRoster={AGENT_ROSTER} agentStatuses={agentStatuses} />

            <CreateStoryModal
                open={showCreateStory}
                onClose={() => setShowCreateStory(false)}
                containerRef={createStoryRef}
                storyForm={storyForm}
                setStoryForm={setStoryForm}
                storyStatus={storyStatus}
                storyResult={storyResult}
                storyUrl={storyUrl}
                creationTokens={creationTokens}
                setStoryStatus={setStoryStatus}
                setStoryResult={setStoryResult}
                setStoryUrl={setStoryUrl}
                setCreationTokens={setCreationTokens}
                storyTeams={storyTeams}
                storyMembers={storyMembers}
                classOfServiceValues={classOfServiceValues}
                execMode={execMode}
                setExecMode={setExecMode}
                handleCreateStory={handleCreateStory}
            />
        </div>
    );
}

SimpleFloor.displayName = 'SimpleFloor';
