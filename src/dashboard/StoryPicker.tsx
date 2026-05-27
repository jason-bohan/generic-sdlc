import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react';
import { EXCLUDED_STORY_STATUSES } from './types';
import { useFocusTrap } from './hooks/useFocusTrap';

interface Team {
    id: string;
    name: string;
}

interface StorySummary {
    id: string;
    number: string;
    name: string;
    status: string;
    teamId?: string;
    team: string;
    estimate: number | null;
    priority: string;
}

interface StoryDetail {
    id: string;
    number: string;
    name: string;
    description: string;
    status: string;
    teamId?: string;
    team: string;
    estimate: number | null;
    priority: string;
    /** Display name from the planning adapter's class-of-service field. */
    classOfService: string;
    acceptanceCriteria: string;
    frontend: string;
    backend: string;
    qa: string;
    project: string;
    url: string;
}

interface StoryPickerProps {
    agentId: string;
    agentName: string;
    onClose: () => void;
    onAssigned: () => void;
}

type Step = 'team' | 'stories' | 'detail';

function SectionAccordion({ title, html, defaultOpen = false }: { title: string; html: string; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div style={s.accordion}>
            <button
                type="button"
                style={s.accordionHeader}
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
            >
                <span style={s.accordionChevron}>{open ? '\u25BE' : '\u25B8'}</span>
                <span style={s.accordionTitle}>{title}</span>
            </button>
            {open && (
                <div className="sp-rich-html" style={s.accordionBody} dangerouslySetInnerHTML={{ __html: html }} />
            )}
        </div>
    );
}

