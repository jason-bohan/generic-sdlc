import { useState, useEffect } from 'react';

export interface ModelOption {
    id: string;
    label: string;
    category: 'auto' | 'cloud' | 'local';
}

export function useAgentModels() {
    const [models, setModels] = useState<ModelOption[]>([]);
    useEffect(() => {
        fetch(`${window.location.origin}/api/agent/models`)
            .then(r => r.json())
            .then(d => { if (Array.isArray(d.models)) setModels(d.models); })
            .catch(() => {});
    }, []);
    return models;
}
