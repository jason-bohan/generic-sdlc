import type { RefObject, Dispatch, SetStateAction } from 'react';
import { createStoryModalStyles as styles } from './CreateStoryModal.styles';

export interface StoryFormState {
    name: string;
    description: string;
    estimate: string;
    team: string;
    owner: string;
    classOfService: string;
}

export interface CreateStoryModalProps {
    open: boolean;
    onClose: () => void;
    containerRef: RefObject<HTMLDivElement | null>;
    storyForm: StoryFormState;
    setStoryForm: Dispatch<SetStateAction<StoryFormState>>;
    storyStatus: 'idle' | 'enriching' | 'creating' | 'done' | 'error';
    storyResult: string;
    storyUrl: string;
    creationTokens: { input: number; output: number } | null;
    setStoryStatus: Dispatch<SetStateAction<'idle' | 'enriching' | 'creating' | 'done' | 'error'>>;
    setStoryResult: Dispatch<SetStateAction<string>>;
    setStoryUrl: Dispatch<SetStateAction<string>>;
    setCreationTokens: Dispatch<SetStateAction<{ input: number; output: number } | null>>;
    storyTeams: { id: string; name: string }[];
    storyMembers: { id: string; name: string }[];
    classOfServiceValues: { id: string; name: string }[];
    execMode: 'local' | 'balanced' | 'speed';
    setExecMode: Dispatch<SetStateAction<'local' | 'balanced' | 'speed'>>;
    handleCreateStory: () => void | Promise<void>;
}

