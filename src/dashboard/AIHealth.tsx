import { useMeshLLMHealth, useOllamaHealth, useMLXHealth } from './hooks/useAIHealth';

export function AIHealth() {
    const mesh = useMeshLLMHealth();
    const ollama = useOllamaHealth();
    const mlx = useMLXHealth();

    const localLoading = ollama.isLoading || mlx.isLoading;
    const localHealthy = ollama.isHealthy || mlx.isHealthy;
    const localLabel = [
        ollama.isHealthy && (ollama.activeModel ?? 'Ollama'),
        mlx.isHealthy && (mlx.models[0] ?? 'MLX'),
    ].filter(Boolean).join(' · ') || 'Not available';

    return (
        <div>
            <div>
                <span>MeshLLM</span>
                {mesh.isLoading
                    ? <span>Checking...</span>
                    : mesh.isHealthy
                        ? <><span>Connected to mesh</span><span>{mesh.peers} peers available</span></>
                        : <span>Not available</span>}
            </div>
            <div>
                <span>Local AI</span>
                {localLoading
                    ? <span>Checking...</span>
                    : localHealthy
                        ? <><span>Running locally</span><span>{localLabel}</span></>
                        : <span>Not available</span>}
            </div>
        </div>
    );
}
