import { useState, useEffect } from 'react';

export interface MeshLLMHealth {
    isHealthy: boolean;
    peers: number;
    models: string[];
    nodes: Array<{ id: string; name: string; models: string[]; latency?: number }>;
    selectedNode?: string;
    launch?: {
        canLaunch: boolean;
        source: 'env' | 'docker' | null;
        command?: string;
        reason?: string;
    };
    isLoading: boolean;
}

export interface MeshLLMModelOption {
    id: string;
    label: string;
}

interface MeshLLMHealthResponse {
    available?: boolean;
    peers?: number;
    models?: string[];
    nodes?: Array<{ id: string; name: string; models: string[]; latency?: number }>;
    selectedNode?: string;
    launch?: MeshLLMHealth['launch'];
}

interface MeshLLMModelsResponse {
    available?: boolean;
    models?: Array<string | { id?: string; label?: string; display_name?: string; name?: string }>;
    error?: string;
}

export interface OllamaHealth {
    isHealthy: boolean;
    activeModel: string | null;
    tunedModelReady: boolean;
    canLaunch: boolean;
    isLoading: boolean;
}

export function useMeshLLMHealth(): MeshLLMHealth {
    const [health, setHealth] = useState<MeshLLMHealth>({
        isHealthy: false,
        peers: 0,
        models: [],
        nodes: [],
        isLoading: true
    });

    useEffect(() => {
        const checkHealth = async () => {
            try {
                const response = await fetch('/api/meshllm/health', { signal: AbortSignal.timeout(5000) });
                if (response.ok) {
                    const data = await response.json() as MeshLLMHealthResponse;
                    setHealth({
                        isHealthy: data.available === true,
                        peers: data.peers ?? 0,
                        models: data.models ?? [],
                        nodes: data.nodes ?? [],
                        selectedNode: data.selectedNode,
                        launch: data.launch,
                        isLoading: false
                    });
                } else {
                    setHealth({ isHealthy: false, peers: 0, models: [], nodes: [], isLoading: false });
                }
            } catch {
                setHealth({ isHealthy: false, peers: 0, models: [], nodes: [], isLoading: false });
            }
        };

        checkHealth();
        const interval = setInterval(checkHealth, 30000);
        return () => clearInterval(interval);
    }, []);

    return health;
}

export function useMeshLLMModels(enabled = true) {
    const [state, setState] = useState<{
        isLoading: boolean;
        available: boolean;
        models: MeshLLMModelOption[];
        error: string | null;
        lastChecked: string | null;
    }>({
        isLoading: true,
        available: false,
        models: [],
        error: null,
        lastChecked: null,
    });

    useEffect(() => {
        if (!enabled) return;

        let cancelled = false;
        const pollModels = async () => {
            try {
                const response = await fetch('/api/meshllm/models', { signal: AbortSignal.timeout(7000) });
                if (!response.ok) {
                    if (!cancelled) setState(cur => ({ ...cur, isLoading: false, available: false, error: null, lastChecked: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
                    return;
                }
                const data = await response.json() as MeshLLMModelsResponse;
                const models = (data.models ?? [])
                    .map((model) => {
                        if (typeof model === 'string') return { id: model, label: model };
                        const id = model.id ?? model.name ?? '';
                        return id ? { id, label: model.label ?? model.display_name ?? model.name ?? id } : null;
                    })
                    .filter((model): model is MeshLLMModelOption => Boolean(model));

                if (!cancelled) {
                    setState({
                        isLoading: false,
                        available: response.ok && data.available === true,
                        models,
                        error: response.ok ? data.error ?? null : data.error ?? `HTTP ${response.status}`,
                        lastChecked: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    });
                }
            } catch {
                if (!cancelled) {
                    setState((current) => ({
                        ...current,
                        isLoading: false,
                        available: false,
                        error: null,
                        lastChecked: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    }));
                }
            }
        };

        void pollModels();
        const interval = setInterval(pollModels, 15000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [enabled]);

    return state;
}

export async function selectMeshLLMNode(nodeId: string): Promise<boolean> {
    try {
        const response = await fetch('/api/meshllm/nodes/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId }),
            signal: AbortSignal.timeout(5000)
        });
        return response.ok;
    } catch {
        return false;
    }
}

export function useOllamaHealth(): OllamaHealth {
    const [health, setHealth] = useState<OllamaHealth>({
        isHealthy: false,
        activeModel: null,
        tunedModelReady: false,
        canLaunch: false,
        isLoading: true
    });

    useEffect(() => {
        const checkHealth = async () => {
            try {
                const response = await fetch('/api/ollama/health', {
                    signal: AbortSignal.timeout(5000)
                });
                if (response.ok) {
                    const data = await response.json() as { online: boolean; model: string; tunedModelReady: boolean };
                    setHealth({
                        isHealthy: data.online === true,
                        activeModel: data.model ?? null,
                        tunedModelReady: data.tunedModelReady ?? false,
                        canLaunch: !data.online,
                        isLoading: false
                    });
                } else {
                    setHealth({ isHealthy: false, activeModel: null, tunedModelReady: false, canLaunch: true, isLoading: false });
                }
            } catch {
                setHealth({ isHealthy: false, activeModel: null, tunedModelReady: false, canLaunch: true, isLoading: false });
            }
        };

        checkHealth();
        const interval = setInterval(checkHealth, 30000);
        return () => clearInterval(interval);
    }, []);

    return health;
}
