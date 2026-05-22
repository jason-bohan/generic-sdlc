import { useMeshLLMHealth, useOllamaHealth } from './hooks/useAIHealth';

export function AIHealth() {
    const mesh = useMeshLLMHealth();
    const ollama = useOllamaHealth();

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
                <span>Ollama</span>
                {ollama.isLoading
                    ? <span>Checking...</span>
                    : ollama.isHealthy
                        ? <><span>Running locally</span><span>{ollama.activeModel ?? 'ready'}</span></>
                        : <span>Not available</span>}
            </div>
        </div>
    );
}
