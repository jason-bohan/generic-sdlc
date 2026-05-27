import { useState } from 'react';
import type { ColorScheme } from '../themes';
import { SunIcon, MoonIcon } from './SunMoonIcons';
import { simpleFloorLayoutStyles as styles } from '../SimpleFloor.styles';
import { AICommandRoom } from './AICommandRoom';
import { FinetunePill } from './FinetunePill';
import { ModelTestPill } from './ModelTestPill';

export interface FloorHeaderProps {
    profileName: string;
    globalStepMode: boolean;
    toggleGlobalStepMode: () => void | Promise<void>;
    pausedAgentCount: number;
    cursorAiEnabled: boolean;
    toggleCursorAi: () => void | Promise<void>;
    claudeEnabled: boolean;
    toggleClaudeAi: () => void | Promise<void>;
    opencodeEnabled: boolean;
    toggleOpenCode: () => void | Promise<void>;
    onOpenCreateStory: () => void;
    onOpenLocalBacklog?: () => void;
    onRefreshStatus?: () => void;
    externalMode?: string;
    onToggleTestRunner?: () => void;
    onResetMockState?: () => void;
    notificationCount: number;
    onToggleNotifications?: () => void;
    colorScheme: ColorScheme;
    setColorScheme: (scheme: ColorScheme) => void;
    worktreeBranch?: string | null;
    isWorktree?: boolean;
    worktreeHue?: number;
}

