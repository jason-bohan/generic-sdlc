import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';

interface Scenario {
    id: string;
    name: string;
    description: string;
}

interface TestRunnerProps {
    onClose: () => void;
}

const API = '';

const HARDCODED_SCENARIOS: Scenario[] = [
    { id: 'pipeline', name: 'Pipeline Smoke Test', description: 'Validates all handoff endpoints and status transitions' },
    { id: 'fullstack', name: 'Full-Stack Story', description: 'Frontend + backend split a story, reviewer + devops pipeline' },
    // { id: 'fullstack-live', name: 'Full-Stack (Live Agents)', description: 'Same but with real agent spawns and Cypress' },
    { id: 'design-first', name: 'Design-First Story', description: 'UX designs, hands off to frontend + backend, parallel review' },
];

type RunState = 'idle' | 'running' | 'passed' | 'failed';

export default function TestRunner({ onClose }: TestRunnerProps) {
    const [scenarios] = useState<Scenario[]>(HARDCODED_SCENARIOS);
    const [activeScenario, setActiveScenario] = useState<string | null>(null);
    const [runState, setRunState] = useState<RunState>('idle');
    const [logContent, setLogContent] = useState('');
    const [elapsedMs, setElapsedMs] = useState(0);
    const logEndRef = useRef<HTMLDivElement>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const logFileRef = useRef<string | null>(null);

    const stopPolling = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    useEffect(() => () => stopPolling(), [stopPolling]);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logContent]);

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [onClose]);

    const pollStatus = useCallback(() => {
        pollRef.current = setInterval(async () => {
            try {
                const statusRes = await fetch(`${API}/api/test-runner/status`);
                const status = await statusRes.json();
                if (status.logFile) logFileRef.current = status.logFile;
                if (status.lastLogFile && !logFileRef.current) logFileRef.current = status.lastLogFile;
                if (status.running) {
                    setElapsedMs(status.elapsedMs || 0);
                    const logUrl = logFileRef.current
                        ? `${API}/api/test-runner/log?file=${encodeURIComponent(logFileRef.current)}`
                        : `${API}/api/test-runner/log`;
                    const logRes = await fetch(logUrl);
                    if (logRes.ok) {
                        const text = await logRes.text();
                        setLogContent(text);
                    }
                } else {
                    stopPolling();
                    const logUrl = logFileRef.current
                        ? `${API}/api/test-runner/log?file=${encodeURIComponent(logFileRef.current)}`
                        : `${API}/api/test-runner/log`;
                    const logRes = await fetch(logUrl);
                    if (logRes.ok) {
                        const text = await logRes.text();
                        setLogContent(text);
                        setRunState(text.includes('ALL TESTS PASSED') ? 'passed' : 'failed');
                    } else {
                        setRunState('failed');
                    }
                }
            } catch {
                stopPolling();
                setRunState('failed');
            }
        }, 2000);
    }, [stopPolling]);

    const runScenario = useCallback(async (scenarioId: string) => {
        setActiveScenario(scenarioId);
        setRunState('running');
        setLogContent('Starting test...\n');
        setElapsedMs(0);
        logFileRef.current = null;
        try {
            const res = await fetch(`${API}/api/test-runner/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scenarioId }),
            });
            const data = await res.json();
            if (!res.ok) {
                setLogContent(`Error: ${data.error}\n`);
                setRunState('failed');
                return;
            }
            if (data.logFile) logFileRef.current = data.logFile;
            pollStatus();
        } catch (e) {
            setLogContent(`Failed to start test: ${e}\n`);
            setRunState('failed');
        }
    }, [pollStatus]);

    const stopTest = useCallback(async () => {
        try {
            await fetch(`${API}/api/test-runner/stop`, { method: 'POST' });
            stopPolling();
            setRunState('failed');
            setLogContent(prev => prev + '\n--- Test stopped by user ---\n');
        } catch { /* ignore */ }
    }, [stopPolling]);

    const formatElapsed = (ms: number) => {
        const secs = Math.floor(ms / 1000);
        const mins = Math.floor(secs / 60);
        const s = secs % 60;
        return mins > 0 ? `${mins}m ${s}s` : `${s}s`;
    };

    const parseResults = (text: string): { passed: number; failed: number } => {
        const passMatch = text.match(/Passed:\s+(\d+)/);
        const failMatch = text.match(/Failed:\s+(\d+)/);
        return {
            passed: passMatch ? parseInt(passMatch[1], 10) : 0,
            failed: failMatch ? parseInt(failMatch[1], 10) : 0,
        };
    };

    const results = runState !== 'idle' ? parseResults(logContent) : null;

    const statusColor = (state: RunState): string => {
        switch (state) {
            case 'running': return '#f59e0b';
            case 'passed': return '#22c55e';
            case 'failed': return '#ef4444';
            default: return '#94a3b8';
        }
    };

    const statusLabel = (state: RunState): string => {
        switch (state) {
            case 'running': return 'RUNNING';
            case 'passed': return 'PASSED';
            case 'failed': return 'FAILED';
            default: return 'IDLE';
        }
    };

    return (
        <div style={overlayStyle}>
            <div style={panelStyle}>
                {/* Header */}
                <div style={headerStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 18 }}>&#x1F9EA;</span>
                        <span style={{ fontWeight: 700, fontSize: 16 }}>Test Runner</span>
                        <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 4 }}>mock mode</span>
                    </div>
                    <button onClick={onClose} style={closeButtonStyle} title="Close (Esc)">&#10005;</button>
                </div>

                <div style={bodyStyle}>
                    {/* Left: Scenario Cards */}
                    <div style={scenarioColumnStyle}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Scenarios</div>
                        {scenarios.map(s => {
                            const isActive = activeScenario === s.id;
                            const isRunning = isActive && runState === 'running';
                            return (
                                <div key={s.id} style={{ ...cardStyle, ...(isActive ? activeCardStyle : {}), opacity: runState === 'running' && !isActive ? 0.5 : 1 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                        <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                                        {isActive && runState !== 'idle' && (
                                            <span style={{ ...badgeStyle, background: statusColor(runState), color: '#fff' }}>
                                                {statusLabel(runState)}
                                            </span>
                                        )}
                                    </div>
                                    <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 8px 0', lineHeight: 1.4 }}>{s.description}</p>
                                    {isRunning ? (
                                        <button onClick={stopTest} style={{ ...runButtonStyle, background: '#ef4444' }}>Stop</button>
                                    ) : (
                                        <button
                                            onClick={() => runScenario(s.id)}
                                            disabled={runState === 'running'}
                                            style={{ ...runButtonStyle, ...(runState === 'running' && !isActive ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
                                        >
                                            {isActive && (runState === 'passed' || runState === 'failed') ? 'Re-run' : 'Run'}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Right: Terminal Output */}
                    <div style={terminalColumnStyle}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Output</div>
                        <div style={terminalStyle}>
                            <pre style={terminalPreStyle}>
                                {logContent || 'Select a scenario and click Run to begin.\n'}
                                <div ref={logEndRef} />
                            </pre>
                        </div>
                    </div>
                </div>

                {/* Bottom status bar */}
                <div style={statusBarStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(runState), display: 'inline-block' }} />
                        <span style={{ fontSize: 12, color: '#e2e8f0' }}>
                            {runState === 'running' ? `Running: ${scenarios.find(s => s.id === activeScenario)?.name}` : statusLabel(runState)}
                        </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: '#94a3b8' }}>
                        {results && results.passed + results.failed > 0 && (
                            <>
                                <span style={{ color: '#22c55e' }}>{results.passed} passed</span>
                                <span style={{ color: results.failed > 0 ? '#ef4444' : '#94a3b8' }}>{results.failed} failed</span>
                            </>
                        )}
                        {runState === 'running' && <span>{formatElapsed(elapsedMs)}</span>}
                        {(runState === 'passed' || runState === 'failed') && elapsedMs > 0 && <span>{formatElapsed(elapsedMs)}</span>}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Styles ──────────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
    position: 'fixed',
    top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
};

const panelStyle: CSSProperties = {
    width: '90vw',
    maxWidth: 1100,
    height: '80vh',
    maxHeight: 700,
    background: '#0f172a',
    borderRadius: 12,
    border: '1px solid #1e293b',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
};

const headerStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid #1e293b',
    color: '#e2e8f0',
};

const closeButtonStyle: CSSProperties = {
    background: 'none',
    border: 'none',
    color: '#94a3b8',
    fontSize: 16,
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: 4,
};

const bodyStyle: CSSProperties = {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
};

const scenarioColumnStyle: CSSProperties = {
    width: 300,
    minWidth: 260,
    padding: 16,
    borderRight: '1px solid #1e293b',
    overflowY: 'auto',
};

const cardStyle: CSSProperties = {
    background: '#1e293b',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    border: '1px solid #334155',
    color: '#e2e8f0',
    transition: 'border-color 0.15s',
};

const activeCardStyle: CSSProperties = {
    borderColor: '#6366f1',
};

const badgeStyle: CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 4,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
};

const runButtonStyle: CSSProperties = {
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
};

const terminalColumnStyle: CSSProperties = {
    flex: 1,
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
};

const terminalStyle: CSSProperties = {
    flex: 1,
    background: '#020617',
    borderRadius: 8,
    border: '1px solid #1e293b',
    overflow: 'auto',
    padding: 12,
};

const terminalPreStyle: CSSProperties = {
    margin: 0,
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
    fontSize: 12,
    lineHeight: 1.5,
    color: '#e2e8f0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
};

const statusBarStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 16px',
    borderTop: '1px solid #1e293b',
    background: '#0f172a',
};
