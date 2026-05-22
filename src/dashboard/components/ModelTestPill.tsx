import { useState, useEffect, useCallback, type CSSProperties } from 'react';

interface FreeModel {
    id: string;
    name: string;
    description?: string;
    contextLength?: number;
    coding: boolean;
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';
type AssignState = 'idle' | 'saving' | 'saved' | 'fail';

export function ModelTestPill() {
    const [open, setOpen] = useState(false);
    const [modelInput, setModelInput] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [testState, setTestState] = useState<TestState>('idle');
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [testError, setTestError] = useState('');
    const [assignState, setAssignState] = useState<AssignState>('idle');
    const [useError, setUseError] = useState('');
    const [freeModels, setFreeModels] = useState<FreeModel[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [showAll, setShowAll] = useState(false);
    const [catalogSearch, setCatalogSearch] = useState('');

    const loadFreeModels = useCallback(async () => {
        if (freeModels.length > 0) return;
        setLoadingModels(true);
        try {
            const r = await fetch('/api/openrouter/models', { signal: AbortSignal.timeout(15000) });
            if (r.ok) {
                const d = await r.json() as { models: FreeModel[] };
                setFreeModels(d.models ?? []);
            }
        } catch { /* silent */ }
        finally { setLoadingModels(false); }
    }, [freeModels.length]);

    useEffect(() => {
        if (open) loadFreeModels();
    }, [open, loadFreeModels]);

    const runTest = useCallback(async () => {
        if (!modelInput.trim()) return;
        setTestState('testing');
        setAssignState('idle');
        setLatencyMs(null);
        setTestError('');
        setUseError('');
        try {
            const r = await fetch('/api/openrouter/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelInput.trim(), apiKey: apiKey.trim() || undefined }),
                signal: AbortSignal.timeout(25000),
            });
            if (!r.ok && r.status !== 200) {
                const text = await r.text().catch(() => '');
                setTestState('fail');
                setTestError(text.slice(0, 200) || `Server error (HTTP ${r.status}) — try again`);
                return;
            }
            const d = await r.json() as { ok: boolean; latencyMs?: number; error?: string };
            if (d.ok) {
                setTestState('ok');
                setLatencyMs(d.latencyMs ?? null);
            } else {
                setTestState('fail');
                setTestError(d.error ?? 'Unknown error');
            }
        } catch (e: unknown) {
            setTestState('fail');
            setTestError(e instanceof Error ? e.message : String(e));
        }
    }, [modelInput, apiKey]);

    const useTestedModel = useCallback(async () => {
        const model = modelInput.trim();
        if (!model || testState !== 'ok') return;
        setAssignState('saving');
        setUseError('');
        try {
            const r = await fetch('/api/loop-provider', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    baseUrl: 'https://openrouter.ai/api/v1',
                    model,
                    apiKey: apiKey.trim() || undefined,
                    providerEnabled: { openrouter: true },
                }),
                signal: AbortSignal.timeout(15000),
            });
            if (!r.ok) {
                const text = await r.text().catch(() => '');
                throw new Error(text.slice(0, 200) || `Save failed (HTTP ${r.status})`);
            }
            setAssignState('saved');
        } catch (e: unknown) {
            setAssignState('fail');
            setUseError(e instanceof Error ? e.message : String(e));
        }
    }, [apiKey, modelInput, testState]);

    const baseModels = showAll ? freeModels : freeModels.filter(m => m.coding);
    const visibleModels = catalogSearch.trim()
        ? baseModels.filter(m => m.id.toLowerCase().includes(catalogSearch.toLowerCase()) || m.name.toLowerCase().includes(catalogSearch.toLowerCase()))
        : baseModels;

    return (
        <div style={styles.wrapper}>
            <button
                style={styles.pill}
                onClick={() => setOpen(o => !o)}
                title="Test an OpenRouter model or browse free programming models"
            >
                OR models
            </button>

            {open && (
                <div style={styles.popup}>
                    <div style={styles.popupHeader}>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>OpenRouter Model Tester</span>
                        <button style={styles.close} onClick={() => setOpen(false)}>✕</button>
                    </div>

                    <div style={styles.inputRow}>
                        <input
                            style={styles.input}
                            placeholder="model id, e.g. poolside/laguna-xs.2:free"
                            value={modelInput}
                            onChange={e => { setModelInput(e.target.value); setTestState('idle'); setAssignState('idle'); }}
                            onKeyDown={e => { if (e.key === 'Enter') void runTest(); }}
                            spellCheck={false}
                        />
                        <button
                            style={{ ...styles.testBtn, opacity: testState === 'testing' ? 0.6 : 1 }}
                            onClick={() => { void runTest(); }}
                            disabled={testState === 'testing' || !modelInput.trim()}
                        >
                            {testState === 'testing' ? '…' : 'Test'}
                        </button>
                    </div>

                    <input
                        style={{ ...styles.input, fontSize: 10 }}
                        placeholder="API key (optional — uses server env if omitted)"
                        value={apiKey}
                        type="password"
                        onChange={e => setApiKey(e.target.value)}
                    />

                    {testState === 'ok' && (
                        <div style={styles.resultRow}>
                            <span style={{ ...styles.result, color: '#22c55e' }}>
                                {assignState === 'saved' ? 'Selected for agents' : `Available — ${latencyMs}ms`}
                            </span>
                            <button
                                style={{ ...styles.useBtn, opacity: assignState === 'saving' ? 0.6 : 1 }}
                                onClick={() => { void useTestedModel(); }}
                                disabled={assignState === 'saving'}
                            >
                                {assignState === 'saving' ? 'Saving…' : assignState === 'saved' ? 'Using' : 'Use'}
                            </button>
                        </div>
                    )}
                    {assignState === 'fail' && (
                        <div style={{ ...styles.result, color: '#ef4444' }}>
                            {useError.slice(0, 200)}
                        </div>
                    )}
                    {testState === 'fail' && (
                        <div style={{ ...styles.result, color: '#ef4444' }}>
                            {testError.slice(0, 200)}
                        </div>
                    )}

                    <div style={styles.catalogHeader}>
                        <span style={styles.dim}>
                            {loadingModels ? 'Loading free models…'
                                : freeModels.length > 0 ? `${visibleModels.length} / ${freeModels.length} free`
                                : 'Free model catalog'}
                        </span>
                        {freeModels.length > 0 && (
                            <button style={styles.toggleBtn} onClick={() => setShowAll(s => !s)}>
                                {showAll ? 'coding only' : `show all (${freeModels.length})`}
                            </button>
                        )}
                    </div>
                    {freeModels.length > 0 && (
                        <input
                            style={{ ...styles.input, fontSize: 10, marginBottom: -4 }}
                            placeholder="Search models…"
                            value={catalogSearch}
                            onChange={e => setCatalogSearch(e.target.value)}
                            spellCheck={false}
                        />
                    )}

                    <div style={styles.modelList}>
                        {visibleModels.map(m => (
                            <button
                                key={m.id}
                                style={styles.modelRow}
                                onClick={() => { setModelInput(m.id); setTestState('idle'); setAssignState('idle'); }}
                                title={m.description ?? m.name}
                            >
                                <span style={styles.modelId}>{m.id}</span>
                                <span style={styles.modelMeta}>
                                    {m.coding && <span style={styles.codingTag}>code</span>}
                                    {m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : ''}
                                </span>
                            </button>
                        ))}
                        {!loadingModels && visibleModels.length === 0 && freeModels.length > 0 && (
                            <span style={styles.dim}>No coding-tagged free models — <button style={styles.toggleBtn} onClick={() => setShowAll(true)}>show all</button></span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

ModelTestPill.displayName = 'ModelTestPill';

const styles: Record<string, CSSProperties> = {
    wrapper: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
    },
    pill: {
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.05em',
        padding: '2px 8px',
        borderRadius: 20,
        border: '1px solid var(--border)',
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-secondary)',
    },
    popup: {
        position: 'absolute' as const,
        top: '100%',
        right: 0,
        marginTop: 6,
        width: 420,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        zIndex: 300,
        display: 'flex',
        flexDirection: 'column' as const,
        gap: 8,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-primary)',
    },
    popupHeader: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 2,
    },
    close: {
        background: 'none',
        border: 'none',
        color: 'var(--text-tertiary)',
        cursor: 'pointer',
        fontSize: 11,
        padding: '0 4px',
    },
    inputRow: {
        display: 'flex',
        gap: 6,
    },
    input: {
        flex: 1,
        background: '#0d1117',
        border: '1px solid var(--border)',
        borderRadius: 4,
        color: '#c9d1d9',
        padding: '4px 8px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        outline: 'none',
    },
    testBtn: {
        background: 'var(--accent)',
        color: '#fff',
        border: 'none',
        borderRadius: 4,
        padding: '4px 12px',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        flexShrink: 0,
    },
    result: {
        fontSize: 11,
        padding: '4px 0',
        wordBreak: 'break-word' as const,
    },
    resultRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    useBtn: {
        background: 'rgba(34,197,94,0.18)',
        color: '#22c55e',
        border: '1px solid rgba(34,197,94,0.35)',
        borderRadius: 4,
        padding: '4px 10px',
        fontSize: 10,
        fontWeight: 700,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        flexShrink: 0,
    },
    catalogHeader: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 4,
        borderTop: '1px solid var(--border)',
        paddingTop: 8,
    },
    dim: {
        color: 'var(--text-tertiary)',
        fontSize: 10,
    },
    toggleBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--accent)',
        cursor: 'pointer',
        fontSize: 10,
        padding: 0,
        fontFamily: 'var(--font-mono)',
    },
    modelList: {
        display: 'flex',
        flexDirection: 'column' as const,
        gap: 2,
        maxHeight: 220,
        overflowY: 'auto' as const,
    },
    modelRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 6px',
        borderRadius: 4,
        background: 'none',
        border: '1px solid transparent',
        cursor: 'pointer',
        textAlign: 'left' as const,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        width: '100%',
    },
    modelId: {
        color: '#c9d1d9',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' as const,
        flex: 1,
    },
    modelMeta: {
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        color: 'var(--text-tertiary)',
        flexShrink: 0,
        marginLeft: 8,
    },
    codingTag: {
        fontSize: 9,
        fontWeight: 700,
        padding: '1px 4px',
        borderRadius: 3,
        background: 'rgba(34,197,94,0.15)',
        color: '#22c55e',
        letterSpacing: '0.04em',
    },
};