export function CreateStoryModal({
    open,
    onClose,
    containerRef,
    storyForm,
    setStoryForm,
    storyStatus,
    storyResult,
    storyUrl,
    creationTokens,
    setStoryStatus,
    setStoryResult,
    setStoryUrl,
    setCreationTokens,
    execMode,
    setExecMode,
    storyTeams,
    storyMembers,
    classOfServiceValues,
    handleCreateStory,
}: CreateStoryModalProps) {
    if (!open) return null;

    return (
        <div style={styles.modal} onClick={onClose}>
            <div ref={containerRef} style={styles.modalContent} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <strong style={{ fontSize: 16, color: 'var(--text-primary)' }}>Create Work Item</strong>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <select
                            style={{ ...styles.formInput, width: 'auto', fontSize: 11, padding: '3px 6px', margin: 0, color: execMode === 'local' ? 'var(--success)' : execMode === 'speed' ? 'var(--warning)' : 'var(--text-secondary)' }}
                            value={execMode}
                            onChange={(e) => {
                                const m = e.target.value as 'local' | 'balanced' | 'speed';
                                setExecMode(m);
                                fetch('/api/execution-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: m }) }).catch(() => {});
                            }}
                            title="Execution mode"
                        >
                            <option value="local">Efficiency (Goose + Ollama)</option>
                            <option value="balanced">Balanced (Ollama + API)</option>
                            <option value="speed">Speed (Cloud AI — uses more tokens)</option>
                        </select>
                        <button style={styles.modalClose} onClick={onClose} aria-label="Close create story">&times;</button>
                    </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', gap: 12 }}>
                        <div style={{ flex: 1 }}>
                            <label style={styles.formLabel}>Team</label>
                            <select
                                style={styles.formInput}
                                value={storyForm.team}
                                onChange={(e) => setStoryForm(f => ({ ...f, team: e.target.value }))}
                            >
                                <option value="">Select team...</option>
                                {storyTeams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                            </select>
                        </div>
                        <div style={{ flex: 1 }}>
                            <label style={styles.formLabel}>Owner</label>
                            <select
                                style={styles.formInput}
                                value={storyForm.owner}
                                onChange={(e) => setStoryForm(f => ({ ...f, owner: e.target.value }))}
                            >
                                <option value="">Select owner...</option>
                                {storyMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                            </select>
                        </div>
                    </div>
                    <div>
                        <label style={styles.formLabel}>Title *</label>
                        <input
                            style={styles.formInput}
                            value={storyForm.name}
                            onChange={(e) => setStoryForm(f => ({ ...f, name: e.target.value }))}
                            placeholder="Fix / Add / Update..."
                        />
                    </div>
                    <div>
                        <label style={styles.formLabel}>Description</label>
                        <textarea
                            style={{ ...styles.formInput, minHeight: 80, resize: 'vertical' as const }}
                            value={storyForm.description}
                            onChange={(e) => setStoryForm(f => ({ ...f, description: e.target.value }))}
                            placeholder="What needs to change and why? Ollama will expand this."
                        />
                    </div>
                    <div>
                        <label style={styles.formLabel}>Class of Service</label>
                        <select
                            style={styles.formInput}
                            value={storyForm.classOfService}
                            onChange={(e) => setStoryForm(f => ({ ...f, classOfService: e.target.value }))}
                        >
                            <option value="">None</option>
                            {classOfServiceValues.map(c => (
                                <option key={c.id} value={c.name}>{c.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label style={styles.formLabel}>Estimate (points)</label>
                        <div style={{ display: 'flex', gap: 6 }}>
                            {['1', '2', '3', '5', '8', '13'].map(v => (
                                <button
                                    key={v}
                                    style={{
                                        ...styles.formInput,
                                        width: 40,
                                        padding: '6px 0',
                                        textAlign: 'center' as const,
                                        cursor: 'pointer',
                                        fontWeight: storyForm.estimate === v ? 700 : 400,
                                        background: storyForm.estimate === v ? 'var(--accent)' : 'var(--bg-secondary)',
                                        color: storyForm.estimate === v ? '#fff' : 'var(--text-primary)',
                                        borderColor: storyForm.estimate === v ? 'var(--accent)' : 'var(--border)',
                                    }}
                                    onClick={() => setStoryForm(f => ({ ...f, estimate: f.estimate === v ? '' : v }))}
                                >{v}</button>
                            ))}
                        </div>
                    </div>
                    {storyStatus === 'done' && (
                        <div style={{ padding: '8px 12px', borderRadius: 4, background: 'var(--accent-dim)', color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                            Created {storyUrl
                                ? <a href={storyUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>{storyResult}</a>
                                : storyResult}
                            {creationTokens && (creationTokens.input > 0 || creationTokens.output > 0) && (
                                <div style={{ marginTop: 6, fontSize: 12, color: '#aaa', fontFamily: 'system-ui, sans-serif', display: 'flex', gap: 12, alignItems: 'center' }}>
                                    <span title="Tokens used for enrichment">
                                        <span style={{ color: '#6366f1' }}>{(creationTokens.input + creationTokens.output).toLocaleString()}</span> tokens
                                        <span style={{ opacity: 0.6, marginLeft: 4 }}>({creationTokens.input.toLocaleString()} in / {creationTokens.output.toLocaleString()} out)</span>
                                    </span>
                                </div>
                            )}
                            {execMode === 'speed' && (
                                <div style={{ marginTop: 6, fontSize: 12, color: '#aaa', fontFamily: 'system-ui, sans-serif' }}>
                                    Prompt your agent: <span style={{ color: '#6366f1', userSelect: 'all', cursor: 'pointer' }}>Enrich story {storyResult} with full description, AC, frontend, backend, and QA fields</span>
                                </div>
                            )}
                        </div>
                    )}
                    {storyStatus === 'error' && (
                        <div style={{ padding: '8px 12px', borderRadius: 4, background: 'rgba(220,53,69,0.08)', color: 'var(--error)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                            {storyResult}
                        </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button style={styles.cancelBtn} onClick={() => { onClose(); setStoryStatus('idle'); }}>
                            {storyStatus === 'done' ? 'Close' : 'Cancel'}
                        </button>
                        <button
                            style={{ ...styles.createStoryBtn, opacity: (!storyForm.name.trim() || !storyForm.classOfService?.trim() || storyStatus === 'enriching' || storyStatus === 'creating') ? 0.5 : 1 }}
                            onClick={() => { if (storyStatus === 'done') { setStoryStatus('idle'); setStoryResult(''); setStoryUrl(''); setCreationTokens(null); setStoryForm(f => ({ ...f, name: '', description: '', estimate: '', classOfService: '' })); } else { void handleCreateStory(); } }}
                            disabled={!storyForm.name.trim() || !storyForm.classOfService?.trim() || storyStatus === 'enriching' || storyStatus === 'creating'}
                        >
                            {storyStatus === 'enriching'
                                ? (execMode === 'local' ? 'Goose + Ollama enriching...' : execMode === 'speed' ? 'Creating...' : 'Enriching with Ollama...')
                                : storyStatus === 'creating' ? 'Creating work item...'
                                : storyStatus === 'done' ? 'Create Another'
                                : execMode === 'speed' ? 'Create Story (enrich via agent)' : 'Create Story'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

CreateStoryModal.displayName = 'CreateStoryModal';
