import { useState, useEffect, useRef, type CSSProperties } from 'react';
import { useMeshLLMHealth, useMeshLLMModels, useOllamaHealth, selectMeshLLMNode } from '../hooks/useAIHealth';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface AICommandRoomProps {
    open: boolean;
    onClose: () => void;
    cursorAiEnabled: boolean;
    toggleCursorAi: () => void | Promise<void>;
    claudeEnabled: boolean;
    toggleClaudeAi: () => void | Promise<void>;
}

type ProviderKey = 'meshllm' | 'ollama' | 'openrouter';
type ProviderEnabled = Record<ProviderKey, boolean>;
const DEFAULT_PROVIDER_ENABLED: ProviderEnabled = { meshllm: true, ollama: true, openrouter: true };
const TOGGLE_ON_COLOR = 'var(--accent)';
const TOGGLE_OFF_COLOR = 'rgba(248, 113, 113, 0.34)';

export function AICommandRoom({
    open,
    onClose,
    cursorAiEnabled,
    toggleCursorAi,
    claudeEnabled,
    toggleClaudeAi,
}: AICommandRoomProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const meshLLMHealth = useMeshLLMHealth();
    const meshLLMModels = useMeshLLMModels(open);
    const ollamaHealth = useOllamaHealth();

    const [lpApiKey, setLpApiKey] = useState('');
    const [lpModel, setLpModel] = useState('');
    const [lpCurrentKey, setLpCurrentKey] = useState<string | null>(null);
    const [lpConfigured, setLpConfigured] = useState(false);
    const [lpProvider, setLpProvider] = useState<string | null>(null);
    const [providerEnabled, setProviderEnabled] = useState<ProviderEnabled>(DEFAULT_PROVIDER_ENABLED);
    const [lpSource, setLpSource] = useState<string | null>(null);
    const [lpBaseUrl, setLpBaseUrl] = useState<string | null>(null);
    const [lpModels, setLpModels] = useState<Array<{ id: string; label: string }>>([]);
    const [lpSaving, setLpSaving] = useState(false);
    const [lpSaved, setLpSaved] = useState(false);
    const [lpSaveError, setLpSaveError] = useState<string | null>(null);
    const [meshNodeSelecting, setMeshNodeSelecting] = useState(false);
    const [meshModelSaving, setMeshModelSaving] = useState(false);
    const [meshModelMessage, setMeshModelMessage] = useState<string | null>(null);
    const [meshRoutingSaving, setMeshRoutingSaving] = useState(false);
    const [meshLaunchMessage, setMeshLaunchMessage] = useState<string | null>(null);
    const [meshLaunching, setMeshLaunching] = useState(false);
    const [ollamaLaunchMessage, setOllamaLaunchMessage] = useState<string | null>(null);
    const [ollamaLaunching, setOllamaLaunching] = useState(false);

    useFocusTrap(panelRef, open);

    useEffect(() => {
        if (!open) return;

        // Load current loop provider config
        fetch('/api/loop-provider').then(r => r.json()).then((d: { apiKey: string | null; model: string | null; configured: boolean; provider?: string | null; source?: string | null; baseUrl?: string | null; providerEnabled?: Partial<ProviderEnabled> }) => {
            setLpCurrentKey(d.apiKey);
            setLpConfigured(d.configured);
            setLpProvider(d.provider ?? null);
            setLpSource(d.source ?? null);
            setLpBaseUrl(d.baseUrl ?? null);
            setProviderEnabled({ ...DEFAULT_PROVIDER_ENABLED, ...(d.providerEnabled ?? {}) });
            if (d.model) setLpModel(d.model);
        }).catch(() => {});
    }, [open]);

    useEffect(() => {
        if (!open) return;

        function handleKey(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose();
        }
        function handleClick(e: MouseEvent) {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                onClose();
            }
        }

        document.addEventListener('keydown', handleKey);
        setTimeout(() => document.addEventListener('click', handleClick), 0);
        return () => {
            document.removeEventListener('keydown', handleKey);
            document.removeEventListener('click', handleClick);
        };
    }, [open, onClose]);

    const fetchOrModels = async (key: string) => {
        if (!key.startsWith('sk-or-')) {
            setLpModels([]);
            return;
        }
        try {
            const response = await fetch('/api/loop-provider/models');
            const data = await response.json() as { models: Array<{ id: string; label: string }> };
            if (data.models?.length) setLpModels(data.models);
        } catch {
            // Silent fail
        }
    };

    const saveLpConfig = async () => {
        setLpSaving(true);
        setLpSaved(false);
        setLpSaveError(null);
        try {
            const putRes = await fetch('/api/loop-provider', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiKey: lpApiKey || undefined,
                    model: lpModel || undefined,
                    providerEnabled: { ...providerEnabled, openrouter: true },
                }),
            });
            if (!putRes.ok) {
                const text = await putRes.text().catch(() => '');
                setLpSaveError(text.slice(0, 200) || `Save failed (HTTP ${putRes.status})`);
                return;
            }
            setLpSaved(true);
            setLpApiKey('');
            setTimeout(() => setLpSaved(false), 2500);
            // Best-effort refresh of displayed key — don't block save success on this
            fetch('/api/loop-provider').then(r => r.json()).then((d: { apiKey: string | null; configured: boolean }) => {
                setLpCurrentKey(d.apiKey);
                setLpConfigured(d.configured);
            }).catch(() => {});
        } catch (e: unknown) {
            setLpSaveError(e instanceof Error ? e.message : String(e));
        } finally {
            setLpSaving(false);
        }
    };

    const handleSelectMeshNode = async (nodeId: string) => {
        setMeshNodeSelecting(true);
        try {
            await selectMeshLLMNode(nodeId);
            // Refresh health to get updated selection
            setTimeout(() => {
                // The health hook will automatically refresh
            }, 1000);
        } catch {
            // Silent fail
        } finally {
            setMeshNodeSelecting(false);
        }
    };

    const meshModelOptions = meshLLMModels.models.length > 0
        ? meshLLMModels.models
        : meshLLMHealth.models.map((id) => ({ id, label: id }));

    const meshRoutingEnabled = providerEnabled.meshllm;
    const ollamaRoutingEnabled = providerEnabled.ollama;
    const openRouterRoutingEnabled = providerEnabled.openrouter;
    const selectedMeshModel = meshModelOptions.some((model) => model.id === lpModel) ? lpModel : '';

    const refreshLoopProvider = async (fallback?: Partial<{
        baseUrl: string;
        model: string;
        provider: string;
        source: string;
        configured: boolean;
        providerEnabled: Partial<ProviderEnabled>;
    }>) => {
        const d = await fetch('/api/loop-provider').then(r => r.json()) as {
            apiKey?: string | null;
            baseUrl?: string | null;
            model?: string | null;
            provider?: string | null;
            source?: string | null;
            configured?: boolean;
            providerEnabled?: Partial<ProviderEnabled>;
        };
        setLpCurrentKey(d.apiKey ?? null);
        setLpBaseUrl(d.baseUrl ?? fallback?.baseUrl ?? null);
        setLpProvider(d.provider ?? fallback?.provider ?? null);
        setLpSource(d.source ?? fallback?.source ?? null);
        setLpConfigured(d.configured ?? fallback?.configured ?? false);
        setProviderEnabled({ ...DEFAULT_PROVIDER_ENABLED, ...(fallback?.providerEnabled ?? {}), ...(d.providerEnabled ?? {}) });
        if (d.model || fallback?.model) setLpModel(d.model ?? fallback?.model ?? '');
    };

    const handleToggleProvider = async (provider: ProviderKey) => {
        setMeshRoutingSaving(true);
        setMeshModelMessage(null);
        try {
            const nextProviderEnabled = {
                ...providerEnabled,
                [provider]: !providerEnabled[provider],
            };
            const response = await fetch('/api/loop-provider', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ providerEnabled: nextProviderEnabled }),
            });
            if (!response.ok) throw new Error(`Save failed (${response.status})`);
            await refreshLoopProvider({
                providerEnabled: nextProviderEnabled,
            });
            setMeshModelMessage(`${provider === 'meshllm' ? 'MeshLLM' : provider === 'ollama' ? 'Ollama' : 'OpenRouter'} routing ${nextProviderEnabled[provider] ? 'enabled' : 'off'}`);
            setTimeout(() => setMeshModelMessage(null), 2500);
        } catch (e) {
            setMeshModelMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setMeshRoutingSaving(false);
        }
    };

    const handleSelectMeshModel = async (modelId: string) => {
        setLpModel(modelId);
        if (!modelId) return;
        setMeshModelSaving(true);
        setMeshModelMessage(null);
        try {
            const response = await fetch('/api/loop-provider', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    baseUrl: 'http://localhost:9337/v1',
                    model: modelId,
                    providerEnabled: { ...providerEnabled, meshllm: true },
                }),
            });
            if (!response.ok) throw new Error(`Save failed (${response.status})`);
            await refreshLoopProvider({
                baseUrl: 'http://localhost:9337/v1',
                model: modelId,
                provider: 'meshllm',
                source: 'config',
                configured: true,
                providerEnabled: { ...providerEnabled, meshllm: true },
            });
            setMeshModelMessage('Mesh model selected');
            setTimeout(() => setMeshModelMessage(null), 2500);
        } catch (e) {
            setMeshModelMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setMeshModelSaving(false);
        }
    };

    const handleLaunchOllama = async () => {
        setOllamaLaunching(true);
        setOllamaLaunchMessage(null);
        try {
            const response = await fetch('/api/ollama/launch', { method: 'POST' });
            const data = response.ok ? await response.json() as { ok?: boolean; message?: string; error?: string } : null;
            setOllamaLaunchMessage(data?.message || data?.error || (data?.ok ? 'Launch requested.' : 'Launch failed.'));
        } catch {
            setOllamaLaunchMessage('Server unavailable — try again.');
        } finally {
            setOllamaLaunching(false);
        }
    };

    const handleLaunchMeshLLM = async () => {
        setMeshLaunching(true);
        setMeshLaunchMessage(null);
        try {
            const response = await fetch('/api/meshllm/launch', { method: 'POST' });
            const data = response.ok ? await response.json() as { ok?: boolean; message?: string; reason?: string; error?: string } : null;
            setMeshLaunchMessage(data?.message || data?.reason || data?.error || (data?.ok ? 'Launch requested.' : 'MeshLLM launch unavailable.'));
        } catch {
            setMeshLaunchMessage('Server unavailable — try again.');
        } finally {
            setMeshLaunching(false);
        }
    };

    if (!open) return null;

    return (
        <div style={styles.overlay}>
            <div ref={panelRef} style={styles.panel} role="dialog" aria-modal="true">
                <div style={styles.header}>
                    <div style={styles.headerLeft}>
                        <span style={styles.brainIcon}>🧠</span>
                        <span style={styles.title}>AI Command Room</span>
                    </div>
                    <button style={styles.closeBtn} onClick={onClose} aria-label="Close AI Command Room">&times;</button>
                </div>

                {/* Provider Status Grid */}
                <div style={styles.statusGrid}>
                    <div style={{
                        ...styles.statusCard,
                        borderColor: meshLLMHealth.isHealthy ? 'var(--success)' : 'var(--error)',
                        backgroundColor: meshLLMHealth.isHealthy ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    }}>
                        <div style={styles.statusHeader}>
                            <span style={styles.statusIcon}>🌐</span>
                            <span style={styles.statusTitle}>MeshLLM</span>
                        </div>
                        <p style={styles.statusText}>
                            {meshLLMHealth.isLoading ? 'Checking...' :
                             meshLLMHealth.isHealthy ? 'Connected to mesh' : 'Not available'}
                        </p>
                        {meshLLMHealth.peers > 0 && (
                            <p style={styles.statusDetail}>{meshLLMHealth.peers} peers available</p>
                        )}
                        <div style={styles.inlineSwitchRow}>
                            <span style={styles.inlineSwitchLabel}>Use for agents</span>
                            <button
                                type="button"
                                onClick={() => void handleToggleProvider('meshllm')}
                                style={{
                                    ...styles.miniToggle,
                                    backgroundColor: meshRoutingEnabled ? TOGGLE_ON_COLOR : TOGGLE_OFF_COLOR,
                                    opacity: meshRoutingSaving ? 0.6 : 1,
                                }}
                                aria-pressed={meshRoutingEnabled}
                                aria-label="Use MeshLLM for agents"
                                disabled={meshRoutingSaving}
                                data-testid="meshllm-routing-toggle"
                            >
                                <span
                                    style={{
                                        ...styles.miniToggleThumb,
                                        transform: meshRoutingEnabled ? 'translateX(16px)' : 'translateX(2px)',
                                    }}
                                />
                            </button>
                        </div>
                        <div style={styles.meshModelPill}>
                            <div style={styles.meshModelPillTop}>
                                <span style={meshModelDotStyle(meshLLMModels.available || meshLLMHealth.isHealthy)} />
                                <span style={styles.meshModelLabel}>Mesh model</span>
                                <span style={styles.meshModelCount}>
                                    {meshLLMModels.isLoading ? 'polling' : `${meshModelOptions.length} online`}
                                </span>
                            </div>
                            <select
                                value={selectedMeshModel}
                                onChange={(e) => void handleSelectMeshModel(e.target.value)}
                                disabled={meshModelSaving || meshModelOptions.length === 0}
                                style={{
                                    ...styles.meshModelSelect,
                                    opacity: meshRoutingEnabled ? 1 : 0.7,
                                }}
                                aria-label="MeshLLM model"
                                data-testid="meshllm-model-select"
                            >
                                <option value="" style={styles.selectOption}>
                                    {meshModelOptions.length > 0 ? 'Choose model' : 'No mesh models online'}
                                </option>
                                {meshModelOptions.map((model) => (
                                    <option key={model.id} value={model.id} style={styles.selectOption}>{model.label}</option>
                                ))}
                            </select>
                            <p style={styles.statusDetail}>
                                {meshModelMessage
                                    || (meshLLMModels.lastChecked ? `Updated ${meshLLMModels.lastChecked}` : 'Polling every 15s')}
                                {meshLLMModels.error && !meshLLMModels.available ? ` - ${meshLLMModels.error}` : ''}
                            </p>
                        </div>
                        {meshLLMHealth.nodes.length > 0 && (
                            <div style={styles.nodeSelector}>
                                <label style={styles.nodeSelectorLabel} htmlFor="meshllm-node-select">Select Node:</label>
                                <select
                                    id="meshllm-node-select"
                                    value={meshLLMHealth.selectedNode || ''}
                                    onChange={(e) => void handleSelectMeshNode(e.target.value)}
                                    disabled={meshNodeSelecting}
                                    style={{
                                        ...styles.nodeSelect,
                                        opacity: meshNodeSelecting ? 0.6 : 1,
                                    }}
                                >
                                    <option value="">Auto-select</option>
                                    {meshLLMHealth.nodes.map(node => (
                                        <option key={node.id} value={node.id}>
                                            {node.name} ({node.models.length} models)
                                            {node.latency ? ` - ${node.latency}ms` : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {!meshLLMHealth.isHealthy && !meshLLMHealth.isLoading && (
                            <div style={styles.nodeSelector}>
                                <button
                                    type="button"
                                    style={{
                                        ...styles.saveBtn,
                                        alignSelf: 'flex-start',
                                        opacity: meshLaunching ? 0.6 : 1,
                                    }}
                                    onClick={() => void handleLaunchMeshLLM()}
                                    disabled={meshLaunching}
                                    data-testid="meshllm-launch-btn"
                                >
                                    {meshLaunching ? 'Starting...' : meshLLMHealth.launch?.canLaunch ? 'Start MeshLLM' : 'Configure Launch'}
                                </button>
                                <p style={styles.statusDetail}>
                                    {meshLaunchMessage || meshLLMHealth.launch?.reason || 'Set MESHLLM_START_COMMAND to enable local launch.'}
                                </p>
                            </div>
                        )}
                    </div>

                    <div style={{
                        ...styles.statusCard,
                        borderColor: ollamaHealth.isHealthy ? 'var(--success)' : 'var(--error)',
                        backgroundColor: ollamaHealth.isHealthy ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    }}>
                        <div style={styles.statusHeader}>
                            <span style={styles.statusIcon}>💻</span>
                            <span style={styles.statusTitle}>Ollama</span>
                        </div>
                        <p style={styles.statusText}>
                            {ollamaHealth.isLoading ? 'Checking...' :
                             ollamaHealth.isHealthy ? 'Running' : 'Not running'}
                        </p>
                        {ollamaHealth.activeModel && (
                            <p style={styles.statusDetail}>
                                {ollamaHealth.tunedModelReady ? '★ ' : ''}{ollamaHealth.activeModel}
                            </p>
                        )}
                        <div style={styles.inlineSwitchRow}>
                            <span style={styles.inlineSwitchLabel}>Use for agents</span>
                            <button
                                type="button"
                                onClick={() => void handleToggleProvider('ollama')}
                                style={{
                                    ...styles.miniToggle,
                                    backgroundColor: ollamaRoutingEnabled ? TOGGLE_ON_COLOR : TOGGLE_OFF_COLOR,
                                    opacity: meshRoutingSaving ? 0.6 : 1,
                                }}
                                aria-pressed={ollamaRoutingEnabled}
                                aria-label="Use Ollama for agents"
                                disabled={meshRoutingSaving}
                                data-testid="ollama-routing-toggle"
                            >
                                <span
                                    style={{
                                        ...styles.miniToggleThumb,
                                        transform: ollamaRoutingEnabled ? 'translateX(16px)' : 'translateX(2px)',
                                    }}
                                />
                            </button>
                        </div>
                        {!ollamaHealth.isHealthy && !ollamaHealth.isLoading && (
                            <div style={styles.nodeSelector}>
                                <button
                                    type="button"
                                    style={{
                                        ...styles.saveBtn,
                                        alignSelf: 'flex-start',
                                        opacity: ollamaLaunching ? 0.6 : 1,
                                    }}
                                    onClick={() => void handleLaunchOllama()}
                                    disabled={ollamaLaunching}
                                    data-testid="ollama-launch-btn"
                                >
                                    {ollamaLaunching ? 'Starting...' : 'Start Ollama'}
                                </button>
                                {ollamaLaunchMessage && (
                                    <p style={styles.statusDetail}>{ollamaLaunchMessage}</p>
                                )}
                            </div>
                        )}
                    </div>

                    <div style={{
                        ...styles.statusCard,
                        borderColor: lpConfigured ? 'var(--success)' : 'var(--accent)',
                        backgroundColor: lpConfigured ? 'rgba(34, 197, 94, 0.1)' : 'rgba(99, 102, 241, 0.1)',
                    }}>
                        <div style={styles.statusHeader}>
                            <span style={styles.statusIcon}>☁️</span>
                            <span style={styles.statusTitle}>Cloud Providers</span>
                        </div>
                        <p style={styles.statusText}>
                            {lpProvider === 'meshllm'
                                ? 'MeshLLM selected'
                                : lpProvider === 'ollama'
                                    ? 'Ollama selected'
                                    : lpConfigured ? 'OpenRouter configured' : 'Available via API keys'}
                        </p>
                        <p style={styles.statusDetail}>
                            {lpConfigured
                                ? `${lpModel || 'default model'} via ${lpSource || 'provider'}`
                                : 'Cursor, Claude, OpenRouter'}
                        </p>
                        <div style={styles.inlineSwitchRow}>
                            <span style={styles.inlineSwitchLabel}>Use OpenRouter</span>
                            <button
                                type="button"
                                onClick={() => void handleToggleProvider('openrouter')}
                                style={{
                                    ...styles.miniToggle,
                                    backgroundColor: openRouterRoutingEnabled ? TOGGLE_ON_COLOR : TOGGLE_OFF_COLOR,
                                    opacity: meshRoutingSaving ? 0.6 : 1,
                                }}
                                aria-pressed={openRouterRoutingEnabled}
                                aria-label="Use OpenRouter for agents"
                                disabled={meshRoutingSaving}
                                data-testid="openrouter-routing-toggle"
                            >
                                <span
                                    style={{
                                        ...styles.miniToggleThumb,
                                        transform: openRouterRoutingEnabled ? 'translateX(16px)' : 'translateX(2px)',
                                    }}
                                />
                            </button>
                        </div>
                    </div>
                </div>

                {/* AI Provider Toggles */}
                <div style={styles.section}>
                    <span style={styles.sectionLabel}>AI Provider Controls</span>

                    <div style={styles.toggleRow}>
                        <div style={styles.toggleInfo}>
                            <span style={styles.toggleIcon}>🎯</span>
                            <div>
                                <span style={styles.toggleTitle}>Cursor AI</span>
                                <p style={styles.toggleDesc}>Use Cursor for agent code generation</p>
                            </div>
                        </div>
                        <button
                            onClick={() => { void toggleCursorAi(); }}
                            style={{
                                ...styles.toggle,
                                backgroundColor: cursorAiEnabled ? TOGGLE_ON_COLOR : TOGGLE_OFF_COLOR,
                            }}
                            aria-pressed={cursorAiEnabled}
                            aria-label="Use Cursor AI"
                        >
                            <span
                                style={{
                                    ...styles.toggleThumb,
                                    transform: cursorAiEnabled ? 'translateX(20px)' : 'translateX(2px)',
                                }}
                            />
                        </button>
                    </div>

                    <div style={styles.toggleRow}>
                        <div style={styles.toggleInfo}>
                            <span style={styles.toggleIcon}>🤖</span>
                            <div>
                                <span style={styles.toggleTitle}>Claude AI</span>
                                <p style={styles.toggleDesc}>Use Claude for code analysis and generation</p>
                            </div>
                        </div>
                        <button
                            onClick={() => { void toggleClaudeAi(); }}
                            style={{
                                ...styles.toggle,
                                backgroundColor: claudeEnabled ? TOGGLE_ON_COLOR : TOGGLE_OFF_COLOR,
                            }}
                            aria-pressed={claudeEnabled}
                            aria-label="Use Claude AI"
                        >
                            <span
                                style={{
                                    ...styles.toggleThumb,
                                    transform: claudeEnabled ? 'translateX(20px)' : 'translateX(2px)',
                                }}
                            />
                        </button>
                    </div>
                </div>

                {/* Loop Provider Configuration */}
                <div style={styles.section}>
                    <span style={styles.sectionLabel}>Fallback Provider — OpenRouter</span>
                    <p style={styles.sectionHint}>
                        Used when both Cursor AI and Claude AI are disabled. Requires OpenRouter API key.
                    </p>

                    {lpCurrentKey && (
                        <p style={{ ...styles.sectionHint, color: 'var(--accent)' }}>
                            Current key: <code style={styles.codeInline}>{lpCurrentKey}</code>
                        </p>
                    )}
                    <p style={styles.sectionHint}>
                        Status: {lpConfigured ? 'configured' : 'not configured'}
                        {lpProvider ? ` (${lpProvider})` : ''}
                        {lpBaseUrl ? ` - ${lpBaseUrl}` : ''}
                    </p>

                    <input
                        type="password"
                        placeholder="sk-or-v1-... (leave blank to keep current)"
                        value={lpApiKey}
                        onChange={e => {
                            setLpApiKey(e.target.value);
                            void fetchOrModels(e.target.value);
                        }}
                        style={styles.input}
                        autoComplete="off"
                        aria-label="OpenRouter API key"
                    />

                    {lpModels.length > 0 ? (
                        <select
                            value={lpModel}
                            onChange={e => setLpModel(e.target.value)}
                            style={{ ...styles.input, cursor: 'pointer' }}
                            aria-label="OpenRouter model"
                        >
                            <option value="">— pick a model —</option>
                            {lpModels.map(m => (
                                <option key={m.id} value={m.id} style={styles.selectOption}>{m.label}</option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type="text"
                            placeholder="Model (e.g. deepseek/deepseek-v3)"
                            value={lpModel}
                            onChange={e => setLpModel(e.target.value)}
                            style={styles.input}
                            autoComplete="off"
                            aria-label="Loop provider model"
                        />
                    )}

                    <button
                        type="button"
                        style={{
                            ...styles.saveBtn,
                            borderColor: lpSaved ? 'var(--success)' : 'var(--accent)',
                            color: lpSaved ? 'var(--success)' : 'var(--accent)',
                            opacity: lpSaving ? 0.6 : 1,
                        }}
                        onClick={() => void saveLpConfig()}
                        disabled={lpSaving}
                    >
                        {lpSaved ? 'Saved ✓' : lpSaving ? 'Saving…' : 'Save Configuration'}
                    </button>
                    {lpSaveError && (
                        <p style={{ ...styles.sectionHint, color: 'var(--error, #ef4444)', marginTop: -8 }}>
                            {lpSaveError}
                        </p>
                    )}
                </div>

                <div style={styles.footer}>
                    <button style={styles.backBtn} onClick={onClose}>
                        <span style={styles.backArrow}>←</span>
                        Back to Floor
                    </button>
                </div>
            </div>
        </div>
    );
}

AICommandRoom.displayName = 'AICommandRoom';

const meshModelDotStyle = (healthy: boolean): CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: healthy ? 'var(--success)' : 'var(--error)',
    flexShrink: 0,
});

const styles: Record<string, CSSProperties> = {
    overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        padding: 16,
    },
    panel: {
        width: 'min(680px, 100%)',
        maxHeight: '90vh',
        backgroundColor: 'var(--bg-card)',
        borderRadius: 12,
        border: '1px solid var(--border)',
        boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
        display: 'flex',
        flexDirection: 'column',
        padding: 24,
        overflowY: 'auto',
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 24,
    },
    headerLeft: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
    },
    brainIcon: {
        fontSize: 24,
    },
    title: {
        fontSize: 20,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
    },
    closeBtn: {
        background: 'none',
        border: 'none',
        fontSize: 28,
        cursor: 'pointer',
        color: 'var(--text-secondary)',
        lineHeight: 1,
        padding: 4,
    },
    statusGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 16,
        marginBottom: 32,
    },
    statusCard: {
        padding: 16,
        borderRadius: 8,
        border: '2px solid',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
    },
    statusHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
    },
    statusIcon: {
        fontSize: 18,
    },
    statusTitle: {
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
    },
    statusText: {
        margin: 0,
        fontSize: 13,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
    },
    statusDetail: {
        margin: 0,
        fontSize: 11,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
    },
    section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        marginBottom: 32,
    },
    sectionLabel: {
        fontSize: 12,
        textTransform: 'uppercase' as const,
        letterSpacing: 1,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
    },
    sectionHint: {
        margin: 0,
        fontSize: 13,
        lineHeight: 1.5,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
    },
    toggleRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        backgroundColor: 'var(--bg-secondary)',
        borderRadius: 8,
        border: '1px solid var(--border)',
    },
    toggleInfo: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
    },
    toggleIcon: {
        fontSize: 20,
    },
    toggleTitle: {
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
        display: 'block',
    },
    toggleDesc: {
        margin: 0,
        fontSize: 12,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
    },
    toggle: {
        position: 'relative' as const,
        width: 44,
        height: 24,
        borderRadius: 12,
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        transition: 'background-color 0.2s',
        flexShrink: 0,
    },
    toggleThumb: {
        position: 'absolute' as const,
        top: 2,
        left: 2,
        width: 20,
        height: 20,
        borderRadius: '50%',
        backgroundColor: '#fff',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
        transition: 'transform 0.2s',
    },
    input: {
        width: '100%',
        padding: '12px 16px',
        borderRadius: 8,
        border: '1px solid var(--border)',
        backgroundColor: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        boxSizing: 'border-box' as const,
    },
    codeInline: {
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        backgroundColor: 'var(--bg-secondary)',
        padding: '2px 6px',
        borderRadius: 4,
    },
    saveBtn: {
        alignSelf: 'flex-start',
        padding: '10px 16px',
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'var(--font-sans)',
        borderRadius: 8,
        border: '1px solid',
        backgroundColor: 'transparent',
        cursor: 'pointer',
        transition: 'opacity 0.2s',
    },
    footer: {
        marginTop: 'auto',
        paddingTop: 20,
        borderTop: '1px solid var(--border)',
    },
    backBtn: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        padding: '12px 16px',
        backgroundColor: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
        gap: 8,
    },
    backArrow: {
        fontSize: 16,
    },
    nodeSelector: {
        marginTop: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
    },
    nodeSelectorLabel: {
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase' as const,
        letterSpacing: 0.5,
    },
    nodeSelect: {
        padding: '6px 8px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        backgroundColor: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        color: 'var(--text-primary)',
        cursor: 'pointer',
    },
    inlineSwitchRow: {
        marginTop: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    inlineSwitchLabel: {
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
    },
    miniToggle: {
        position: 'relative' as const,
        width: 36,
        height: 20,
        borderRadius: 10,
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        flexShrink: 0,
    },
    miniToggleThumb: {
        position: 'absolute' as const,
        top: 2,
        left: 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        backgroundColor: '#fff',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
        transition: 'transform 0.2s',
    },
    meshModelPill: {
        marginTop: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        borderRadius: 12,
        border: '1px solid var(--border)',
        backgroundColor: 'var(--bg-secondary)',
    },
    meshModelPillTop: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    meshModelLabel: {
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
        whiteSpace: 'nowrap' as const,
    },
    meshModelCount: {
        marginLeft: 'auto',
        fontSize: 10,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
        whiteSpace: 'nowrap' as const,
    },
    meshModelSelect: {
        width: '100%',
        minWidth: 0,
        padding: '6px 8px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        color: 'var(--text-primary)',
        cursor: 'pointer',
        outline: 'none',
    },
    selectOption: {
        backgroundColor: '#111827',
        color: '#f8fafc',
    },
};
