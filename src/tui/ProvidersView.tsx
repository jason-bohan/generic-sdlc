import React, { useEffect, useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';

interface Provider {
    id: string;
    name: string;
    enabled: boolean;
    healthy: boolean;
    error: string | null;
    modelCount: number;
    models: Array<{ id: string; label: string }>;
    baseUrl: string;
    selectedModel: string | null;
    isActive: boolean;
    envHost: string | null;
    defaultPort: string | null;
    isCustom: boolean;
}

interface ProvidersData {
    providers: Provider[];
    activeProvider: string;
    activeModel: string | null;
    brainModel: { source: string; model: string | null; baseUrl: string | null } | null;
}

interface Props {
    onBack: () => void;
}

const API = 'http://localhost:3847';
type Step = 'list' | 'set-key' | 'select-model' | 'saving'
    | 'add-name' | 'add-url' | 'add-key' | 'add-model';

export function ProvidersView({ onBack }: Props) {
    const [data, setData] = useState<ProvidersData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [step, setStep] = useState<Step>('list');
    const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [saveMsg, setSaveMsg] = useState<string | null>(null);
    // add-provider fields
    const [addName, setAddName] = useState('');
    const [addUrl, setAddUrl] = useState('');
    const [addKey, setAddKey] = useState('');
    const [addModel, setAddModel] = useState('');

    const load = useCallback(async () => {
        try {
            const res = await fetch(`${API}/api/providers`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json() as ProvidersData;
            setData(json);
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => {
        load();
        const interval = setInterval(load, 10_000);
        return () => clearInterval(interval);
    }, [load]);

    const doSwitch = useCallback(async (id: string, name: string, apiKey?: string, model?: string) => {
        setStep('saving');
        setSaveMsg(null);
        try {
            const body: Record<string, unknown> = { provider: id };
            if (apiKey !== undefined) body.apiKey = apiKey || null;
            if (model !== undefined) body.model = model || null;
            const res = await fetch(`${API}/api/providers`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (!res.ok) {
                const errBody = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(errBody.error ?? `HTTP ${res.status}`);
            }
            setSaveMsg(`Switched to ${name}`);
            await load();
            setTimeout(() => { setStep('list'); setSaveMsg(null); }, 1500);
        } catch (e: unknown) {
            setSaveMsg(e instanceof Error ? e.message : String(e));
            setTimeout(() => { setStep('list'); setSaveMsg(null); }, 3000);
        }
    }, [load]);

    const doAddProvider = useCallback(async () => {
        setStep('saving');
        setSaveMsg(null);
        try {
            const body: Record<string, unknown> = { addProvider: { name: addName, baseUrl: addUrl } };
            if (addKey) body.addProvider = { ...body.addProvider as Record<string, unknown>, apiKey: addKey };
            if (addModel) body.addProvider = { ...body.addProvider as Record<string, unknown>, model: addModel };
            const res = await fetch(`${API}/api/providers`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (!res.ok) {
                const errBody = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(errBody.error ?? `HTTP ${res.status}`);
            }
            setSaveMsg(`Added ${addName}`);
            setAddName(''); setAddUrl(''); setAddKey(''); setAddModel('');
            await load();
            // auto-switch to the new provider
            setTimeout(() => {
                const p = data?.providers.find(x => x.name === addName);
                if (p) void doSwitch(p.id, p.name, addKey || undefined, addModel || undefined);
                else { setStep('list'); setSaveMsg(null); }
            }, 800);
        } catch (e: unknown) {
            setSaveMsg(e instanceof Error ? e.message : String(e));
            setTimeout(() => { setStep('list'); setSaveMsg(null); }, 3000);
        }
    }, [addName, addUrl, addKey, addModel, data, doSwitch, load]);

    const needsKey = (p: Provider) =>
        (p.id === 'openrouter' && !process.env.OPENROUTER_API_KEY) || p.isCustom;

    if (error && !data) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Providers</Text>
                <Text color="red">Failed to load: {error}</Text>
                <Text dimColor>Press Escape to go back.</Text>
            </Box>
        );
    }

    if (!data) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Providers</Text>
                <Text><Spinner type="dots" /> Loading providers...</Text>
            </Box>
        );
    }

    // ── Add provider: name ──────────────────────────────────
    if (step === 'add-name') {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Add provider — name</Text>
                <Text dimColor>e.g. Mistral, Groq, Together AI:</Text>
                <TextInput value={addName} onChange={setAddName} onSubmit={() => setStep('add-url')} />
                <Text dimColor>[Enter] next  [Esc] back</Text>
            </Box>
        );
    }

    // ── Add provider: base URL ──────────────────────────────
    if (step === 'add-url') {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Add provider — base URL</Text>
                <Text dimColor>e.g. https://api.mistral.ai/v1</Text>
                <TextInput value={addUrl} onChange={setAddUrl} onSubmit={() => setStep('add-key')} />
                <Text dimColor>[Enter] next  [Esc] back</Text>
            </Box>
        );
    }

    // ── Add provider: API key ───────────────────────────────
    if (step === 'add-key') {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Add provider — API key</Text>
                <Text dimColor>Enter key or leave blank (Enter to skip):</Text>
                <TextInput value={addKey} onChange={setAddKey} onSubmit={() => setStep('add-model')} mask={addKey.length > 6 ? '*' : undefined} />
                <Text dimColor>[Enter] next  [Esc] back</Text>
            </Box>
        );
    }

    // ── Add provider: model ─────────────────────────────────
    if (step === 'add-model') {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Add provider — model</Text>
                <Text dimColor>e.g. mistral-large-latest (blank = auto):</Text>
                <TextInput value={addModel} onChange={setAddModel} onSubmit={() => void doAddProvider()} />
                <Text dimColor>[Enter] save  [Esc] back</Text>
            </Box>
        );
    }

    // ── Model selection step ─────────────────────────────────
    if (step === 'select-model' && selectedProvider) {
        const modelItems = selectedProvider.models.map(m => ({ label: m.label, value: m.id }));
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Select model — {selectedProvider.name}</Text>
                <SelectInput
                    items={modelItems}
                    onSelect={item => { void doSwitch(selectedProvider.id, selectedProvider.name, undefined, item.value); }}
                />
                <Text dimColor>Press Escape to go back.</Text>
            </Box>
        );
    }

    // ── API key input step ──────────────────────────────────
    if (step === 'set-key' && selectedProvider) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">API key — {selectedProvider.name}</Text>
                <Text dimColor>Enter your API key (blank to skip):</Text>
                <TextInput
                    value={apiKeyInput}
                    onChange={setApiKeyInput}
                    onSubmit={key => {
                        if (selectedProvider.models.length > 0) {
                            void doSwitch(selectedProvider.id, selectedProvider.name, key);
                        } else {
                            setStep('select-model');
                        }
                    }}
                    mask={apiKeyInput.length > 6 ? '*' : undefined}
                />
                <Text dimColor>[Enter] next  [Esc] back</Text>
            </Box>
        );
    }

    // ── Saving step ─────────────────────────────────────────
    if (step === 'saving') {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Providers</Text>
                <Text color="green">{saveMsg ?? 'Saving...'}</Text>
            </Box>
        );
    }

    // ── Provider list step (default) ────────────────────────
    const providerItems = [
        ...data.providers.map(p => {
            const status = !p.enabled ? 'OFF' : (p.healthy ? 'OK' : 'DOWN');
            const active = p.isActive ? ' (active)' : '';
            const tag = p.isCustom ? ' [CUSTOM]' : '';
            return { label: `${p.name}${tag} [${status}]${active} — ${p.modelCount} models`, value: p.id };
        }),
        { label: '── Add provider ──', value: '__add__' },
    ];

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="yellow">Providers</Text>
            <Text dimColor>Select a provider to switch to it, or choose "Add provider":</Text>
            <SelectInput
                items={providerItems}
                onSelect={item => {
                    if (item.value === '__add__') {
                        setAddName(''); setAddUrl(''); setAddKey(''); setAddModel('');
                        setStep('add-name');
                        return;
                    }
                    const p = data.providers.find(x => x.id === item.value);
                    if (!p) return;
                    setSelectedProvider(p);
                    setApiKeyInput('');
                    if (needsKey(p)) {
                        setStep('set-key');
                    } else if (p.healthy && p.models.length > 0) {
                        setStep('select-model');
                    } else {
                        void doSwitch(p.id, p.name);
                    }
                }}
            />
            {data.brainModel && (
                <Box marginTop={1}>
                    <Text dimColor>Brain: <Text color="magenta">{data.brainModel.source}</Text> → <Text color="cyan">{data.brainModel.model ?? '?'}</Text></Text>
                </Box>
            )}
            {saveMsg && <Text color="green">{saveMsg}</Text>}
            <Text dimColor>Press Escape to go back.</Text>
        </Box>
    );
}