function WorkSection({ frontend, backend, qa }: { frontend?: string; backend?: string; qa?: string }) {
    const [open, setOpen] = useState(false);
    if (!frontend && !backend && !qa) return null;
    const lanes = [
        frontend && { label: 'Frontend', html: frontend },
        backend && { label: 'Backend', html: backend },
        qa && { label: 'QA', html: qa },
    ].filter(Boolean) as { label: string; html: string }[];

    return (
        <div style={s.accordion}>
            <button type="button" style={s.accordionHeader} onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <span style={s.accordionChevron}>{open ? '\u25BE' : '\u25B8'}</span>
                <span style={s.accordionTitle}>Work Breakdown</span>
                <span style={s.laneCount}>{lanes.length} lane{lanes.length !== 1 ? 's' : ''}</span>
            </button>
            {open && (
                <div style={s.accordionBody}>
                    {lanes.map(lane => (
                        <div key={lane.label} style={s.laneCard}>
                            <div style={s.laneLabel}>{lane.label}</div>
                            <div className="sp-rich-html" style={s.laneContent} dangerouslySetInnerHTML={{ __html: lane.html }} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function StoryPicker({ agentId, agentName, onClose, onAssigned }: StoryPickerProps) {
    const [step, setStep] = useState<Step>('team');
    const [teams, setTeams] = useState<Team[]>([]);
    const [stories, setStories] = useState<StorySummary[]>([]);
    const [selectedStory, setSelectedStory] = useState<StoryDetail | null>(null);
    const [selectedTeam, setSelectedTeam] = useState<string>('');
    const [selectedTeamId, setSelectedTeamId] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [assigning, setAssigning] = useState(false);
    const [environments, setEnvironments] = useState<string[]>([]);
    const [selectedEnv, setSelectedEnv] = useState<string>('');
    const modalRef = useRef<HTMLDivElement>(null);
    useFocusTrap(modalRef, true);

    useEffect(() => {
        setLoading(true);
        setError(null);
        fetch('/api/planning/teams')
            .then(r => { if (!r.ok) throw new Error(`Teams request failed (${r.status})`); return r.json(); })
            .then(data => {
                if (data.error) throw new Error(data.error);
                setTeams(data.teams || []);
            })
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
        fetch('/api/active-project')
            .then(r => { if (!r.ok) return null; return r.json(); })
            .then(data => {
                if (Array.isArray(data?.profile?.environments) && data.profile.environments.length > 0) {
                    setEnvironments(data.profile.environments);
                }
            })
            .catch(() => {});
    }, []);

    const loadStories = useCallback((team: Team) => {
        setSelectedTeam(team.name);
        setSelectedTeamId(team.id);
        setLoading(true);
        setError(null);
        fetch(`/api/planning/stories?team=${encodeURIComponent(team.name)}`)
            .then(r => { if (!r.ok) throw new Error(`Stories request failed (${r.status})`); return r.json(); })
            .then(data => {
                if (data.error) throw new Error(data.error);
                const filtered = (data.stories || []).filter(
                    (s: StorySummary) => !EXCLUDED_STORY_STATUSES.includes(s.status)
                );
                setStories(filtered);
                setStep('stories');
            })
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    const loadDetail = useCallback((number: string) => {
        setLoading(true);
        setError(null);
        fetch(`/api/planning/story?number=${encodeURIComponent(number)}`)
            .then(r => { if (!r.ok) throw new Error(`Story detail request failed (${r.status})`); return r.json(); })
            .then(data => {
                if (data.error) throw new Error(data.error);
                setSelectedStory(data);
                setStep('detail');
            })
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    const assign = useCallback(async () => {
        if (!selectedStory) return;
        setAssigning(true);
        setError(null);
        try {
            const resp = await fetch('/api/scheduler/assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agentId,
                    storyNumber: selectedStory.number,
                    storyName: selectedStory.name,
                    storyDescription: selectedStory.description || null,
                    teamId: selectedStory.teamId || selectedTeamId || undefined,
                    environment: selectedEnv || undefined,
                }),
            });
            if (!resp.ok) throw new Error(`Assign request failed (${resp.status})`);
            const data = await resp.json();
            if (data.error) throw new Error(data.error);
            onAssigned();
        } catch (e: any) {
            setError(e.message);
        } finally {
            setAssigning(false);
        }
    }, [agentId, selectedStory, selectedTeamId, selectedEnv, onAssigned]);

    return (
        <div style={s.overlay} onClick={onClose}>
            {/* Scoped styles for HTML rendered from planning adapters */}
            <style>{richHtmlCss}</style>

            <div ref={modalRef} role="dialog" aria-modal="true" style={s.modal} onClick={e => e.stopPropagation()}>
                <div style={s.header}>
                    <h2 style={s.title}>Pick Up Story for {agentName}</h2>
                    <button type="button" aria-label="Close story picker" style={s.closeBtn} onClick={onClose}>&times;</button>
                </div>

                {/* Breadcrumb */}
                <div style={s.breadcrumb}>
                    <span
                        style={step === 'team' ? s.breadcrumbActive : s.breadcrumbLink}
                        onClick={() => setStep('team')}
                    >
                        Team
                    </span>
                    <span style={s.breadcrumbSep}>/</span>
                    <span
                        style={step === 'stories' || step === 'detail' ? s.breadcrumbActive : s.breadcrumbDim}
                        onClick={() => { if (selectedTeam) setStep('stories'); }}
                    >
                        Stories
                    </span>
                    {step === 'detail' && (
                        <>
                            <span style={s.breadcrumbSep}>/</span>
                            <span style={s.breadcrumbActive}>Detail</span>
                        </>
                    )}
                </div>

                {error && <div style={s.error}>{error}</div>}

                {loading && <div style={s.loading}>Loading...</div>}

                {!loading && step === 'team' && (
                    <div style={s.list}>
                        {teams.length === 0 && <p style={s.empty}>No teams found. Check .env credentials.</p>}
                        {teams.map(t => (
                            <button key={t.id} style={s.listItem} onClick={() => loadStories(t)}>
                                <span style={s.listItemName}>{t.name}</span>
                                <span style={s.listItemArrow}>&rarr;</span>
                            </button>
                        ))}
                    </div>
                )}

                {!loading && step === 'stories' && (
                    <div style={s.list}>
                        {stories.length === 0 && <p style={s.empty}>No open stories for {selectedTeam}.</p>}
                        {stories.map(st => (
                            <button key={st.id} style={s.listItem} onClick={() => loadDetail(st.number)}>
                                <div style={s.storyRow}>
                                    <span style={s.storyNumber}>{st.number}</span>
                                    <span style={s.storyName}>{st.name}</span>
                                </div>
                                <div style={s.storyMeta}>
                                    <span style={s.badge}>{st.status}</span>
                                    {st.priority && <span style={s.badgePri}>{st.priority}</span>}
                                    {st.estimate != null && <span style={s.est}>{st.estimate} pts</span>}
                                </div>
                            </button>
                        ))}
                    </div>
                )}

                {!loading && step === 'detail' && selectedStory && (
                    <>
                        <div style={s.detail}>
                            {/* ── Hero ── */}
                            <div style={s.hero}>
                                <div style={s.heroRow}>
                                    {selectedStory.url ? (
                                        <a href={selectedStory.url} target="_blank" rel="noopener noreferrer" style={s.heroNumber}>{selectedStory.number}</a>
                                    ) : (
                                        <span style={{ ...s.heroNumber, textDecoration: 'none', cursor: 'default' }}>{selectedStory.number}</span>
                                    )}
                                    <span style={s.heroProject}>{selectedStory.project || 'N/A'}</span>
                                    <div style={s.heroPills}>
                                        <span style={s.badge}>{selectedStory.status}</span>
                                        {selectedStory.classOfService ? (
                                            <span style={s.cosPill} title="Class of Service">{selectedStory.classOfService}</span>
                                        ) : null}
                                        {selectedStory.estimate != null && <span style={s.estPill}>{selectedStory.estimate} pts</span>}
                                    </div>
                                </div>
                                <h3 style={s.heroTitle}>{selectedStory.name}</h3>
                            </div>

                            {/* ── Content Sections ── */}
                            {selectedStory.description && (
                                <SectionAccordion title="Description" html={selectedStory.description} defaultOpen />
                            )}
                            {selectedStory.acceptanceCriteria && (
                                <SectionAccordion title="Acceptance Criteria" html={selectedStory.acceptanceCriteria} />
                            )}
                            <WorkSection
                                frontend={selectedStory.frontend}
                                backend={selectedStory.backend}
                                qa={selectedStory.qa}
                            />
                        </div>

                        {/* ── Sticky CTA ── */}
                        <div style={s.ctaBar}>
                            {environments.length > 0 && (
                                <div style={s.envPicker}>
                                    <label style={s.envLabel}>Environment</label>
                                    <select
                                        value={selectedEnv}
                                        onChange={(e) => setSelectedEnv(e.target.value)}
                                        style={s.envSelect}
                                        aria-label="Select development environment"
                                    >
                                        <option value="">(none)</option>
                                        {environments.map(env => (
                                            <option key={env} value={env}>{env}</option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        style={s.envAssistantBtn}
                                        title="Open Assistant to check environment status"
                                        onClick={() => {
                                            fetch('/api/open-assistant', { method: 'POST' }).catch(() => {});
                                        }}
                                    >
                                        &#x1F4BB; Envs
                                    </button>
                                </div>
                            )}
                            <button
                                style={assigning ? s.ctaBtnDisabled : s.ctaBtn}
                                onClick={assign}
                                disabled={assigning}
                            >
                                {assigning ? 'Assigning...' : `Assign to ${agentName}`}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
StoryPicker.displayName = 'StoryPicker';

/* ─────────────────────────────────────────────────────────
   Scoped CSS for planning HTML content.
   Normalizes headings, lists, code blocks, and links
   inside .sp-rich-html containers so they look consistent
   regardless of what the planning adapter sends.
   ───────────────────────────────────────────────────────── */
const richHtmlCss = `
.sp-rich-html h1,.sp-rich-html h2,.sp-rich-html h3,.sp-rich-html h4{
  font-size:13px;font-weight:700;margin:8px 0 4px;color:var(--text-primary);
}
.sp-rich-html h2{font-size:14px;}
.sp-rich-html p{margin:4px 0;line-height:1.55;}
.sp-rich-html ul,.sp-rich-html ol{
  margin:4px 0 4px 18px;padding:0;
}
.sp-rich-html li{margin:2px 0;line-height:1.5;}
.sp-rich-html code{
  font-family:var(--font-mono, 'SF Mono', Consolas, monospace);
  font-size:12px;padding:1px 5px;border-radius:3px;
  background:var(--bg-secondary);color:var(--accent);
}
.sp-rich-html a{color:var(--accent);text-decoration:underline;}
.sp-rich-html strong,.sp-rich-html b{font-weight:600;color:var(--text-primary);}
`;

const s: Record<string, CSSProperties> = {
    overlay: {
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999,
    },
    modal: {
        background: 'var(--bg-card)',
        borderRadius: 14,
        width: '92%',
        maxWidth: 720,
        maxHeight: '85vh',
        display: 'flex', flexDirection: 'column',
        border: '1px solid var(--border)',
        overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
    },

    /* ── Header ── */
    header: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
    },
    title: {
        margin: 0, fontSize: 16, fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
    },
    closeBtn: {
        background: 'none', border: 'none',
        color: 'var(--text-tertiary)', fontSize: 22, cursor: 'pointer',
        padding: '2px 6px', borderRadius: 4,
        lineHeight: 1,
    },

    /* ── Breadcrumb ── */
    breadcrumb: {
        padding: '8px 20px', fontSize: 12,
        color: 'var(--text-secondary)',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'system-ui, sans-serif',
    },
    breadcrumbActive: { color: 'var(--text-primary)', fontWeight: 600 },
    breadcrumbLink: { color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 },
    breadcrumbDim: { color: 'var(--text-tertiary)' },
    breadcrumbSep: { margin: '0 6px', color: 'var(--text-tertiary)' },

    /* ── Shared ── */
    error: {
        margin: '12px 20px', padding: '10px 14px',
        background: 'var(--accent-dim)', border: '1px solid var(--error)',
        borderRadius: 6, color: 'var(--error)', fontSize: 13,
    },
    loading: {
        padding: '48px 20px', textAlign: 'center',
        color: 'var(--text-tertiary)', fontSize: 14,
    },
    list: { overflowY: 'auto', flex: 1, padding: '8px 14px' },
    empty: {
        color: 'var(--text-tertiary)', textAlign: 'center', padding: 28, fontSize: 14,
    },
    listItem: {
        display: 'block', width: '100%', padding: '12px 14px', margin: '4px 0',
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 8, cursor: 'pointer', textAlign: 'left',
        color: 'var(--text-primary)', transition: 'background 0.15s',
    },
    listItemName: { fontSize: 14, fontWeight: 500 },
    listItemArrow: { float: 'right', color: 'var(--text-tertiary)' },
    storyRow: { display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 4 },
    storyNumber: {
        fontSize: 12, color: 'var(--accent)', fontWeight: 700, fontFamily: 'monospace',
    },
    storyName: { fontSize: 14, color: 'var(--text-primary)', flex: 1 },
    storyMeta: { display: 'flex', gap: 8, alignItems: 'center' },
    badge: {
        fontSize: 10, padding: '2px 8px', borderRadius: 4,
        background: 'var(--accent-dim)', color: 'var(--text-secondary)',
        fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
    },
    badgePri: {
        fontSize: 10, padding: '2px 8px', borderRadius: 4,
        background: 'var(--accent-dim)', color: 'var(--warning)', fontWeight: 600,
    },
    est: { fontSize: 11, color: 'var(--text-tertiary)' },

    /* ── Detail: scrollable body ── */
    detail: {
        overflowY: 'auto', flex: 1, padding: '0 20px 12px',
    },

    /* ── Hero ── */
    hero: {
        padding: '18px 0 14px',
        borderBottom: '2px solid var(--border)',
        marginBottom: 14,
    },
    heroRow: {
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap',
    },
    heroNumber: {
        fontSize: 15, fontWeight: 800, fontFamily: 'monospace',
        color: 'var(--accent)', textDecoration: 'none',
        borderBottom: '1px dashed var(--accent)', cursor: 'pointer',
        letterSpacing: '0.03em',
    },
    heroProject: {
        fontSize: 12, color: 'var(--text-tertiary)',
        marginLeft: 4,
    },
    heroPills: {
        display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto',
    },
    estPill: {
        fontSize: 11, padding: '2px 10px', borderRadius: 10,
        background: 'var(--accent)', color: '#fff', fontWeight: 700,
    },
    cosPill: {
        fontSize: 10, padding: '2px 10px', borderRadius: 10,
        background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
        border: '1px solid var(--border)', fontWeight: 600,
    },
    heroTitle: {
        fontSize: 20, fontWeight: 700, margin: 0, lineHeight: 1.3,
        color: 'var(--text-primary)',
    },

    /* ── Accordion ── */
    accordion: {
        marginBottom: 8,
        borderRadius: 8,
        border: '1px solid var(--border)',
        overflow: 'hidden',
    },
    accordionHeader: {
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '10px 14px',
        background: 'var(--bg-secondary)', border: 'none',
        cursor: 'pointer', textAlign: 'left',
        color: 'var(--text-primary)',
        fontSize: 13, fontWeight: 600,
    },
    accordionChevron: {
        fontSize: 12, color: 'var(--text-tertiary)', width: 12, flexShrink: 0,
    },
    accordionTitle: {
        flex: 1,
    },
    accordionBody: {
        padding: '10px 14px',
        fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6,
        maxHeight: 240, overflowY: 'auto',
        borderTop: '1px solid var(--border)',
    },

    /* ── Work Breakdown lanes ── */
    laneCount: {
        fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400,
    },
    laneCard: {
        padding: '10px 12px', marginBottom: 8,
        borderRadius: 6, background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
    },
    laneLabel: {
        fontSize: 11, fontWeight: 700, color: 'var(--accent)',
        textTransform: 'uppercase' as const, letterSpacing: '0.06em',
        marginBottom: 6,
    },
    laneContent: {
        fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5,
    },

    /* ── Sticky CTA bar ── */
    ctaBar: {
        padding: '12px 20px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-card)',
        flexShrink: 0,
    },
    ctaBtn: {
        width: '100%', padding: '12px 20px',
        background: 'var(--accent)', color: '#fff',
        border: 'none', borderRadius: 8,
        fontSize: 14, fontWeight: 700, cursor: 'pointer',
        transition: 'opacity 0.15s',
    },
    ctaBtnDisabled: {
        width: '100%', padding: '12px 20px',
        background: 'var(--border)', color: 'var(--text-tertiary)',
        border: 'none', borderRadius: 8,
        fontSize: 14, fontWeight: 700, cursor: 'not-allowed',
    },

    /* ── Environment picker ── */
    envPicker: {
        display: 'flex', alignItems: 'center', gap: 10,
        marginBottom: 10,
    },
    envLabel: {
        fontSize: 13, fontWeight: 600,
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap' as const,
    },
    envSelect: {
        flex: 1,
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '8px 10px',
        fontSize: 13,
        cursor: 'pointer',
        outline: 'none',
    },
    envAssistantBtn: {
        background: 'var(--bg-secondary)',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '7px 12px',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap' as const,
        transition: 'background 0.15s',
    },
};