export function FloorHeader({
    profileName,
    globalStepMode,
    toggleGlobalStepMode,
    pausedAgentCount,
    cursorAiEnabled,
    toggleCursorAi,
    claudeEnabled,
    toggleClaudeAi,
    opencodeEnabled,
    toggleOpenCode,
    onOpenCreateStory,
    onOpenLocalBacklog,
    onRefreshStatus,
    externalMode,
    onToggleTestRunner,
    onResetMockState,
    notificationCount,
    onToggleNotifications,
    colorScheme,
    setColorScheme,
    worktreeBranch,
    isWorktree = false,
    worktreeHue,
}: FloorHeaderProps) {
    const [aiCommandRoomOpen, setAiCommandRoomOpen] = useState(false);
    const headerStyle = worktreeBranch
        ? { ...styles.header, borderTop: `3px solid hsl(${worktreeHue ?? 330}, 70%, 45%)` }
        : styles.header;
    const sourceLabel = isWorktree ? 'WORKTREE' : 'MAIN/PROD';

    return (
        <header style={headerStyle}>
            <div>
                <h1 style={styles.headerTitle}>The Floor</h1>
                <p style={styles.headerSubtitle}>Agent Status Dashboard</p>
                {worktreeBranch && (
                    <span style={{
                        display: 'inline-block',
                        marginTop: 4,
                        padding: '2px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        fontFamily: 'var(--font-mono)',
                        letterSpacing: '0.03em',
                        borderRadius: 4,
                        color: `hsl(${worktreeHue ?? 330}, 90%, 98%)`,
                        background: `hsl(${worktreeHue ?? 330}, 70%, 45%)`,
                    }} title={isWorktree ? 'Running from a git worktree' : 'Running from the main production checkout'}>
                        {sourceLabel}: {worktreeBranch}
                    </span>
                )}
            </div>
            <div style={styles.headerActions}>
                <div style={styles.headerOwnerCluster}>
                    <a
                        href="#/profile"
                        style={{
                            ...styles.secondaryLink,
                            alignSelf: 'center',
                        }}
                        data-testid="nav-user-profile-link"
                    >
                        {profileName || 'User Profile'}
                    </a>
                    <button
                        type="button"
                        style={styles.globalStepHeaderBtn}
                        onClick={() => { void toggleGlobalStepMode(); }}
                        title={globalStepMode ? 'Global step mode ON - all agents pause at checkpoints' : 'Global step mode OFF - agents use individual settings'}
                        aria-label={globalStepMode ? 'Turn off global step mode' : 'Turn on global step mode'}
                        aria-pressed={globalStepMode}
                        data-testid="simple-global-step-toggle-btn"
                    >
                        <span style={styles.statLabel}>
                            Global step{pausedAgentCount > 0 ? ` (${pausedAgentCount})` : ''}
                        </span>
                        <span
                            style={{
                                width: 34,
                                height: 18,
                                borderRadius: 9,
                                border: '1px solid var(--border)',
                                background: globalStepMode ? 'var(--accent)' : 'var(--bg-secondary)',
                                position: 'relative' as const,
                                display: 'flex',
                                alignItems: 'center',
                                transition: 'background 0.15s',
                                flexShrink: 0,
                            }}
                        >
                            <span
                                style={{
                                    width: 14,
                                    height: 14,
                                    borderRadius: '50%',
                                    background: '#fff',
                                    transition: 'transform 0.15s',
                                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                                    transform: globalStepMode ? 'translateX(16px)' : 'translateX(1px)',
                                }}
                            />
                        </span>
                    </button>
                    <button
                        type="button"
                        style={{
                            ...styles.globalStepHeaderBtn,
                            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                            color: '#fff',
                            border: '1px solid rgba(102, 126, 234, 0.3)',
                            fontWeight: 600,
                        }}
                        onClick={() => setAiCommandRoomOpen(true)}
                        title="Open AI Command Room - manage all AI providers"
                        aria-label="Open AI Command Room"
                        data-testid="simple-ai-command-room-btn"
                    >
                        <span style={styles.statLabel}>🧠 AI Control</span>
                    </button>
                    <FinetunePill />
                    <ModelTestPill />
                </div>
                <button style={styles.createStoryBtn} onClick={onOpenCreateStory} data-testid="simple-create-story-btn">
                    + Create Story
                </button>
                {onOpenLocalBacklog && (
                    <span
                        role="button"
                        tabIndex={0}
                        onClick={onOpenLocalBacklog}
                        onKeyDown={(e) => e.key === 'Enter' && onOpenLocalBacklog()}
                        data-testid="simple-local-backlog-btn"
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            padding: '4px 10px',
                            borderRadius: 12,
                            border: '1px solid var(--accent)',
                            color: 'var(--accent)',
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: 'pointer',
                            letterSpacing: 0.3,
                            whiteSpace: 'nowrap' as const,
                            userSelect: 'none' as const,
                        }}
                    >
                        Local Backlog
                    </span>
                )}
                <a
                    href="/api/meeting-agent/messages"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="simple-meeting-agent-btn"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '4px 10px',
                        borderRadius: 12,
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                        letterSpacing: 0.3,
                        whiteSpace: 'nowrap' as const,
                        userSelect: 'none' as const,
                        textDecoration: 'none',
                    }}
                >
                    Meeting Agent
                </a>
                {onRefreshStatus && (
                    <button
                        style={styles.iconBtn}
                        onClick={(e) => {
                            const btn = e.currentTarget;
                            btn.style.transition = 'transform 0.6s';
                            btn.style.transform = 'rotate(360deg)';
                            setTimeout(() => { btn.style.transition = ''; btn.style.transform = ''; }, 650);
                            onRefreshStatus();
                        }}
                        title="Re-poll all agent statuses from the server"
                        aria-label="Refresh agent statuses"
                        data-testid="simple-refresh-btn"
                    >
                        &#x21BB;
                    </button>
                )}
                {externalMode === 'mock' && onToggleTestRunner && (
                    <button
                        style={styles.iconBtn}
                        onClick={onToggleTestRunner}
                        title="Open Test Runner (mock mode)"
                        aria-label="Test Runner"
                        data-testid="simple-test-runner-btn"
                    >
                        &#x1F9EA;
                    </button>
                )}
                {externalMode === 'mock' && onResetMockState && (
                    <button
                        style={styles.iconBtn}
                        onClick={onResetMockState}
                        title="Reset mock state (clear stale PRs, builds, notifications)"
                        aria-label="Reset Mock State"
                        data-testid="simple-reset-mock-btn"
                    >
                        &#x1F5D1;
                    </button>
                )}
                {onToggleNotifications && (
                    <button
                        style={styles.iconBtn}
                        onClick={onToggleNotifications}
                        aria-label="Notifications"
                        {...(notificationCount > 0 ? { 'aria-describedby': 'notif-count' } : {})}
                        data-testid="simple-notifications-btn"
                    >
                        &#x1F514;
                        {notificationCount > 0 && (
                            <span id="notif-count" style={styles.badge}>{notificationCount}</span>
                        )}
                    </button>
                )}
                <button
                    type="button"
                    style={styles.themeToggleBtn}
                    onClick={() => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark')}
                    title={colorScheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                    aria-label={colorScheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                    data-testid="simple-theme-toggle-btn"
                >
                    {colorScheme === 'dark' ? <SunIcon /> : <MoonIcon />}
                </button>
            </div>
            
            <AICommandRoom
                open={aiCommandRoomOpen}
                onClose={() => setAiCommandRoomOpen(false)}
                cursorAiEnabled={cursorAiEnabled}
                toggleCursorAi={toggleCursorAi}
                claudeEnabled={claudeEnabled}
                toggleClaudeAi={toggleClaudeAi}
                opencodeEnabled={opencodeEnabled}
                toggleOpenCode={toggleOpenCode}
            />
        </header>
    );
}

FloorHeader.displayName = 'FloorHeader';
