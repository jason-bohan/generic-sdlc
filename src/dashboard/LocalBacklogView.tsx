import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { AGENT_ROSTER, type AgentProfile } from './types';
import { htmlToPlainText, plainTextToHtml } from './agent-detail-utils';

const AGENT_CATEGORY: Record<string, string> = {
    frontend: 'Frontend', backend: 'Api', qa: 'QA', devops: 'AzureDevOps', ux: 'UX',
};
const ASSIGNABLE_AGENTS = AGENT_ROSTER.filter((a) => a.active && a.id !== 'reviewer');

interface LocalStory {
    id: string;
    number: string;
    name: string;
    description: string;
    status: string;
    team: string;
    teamId: string;
    estimate: number | null;
    priority: string;
    scope: string;
    classOfService: string;
    acceptanceCriteria: string;
    frontend: string;
    backend: string;
    qa: string;
    owner?: string;
    sortOrder?: number;
    tasks: LocalTask[];
}

interface LocalTask {
    id: string;
    number: string;
    name: string;
    parent: string;
    status: string;
    owners: string[];
    estimate: number;
    todo: number;
    done: number;
    category: string;
}

interface LocalBoard {
    teams: Array<{ id: string; name: string }>;
    members: Array<{ id: string; name: string; nickname?: string }>;
    classOfService: Array<{ id: string; name: string }>;
    stories: LocalStory[];
}

interface Props {
    onBack: () => void;
    onAssigned?: (agent: AgentProfile) => void;
}

// Agility storyboard statuses. The first four make up the "In Progress" WIP group.
const IN_PROGRESS_STATUSES = ['Planning', 'In Development', 'In QA', 'In the Queue'];
const STORY_COLUMNS = [
    ...IN_PROGRESS_STATUSES,
    'In Master',
    'Pending Release',
    'Partially Released',
    'Released',
    'Closed',
];
const WIP_LIMIT = 6;
const BACKLOG_STATUS = 'Backlog';
const TASK_COLUMNS = ['Backlog', 'None', 'In Progress', 'Completed'];
const LOCAL_BACKLOG_TABS = ['Backlog', 'Storyboard', 'Taskboard', 'List View', 'Closed'] as const;
const TERMINAL_STATUSES = ['Closed', 'Archived'];
const STATUS_EDIT_OPTIONS = Array.from(
    new Set([
        BACKLOG_STATUS,
        ...STORY_COLUMNS.filter((status) => !TERMINAL_STATUSES.includes(status)),
        ...TERMINAL_STATUSES,
    ]),
);

type LocalBacklogTab = typeof LOCAL_BACKLOG_TABS[number];

const COS_COLORS: Record<string, string> = {
    Standard: '#14b8a6',
    Expedite: '#ef4444',
    'Fixed Date': '#f59e0b',
    Intangible: '#8b5cf6',
};

function cosColor(classOfService: string): string {
    return COS_COLORS[classOfService] ?? 'var(--accent)';
}

function isBoardStatus(status: string): boolean {
    return STORY_COLUMNS.includes(status);
}

function isClosedStatus(status: string): boolean {
    return ['Closed', 'Archived', 'Released'].includes(status);
}

function initials(name: string): string {
    const parts = name.replace(/,/g, '').trim().split(/\s+/);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const EMPTY_BOARD: LocalBoard = {
    teams: [],
    members: [],
    classOfService: [],
    stories: [],
};

function usePersistedList(key: string): [string[], (updater: (prev: string[]) => string[]) => void] {
    const [value, setValue] = useState<string[]>(() => {
        try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : []; } catch { return []; }
    });
    const update = useCallback((updater: (prev: string[]) => string[]) => {
        setValue((prev) => {
            const next = updater(prev);
            try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* quota */ }
            return next;
        });
    }, [key]);
    return [value, update];
}

export default function LocalBacklogView({ onBack, onAssigned }: Props) {
    const [board, setBoard] = useState<LocalBoard>(EMPTY_BOARD);
    const [selectedStoryNumber, setSelectedStoryNumber] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<LocalBacklogTab>('Taskboard');
    const [collapsedStoryColumns, setCollapsedStoryColumns] = usePersistedList('lbv-collapsed-story-cols');
    const [collapsedTaskColumns, setCollapsedTaskColumns] = usePersistedList('lbv-collapsed-task-cols');
    const [showCreateStory, setShowCreateStory] = useState(false);
    const [showCreateTask, setShowCreateTask] = useState(false);
    const [aiCreating, setAiCreating] = useState(false);
    const [editingStory, setEditingStory] = useState<LocalStory | null>(null);
    const [savingStory, setSavingStory] = useState(false);
    const [assigningStory, setAssigningStory] = useState<LocalStory | null>(null);
    const [assignAgentId, setAssignAgentId] = useState('frontend');
    const [confirmingDelete, setConfirmingDelete] = useState<LocalStory | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    const dragSourceIndex = useRef<number | null>(null);
    const [storyForm, setStoryForm] = useState({
        name: '',
        description: '',
        acceptanceCriteria: '',
        frontend: '',
        backend: '',
        qa: '',
        estimate: '',
        team: 'SDLC Framework',
        classOfService: 'Standard',
        priority: '',
    });
    const [taskForm, setTaskForm] = useState({ name: '', estimate: '1', category: 'Frontend', agentId: 'frontend' });
    const [storyEditForm, setStoryEditForm] = useState({
        name: '',
        description: '',
        acceptanceCriteria: '',
        frontend: '',
        backend: '',
        qa: '',
        estimate: '',
        team: 'SDLC Framework',
        status: BACKLOG_STATUS,
        classOfService: 'Standard',
        priority: '',
    });

    const loadBoard = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [teamsRes, classOfServiceRes, membersRes, storiesRes] = await Promise.all([
                fetch('/api/agility/teams?source=local'),
                fetch('/api/agility/class-of-service?source=local'),
                fetch('/api/agility/members?source=local'),
                fetch('/api/agility/stories?source=local&maxResults=500'),
            ]);
            const [teamsData, classOfServiceData, membersData, storiesData] = await Promise.all([
                teamsRes.json(),
                classOfServiceRes.json(),
                membersRes.json(),
                storiesRes.json(),
            ]);
            const firstError = [teamsData, classOfServiceData, membersData, storiesData].find((data) => data.error);
            if (firstError?.error) throw new Error(firstError.error);
            const stories = (storiesData.stories ?? []) as LocalStory[];
            const tasksByStory = await Promise.all(stories.map(async (story) => {
                const tasksRes = await fetch(`/api/agility/tasks?story=${encodeURIComponent(story.number)}`);
                const tasksData = await tasksRes.json();
                if (tasksData.error) throw new Error(tasksData.error);
                return {
                    ...story,
                    description: story.description ?? '',
                    classOfService: story.classOfService ?? 'Standard',
                    acceptanceCriteria: story.acceptanceCriteria ?? '',
                    frontend: story.frontend ?? '',
                    backend: story.backend ?? '',
                    qa: story.qa ?? '',
                    tasks: (tasksData.tasks ?? []).map((task: any) => ({
                        id: task.id ?? task.number,
                        number: task.number,
                        name: task.name,
                        parent: story.number,
                        status: task.agilityStatus ?? task.status ?? 'None',
                        owners: task.owners ?? [],
                        estimate: task.estimate ?? task.hours ?? 0,
                        todo: task.todo ?? 0,
                        done: task.done ?? 0,
                        category: task.category ?? '',
                    })),
                };
            }));
            const data: LocalBoard = {
                teams: teamsData.teams ?? [],
                members: membersData.members ?? [],
                classOfService: classOfServiceData.values ?? [],
                stories: tasksByStory,
            };
            setBoard(data);
            setSelectedStoryNumber((current) => {
                if (current && data.stories.some((story: LocalStory) => story.number === current)) return current;
                return data.stories[0]?.number ?? '';
            });
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void loadBoard(); }, [loadBoard]);

    const selectedStory = useMemo(
        () => board.stories.find((story) => story.number === selectedStoryNumber) ?? board.stories[0] ?? null,
        [board.stories, selectedStoryNumber],
    );

    const backlogStories = useMemo(
        () => board.stories
            .filter((story) => !isBoardStatus(story.status) && !isClosedStatus(story.status) && !story.owner)
            .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)),
        [board.stories],
    );

    const boardStories = useMemo(
        () => board.stories.filter((story) => isBoardStatus(story.status)),
        [board.stories],
    );

    const openStories = useMemo(
        () => board.stories
            .filter((story) => !isClosedStatus(story.status))
            .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)),
        [board.stories],
    );

    const closedStories = useMemo(
        () => board.stories.filter((story) => isClosedStatus(story.status)),
        [board.stories],
    );

    const storiesByStatus = useMemo(() => {
        const grouped = new Map<string, LocalStory[]>();
        for (const column of STORY_COLUMNS) grouped.set(column, []);
        for (const story of boardStories) {
            const bucket = grouped.get(story.status);
            if (bucket) bucket.push(story);
        }
        return grouped;
    }, [boardStories]);

    const inProgressCount = useMemo(
        () => boardStories.filter((story) => IN_PROGRESS_STATUSES.includes(story.status)).length,
        [boardStories],
    );

    const tasksByStatus = useMemo(() => {
        const grouped = new Map<string, LocalTask[]>();
        for (const column of TASK_COLUMNS) grouped.set(column, []);
        for (const task of selectedStory?.tasks ?? []) {
            const key = TASK_COLUMNS.includes(task.status) ? task.status : 'None';
            grouped.get(key)!.push(task);
        }
        return grouped;
    }, [selectedStory]);

    const storyColumnsStyle = useMemo<CSSProperties>(() => ({
        display: 'grid',
        gap: 8,
        gridTemplateColumns: STORY_COLUMNS.map((column) => collapsedStoryColumns.includes(column) ? '44px' : 'minmax(150px, 1fr)').join(' '),
    }), [collapsedStoryColumns]);

    const taskColumnsStyle = useMemo<CSSProperties>(() => ({
        display: 'grid',
        gap: 8,
        gridTemplateColumns: TASK_COLUMNS.map((column) => collapsedTaskColumns.includes(column) ? '44px' : 'minmax(170px, 1fr)').join(' '),
    }), [collapsedTaskColumns]);

    const createStory = useCallback(async () => {
        if (!storyForm.name.trim()) return;
        setError(null);
        setNotice(null);
        try {
            const res = await fetch('/api/agility/create-story', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...storyForm,
                    source: 'local',
                    estimate: storyForm.estimate ? Number(storyForm.estimate) : null,
                }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setShowCreateStory(false);
            setStoryForm({ ...storyForm, name: '', description: '', acceptanceCriteria: '', frontend: '', backend: '', qa: '', estimate: '', priority: '' });
            setNotice(`Created ${data.number}`);
            await loadBoard();
            setSelectedStoryNumber(data.number);
        } catch (e: any) {
            setError(e.message);
        }
    }, [loadBoard, storyForm]);

    const createAiStory = useCallback(async () => {
        if (!storyForm.name.trim()) return;
        setError(null);
        setNotice(null);
        setAiCreating(true);
        try {
            const res = await fetch('/api/agility/create-story', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: storyForm.name,
                    description: storyForm.description,
                    estimate: storyForm.estimate ? Number(storyForm.estimate) : undefined,
                    team: storyForm.team,
                    classOfService: storyForm.classOfService,
                    priority: storyForm.priority,
                    source: 'local',
                    enrich: true,
                }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setShowCreateStory(false);
            setStoryForm({ ...storyForm, name: '', description: '', acceptanceCriteria: '', frontend: '', backend: '', qa: '', estimate: '', priority: '' });
            setNotice(data.enriched ? `AI created ${data.number}` : `Created ${data.number}; AI enrichment was unavailable`);
            await loadBoard();
            setSelectedStoryNumber(data.number);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setAiCreating(false);
        }
    }, [loadBoard, storyForm]);

    const createTask = useCallback(async () => {
        if (!selectedStory || !taskForm.name.trim()) return;
        setError(null);
        setNotice(null);
        try {
            const res = await fetch('/api/scheduler/create-task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agentId: taskForm.agentId,
                    storyNumber: selectedStory.number,
                    name: taskForm.name,
                    estimate: taskForm.estimate ? Number(taskForm.estimate) : 0,
                    category: taskForm.category,
                }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setShowCreateTask(false);
            setTaskForm({ name: '', estimate: '1', category: taskForm.category, agentId: taskForm.agentId });
            setNotice(`Created ${data.number ?? data.name ?? 'task'}`);
            await loadBoard();
        } catch (e: any) {
            setError(e.message);
        }
    }, [loadBoard, selectedStory, taskForm]);

    const openStoryDetail = useCallback(async (story: LocalStory) => {
        setSelectedStoryNumber(story.number);
        setError(null);
        try {
            const res = await fetch(`/api/agility/story?number=${encodeURIComponent(story.number)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            const detail = { ...story, ...data, tasks: story.tasks } as LocalStory;
            setEditingStory(detail);
            setStoryEditForm({
                name: detail.name ?? '',
                description: htmlToPlainText(detail.description ?? ''),
                acceptanceCriteria: htmlToPlainText(detail.acceptanceCriteria ?? ''),
                frontend: htmlToPlainText(detail.frontend ?? ''),
                backend: htmlToPlainText(detail.backend ?? ''),
                qa: htmlToPlainText(detail.qa ?? ''),
                estimate: detail.estimate != null ? String(detail.estimate) : '',
                team: detail.team || 'SDLC Framework',
                status: detail.status || BACKLOG_STATUS,
                classOfService: detail.classOfService || 'Standard',
                priority: detail.priority ?? '',
            });
        } catch (e: any) {
            setError(e.message);
        }
    }, []);

    const saveStoryDetail = useCallback(async () => {
        if (!editingStory || !storyEditForm.name.trim()) return;
        setSavingStory(true);
        setError(null);
        setNotice(null);
        try {
            const res = await fetch('/api/agility/story', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    number: editingStory.number,
                    ...storyEditForm,
                    description: plainTextToHtml(storyEditForm.description),
                    acceptanceCriteria: plainTextToHtml(storyEditForm.acceptanceCriteria),
                    frontend: plainTextToHtml(storyEditForm.frontend),
                    backend: plainTextToHtml(storyEditForm.backend),
                    qa: plainTextToHtml(storyEditForm.qa),
                    source: 'local',
                    estimate: storyEditForm.estimate !== '' ? Number(storyEditForm.estimate) : null,
                }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setEditingStory(null);
            setNotice(`Updated ${editingStory.number}`);
            await loadBoard();
            setSelectedStoryNumber(editingStory.number);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setSavingStory(false);
        }
    }, [editingStory, loadBoard, storyEditForm]);

    const toggleStoryColumn = useCallback((column: string) => {
        setCollapsedStoryColumns((current) => current.includes(column) ? current.filter((item) => item !== column) : [...current, column]);
    }, []);

    const toggleTaskColumn = useCallback((column: string) => {
        setCollapsedTaskColumns((current) => current.includes(column) ? current.filter((item) => item !== column) : [...current, column]);
    }, []);

    const moveStory = useCallback(async (storyNumber: string, status: string) => {
        setError(null);
        setBoard((current) => ({
            ...current,
            stories: current.stories.map((story) => story.number === storyNumber ? { ...story, status } : story),
        }));
        try {
            const res = await fetch('/api/agility/story-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ number: storyNumber, status, source: 'local' }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            await loadBoard();
        } catch (e: any) {
            setError(e.message);
            await loadBoard();
        }
    }, [loadBoard]);

    const moveTask = useCallback(async (taskNumber: string, status: string) => {
        setError(null);
        setBoard((current) => ({
            ...current,
            stories: current.stories.map((story) => ({
                ...story,
                tasks: story.tasks.map((task) => task.number === taskNumber ? { ...task, status } : task),
            })),
        }));
        try {
            const res = await fetch('/api/agility/task-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ number: taskNumber, status, source: 'local' }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            await loadBoard();
        } catch (e: any) {
            setError(e.message);
            await loadBoard();
        }
    }, [loadBoard]);

    const handleStoryDrop = useCallback((event: DragEvent, status: string) => {
        event.preventDefault();
        const raw = event.dataTransfer.getData('application/json');
        if (!raw) return;
        const dropped = JSON.parse(raw) as { type?: string; number?: string };
        if (dropped.type === 'story' && dropped.number) void moveStory(dropped.number, status);
    }, [moveStory]);

    const handleTaskDrop = useCallback((event: DragEvent, status: string) => {
        event.preventDefault();
        const raw = event.dataTransfer.getData('application/json');
        if (!raw) return;
        const dropped = JSON.parse(raw) as { type?: string; number?: string };
        if (dropped.type === 'task' && dropped.number) void moveTask(dropped.number, status);
    }, [moveTask]);

    const assignStory = useCallback(async () => {
        if (!assigningStory) return;
        const agent = AGENT_ROSTER.find((a) => a.id === assignAgentId);
        setError(null);
        setNotice(null);
        try {
            const res = await fetch('/api/scheduler/assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agentId: assignAgentId,
                    storyNumber: assigningStory.number,
                    storyName: assigningStory.name,
                    storyDescription: assigningStory.description,
                    frontend: assigningStory.frontend,
                    backend: assigningStory.backend,
                    qa: assigningStory.qa,
                    teamId: assigningStory.teamId,
                    storySource: 'local',
                }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setAssigningStory(null);
            setNotice(`${assigningStory.number} assigned to ${agent?.name ?? assignAgentId}`);
            if (agent) onAssigned?.(agent);
        } catch (e: any) {
            setError(e.message);
        }
    }, [assignAgentId, assigningStory, onAssigned]);

    const closeStory = useCallback(async (story: LocalStory) => {
        setError(null);
        setNotice(null);
        try {
            const res = await fetch('/api/agility/story-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ number: story.number, status: 'Closed', source: 'local' }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setEditingStory(null);
            setNotice(`${story.number} closed`);
            await loadBoard();
        } catch (e: any) {
            setError(e.message);
        }
    }, [loadBoard]);

    const deleteStory = useCallback(async (story: LocalStory) => {
        setError(null);
        setNotice(null);
        try {
            const res = await fetch('/api/agility/delete-story', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ number: story.number }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setConfirmingDelete(null);
            setEditingStory(null);
            setNotice(`${story.number} deleted`);
            await loadBoard();
        } catch (e: any) {
            setError(e.message);
        }
    }, [loadBoard]);

    const handleReorderDrop = useCallback((stories: LocalStory[], fromIdx: number, toIdx: number) => {
        if (fromIdx === toIdx) return;
        const reordered = [...stories];
        const [moved] = reordered.splice(fromIdx, 1);
        reordered.splice(toIdx > fromIdx ? toIdx - 1 : toIdx, 0, moved);
        const numbers = reordered.map((s) => s.number);
        setBoard((prev) => {
            const storyMap = new Map(prev.stories.map((s) => [s.number, s]));
            for (let i = 0; i < numbers.length; i++) {
                const st = storyMap.get(numbers[i]);
                if (st) st.sortOrder = i;
            }
            return { ...prev, stories: [...prev.stories] };
        });
        setDragOverIndex(null);
        dragSourceIndex.current = null;
        fetch('/api/agility/reorder-stories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ numbers }),
        }).catch(() => { /* best-effort persist */ });
    }, []);

    return (
        <div style={s.page}>
            <style>{lbvCss}</style>

            <header style={s.topbar}>
                <div style={s.brandCluster}>
                    <button type="button" style={s.backBtn} onClick={onBack} aria-label="Back to floor">&larr;</button>
                    <div style={s.mascot} aria-hidden="true">M</div>
                    <div>
                        <div style={s.kicker}>Local Agility</div>
                        <h1 style={s.title}>SDLC Framework</h1>
                    </div>
                    <span style={s.localBadge}>LOCAL ONLY</span>
                </div>

                <div style={s.metrics}>
                    <Metric label="In Progress" value={inProgressCount} sub={`/ ${WIP_LIMIT} WIP`} />
                    <Metric label="Backlog" value={backlogStories.length} />
                    <Metric label="Stories" value={openStories.length} />
                    <Metric label="Closed" value={closedStories.length} />
                </div>

                <div style={s.actions}>
                    <button style={s.secondaryBtn} onClick={() => { void loadBoard(); }}>Refresh</button>
                    <button style={s.primaryBtn} onClick={() => setShowCreateStory(true)}>+ Story</button>
                </div>
            </header>

            {board.members.length > 0 && (
                <div style={s.personaStrip} aria-label="Local team">
                    {board.members.map((member) => (
                        <div key={member.id} style={s.persona} title={member.name}>
                            <div style={s.avatar}>{initials(member.name)}</div>
                            <span style={s.personaName}>{member.nickname || member.name.split(',')[0]}</span>
                        </div>
                    ))}
                </div>
            )}

            <nav style={s.tabs} aria-label="Local backlog views">
                {LOCAL_BACKLOG_TABS.map((tab) => (
                    <button
                        key={tab}
                        type="button"
                        style={activeTab === tab ? s.activeTab : s.tab}
                        onClick={() => setActiveTab(tab)}
                        aria-pressed={activeTab === tab}
                    >
                        {tab}
                    </button>
                ))}
            </nav>

            {error && <div style={s.error}>{error}</div>}
            {notice && <div style={s.notice}>{notice}</div>}
            {loading && <div style={s.loading}>Loading local backlog...</div>}

            {activeTab === 'Backlog' && (
                <main style={s.singlePane}>
                    <section style={s.backlogPanel} aria-label="Local backlog">
                        <div style={s.sectionHeader}>
                            <h2 style={s.sectionTitle}>Backlog</h2>
                            <span style={s.count}>{backlogStories.length} items</span>
                        </div>
                        {backlogStories.length === 0 ? (
                            <div style={s.empty}>No backlog items. Create one here when SDLC Framework work should stay local.</div>
                        ) : (
                            <div style={s.backlogList} role="list" onDragLeave={() => setDragOverIndex(null)}>
                                <div style={s.weekSeparator}>Backlog</div>
                                {backlogStories.map((story, idx) => (
                                    <div
                                        key={story.number}
                                        role="listitem"
                                        style={{
                                            ...(story.number === selectedStory?.number ? s.backlogRowActive : s.backlogRow),
                                            ...(dragOverIndex === idx ? { borderTop: '2px solid var(--accent)' } : {}),
                                        }}
                                        onClick={() => { void openStoryDetail(story); }}
                                        draggable
                                        onDragStart={(event) => {
                                            dragSourceIndex.current = idx;
                                            event.dataTransfer.setData('application/json', JSON.stringify({ type: 'story', number: story.number }));
                                            event.dataTransfer.effectAllowed = 'move';
                                        }}
                                        onDragOver={(event) => { event.preventDefault(); setDragOverIndex(idx); }}
                                        onDrop={(event) => {
                                            event.preventDefault();
                                            if (dragSourceIndex.current != null) handleReorderDrop(backlogStories, dragSourceIndex.current, idx);
                                        }}
                                        onDragEnd={() => { setDragOverIndex(null); dragSourceIndex.current = null; }}
                                    >
                                        <span style={s.dragHandle} aria-hidden="true">⠿</span>
                                        <span style={s.workIcon} aria-hidden="true">▤</span>
                                        <span style={s.backlogName}>{story.name}{story.estimate != null ? ` (${story.estimate})` : ''}</span>
                                        <OwnerBadge owner={story.owner} />
                                        <span style={s.backlogTeam}>{story.team}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                </main>
            )}

            {activeTab === 'Storyboard' && (
                <main style={s.singlePane}>
                    <section style={s.storyboard} aria-label="Local stories">
                        <div style={s.sectionHeader}>
                            <h2 style={s.sectionTitle}>Storyboard</h2>
                            <span style={s.count}>{boardStories.length} on board</span>
                        </div>
                        <Storyboard
                            columns={STORY_COLUMNS}
                            storiesByStatus={storiesByStatus}
                            collapsed={collapsedStoryColumns}
                            onToggle={toggleStoryColumn}
                            onDrop={handleStoryDrop}
                            onOpen={(story) => { void openStoryDetail(story); }}
                            onCloseStory={(story) => { void closeStory(story); }}
                            onDeleteStory={setConfirmingDelete}
                            activeNumber={selectedStory?.number ?? ''}
                            columnsStyle={storyColumnsStyle}
                            inProgressCount={inProgressCount}
                        />
                    </section>
                </main>
            )}

            {activeTab === 'Taskboard' && (
                <main style={s.main}>
                    <section style={s.storyboard} aria-label="Local stories">
                        <div style={s.sectionHeader}>
                            <h2 style={s.sectionTitle}>Stories</h2>
                            <span style={s.count}>{openStories.length} stories</span>
                        </div>
                        <div style={s.taskboardStoryList} role="list" onDragLeave={() => setDragOverIndex(null)}>
                            {openStories.length === 0 ? (
                                <div style={s.empty}>Create a local story to start dogfooding SDLC Framework here.</div>
                            ) : openStories.map((story, idx) => (
                                <button
                                    key={story.number}
                                    type="button"
                                    role="listitem"
                                    style={{
                                        ...(story.number === selectedStory?.number ? s.taskStoryRowActive : s.taskStoryRow),
                                        ...(dragOverIndex === idx ? { borderTop: '2px solid var(--accent)' } : {}),
                                    }}
                                    onClick={() => { void openStoryDetail(story); }}
                                    draggable
                                    onDragStart={(event) => {
                                        dragSourceIndex.current = idx;
                                        event.dataTransfer.setData('application/json', JSON.stringify({ type: 'story', number: story.number }));
                                        event.dataTransfer.effectAllowed = 'move';
                                    }}
                                    onDragOver={(event) => { event.preventDefault(); setDragOverIndex(idx); }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        if (dragSourceIndex.current != null) handleReorderDrop(openStories, dragSourceIndex.current, idx);
                                    }}
                                    onDragEnd={() => { setDragOverIndex(null); dragSourceIndex.current = null; }}
                                >
                                    <span style={s.cardNumber}>{story.number}</span>
                                    <strong style={s.cardTitle}>{story.name}</strong>
                                    <span style={s.cardMeta}>{story.status} · {story.team} · {story.estimate ?? 0} pts</span>
                                </button>
                            ))}
                        </div>
                    </section>

                    <section style={s.taskboard} aria-label="Local taskboard">
                        <div style={s.sectionHeader}>
                            <div>
                                <h2 style={s.sectionTitle}>Taskboard</h2>
                                <p style={s.storyName}>{selectedStory ? `${selectedStory.number} - ${selectedStory.name}` : 'No local story selected'}</p>
                            </div>
                            <div style={s.actions}>
                                {selectedStory && <button style={s.secondaryBtn} onClick={() => setShowCreateTask(true)}>+ Task</button>}
                                {selectedStory && <button style={s.primaryBtn} onClick={() => setAssigningStory(selectedStory)}>Pick Up</button>}
                            </div>
                        </div>
                        {selectedStory ? (
                            <div style={taskColumnsStyle}>
                                {TASK_COLUMNS.map((column) => {
                                    const collapsed = collapsedTaskColumns.includes(column);
                                    const count = tasksByStatus.get(column)?.length ?? 0;
                                    return (
                                        <div
                                            key={column}
                                            style={collapsed ? s.columnCollapsed : s.column}
                                            onDragOver={(event) => event.preventDefault()}
                                            onDrop={(event) => handleTaskDrop(event, column)}
                                        >
                                            {collapsed ? (
                                                <button type="button" style={s.collapsedRail} onClick={() => toggleTaskColumn(column)} title={`${column} (${count})`}>
                                                    <span style={s.collapsedRailText}>{column}</span>
                                                    <span style={s.collapsedRailCount}>{count}</span>
                                                </button>
                                            ) : (
                                                <div style={s.columnHeader}>
                                                    <span>{column}</span>
                                                    <button type="button" style={s.columnToggle} onClick={() => toggleTaskColumn(column)} aria-label={`Collapse ${column}`}>‹ {count}</button>
                                                </div>
                                            )}
                                            {!collapsed && (tasksByStatus.get(column) ?? []).map((task) => (
                                                <div
                                                    key={task.number}
                                                    style={s.taskCard}
                                                    draggable
                                                    onDragStart={(event) => event.dataTransfer.setData('application/json', JSON.stringify({ type: 'task', number: task.number }))}
                                                >
                                                    <span style={s.cardNumber}>{task.number}</span>
                                                    <strong style={s.cardTitle}>{task.name}</strong>
                                                    <span style={s.cardMeta}>{task.category || 'None'} · {task.estimate}h</span>
                                                </div>
                                            ))}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div style={s.empty}>Create a local story to start dogfooding SDLC Framework here.</div>
                        )}
                    </section>
                </main>
            )}

            {activeTab === 'List View' && (
                <main style={s.singlePane}>
                    <section aria-label="Local story list">
                        <div style={s.sectionHeader}>
                            <h2 style={s.sectionTitle}>List View</h2>
                            <span style={s.count}>{openStories.length} stories</span>
                        </div>
                        <StoryList
                            stories={openStories}
                            selectedStoryNumber={selectedStory?.number ?? ''}
                            onSelect={(story) => { void openStoryDetail(story); }}
                            onPickUp={setAssigningStory}
                        />
                    </section>
                </main>
            )}

            {activeTab === 'Closed' && (
                <main style={s.singlePane}>
                    <section aria-label="Closed local stories">
                        <div style={s.sectionHeader}>
                            <h2 style={s.sectionTitle}>Closed</h2>
                            <span style={s.count}>{closedStories.length} stories</span>
                        </div>
                        <StoryList
                            stories={closedStories}
                            selectedStoryNumber={selectedStory?.number ?? ''}
                            onSelect={(story) => { void openStoryDetail(story); }}
                            onPickUp={setAssigningStory}
                            emptyText="No closed local stories yet."
                        />
                    </section>
                </main>
            )}

            {showCreateStory && (
                <Dialog title="Create Local Story" onClose={() => setShowCreateStory(false)}>
                    <FormGrid>
                        <input style={s.input} placeholder="Story name" value={storyForm.name} onChange={(e) => setStoryForm({ ...storyForm, name: e.target.value })} />
                        <input style={s.input} placeholder="Estimate" value={storyForm.estimate} onChange={(e) => setStoryForm({ ...storyForm, estimate: e.target.value })} />
                        <select style={s.input} value={storyForm.team} onChange={(e) => setStoryForm({ ...storyForm, team: e.target.value })}>
                            {board.teams.map((team) => <option key={team.id} value={team.name}>{team.name}</option>)}
                        </select>
                        <select style={s.input} value={storyForm.classOfService} onChange={(e) => setStoryForm({ ...storyForm, classOfService: e.target.value })}>
                            {board.classOfService.map((cos) => <option key={cos.id} value={cos.name}>{cos.name}</option>)}
                        </select>
                        <textarea style={s.textarea} placeholder="Description" value={storyForm.description} onChange={(e) => setStoryForm({ ...storyForm, description: e.target.value })} />
                        <textarea style={s.textarea} placeholder="Acceptance criteria" value={storyForm.acceptanceCriteria} onChange={(e) => setStoryForm({ ...storyForm, acceptanceCriteria: e.target.value })} />
                        <textarea style={s.textarea} placeholder="Frontend notes" value={storyForm.frontend} onChange={(e) => setStoryForm({ ...storyForm, frontend: e.target.value })} />
                        <textarea style={s.textarea} placeholder="Backend notes" value={storyForm.backend} onChange={(e) => setStoryForm({ ...storyForm, backend: e.target.value })} />
                        <textarea style={s.textarea} placeholder="QA notes" value={storyForm.qa} onChange={(e) => setStoryForm({ ...storyForm, qa: e.target.value })} />
                    </FormGrid>
                    <div style={s.dialogActions}>
                        <button style={s.secondaryBtn} onClick={() => setShowCreateStory(false)}>Cancel</button>
                        <button style={s.secondaryBtn} onClick={() => { void createAiStory(); }} disabled={aiCreating}>
                            {aiCreating ? 'Enriching...' : 'AI Create'}
                        </button>
                        <button style={s.primaryBtn} onClick={() => { void createStory(); }}>Create</button>
                    </div>
                </Dialog>
            )}

            {editingStory && (
                <Dialog title={`${editingStory.number} Story Details`} onClose={() => setEditingStory(null)}>
                    <div style={s.detailHero}>
                        <div style={s.detailHeroRow}>
                            <span style={s.cardNumber}>{editingStory.number}</span>
                            <span style={s.cosPill} title="Class of Service">{editingStory.classOfService || 'Standard'}</span>
                            <span style={s.statusPill}>{editingStory.status}</span>
                            <OwnerBadge owner={editingStory.owner} />
                            {editingStory.estimate != null && <span style={s.estPill}>{editingStory.estimate} pts</span>}
                        </div>
                        <strong style={s.detailTitle}>{editingStory.name}</strong>
                    </div>

                    {(editingStory.description || editingStory.acceptanceCriteria || editingStory.frontend || editingStory.backend || editingStory.qa) && (
                        <div style={s.previewWrap}>
                            <RichSection title="Description" html={editingStory.description} defaultOpen />
                            <RichSection title="Acceptance Criteria" html={editingStory.acceptanceCriteria} />
                            <RichSection title="Frontend" html={editingStory.frontend} />
                            <RichSection title="Backend" html={editingStory.backend} />
                            <RichSection title="QA" html={editingStory.qa} />
                        </div>
                    )}

                    <div style={s.editHeading}>Edit fields</div>
                    <FormGrid>
                        <input style={s.input} placeholder="Story name" value={storyEditForm.name} onChange={(e) => setStoryEditForm({ ...storyEditForm, name: e.target.value })} />
                        <input style={s.input} placeholder="Estimate" value={storyEditForm.estimate} onChange={(e) => setStoryEditForm({ ...storyEditForm, estimate: e.target.value })} />
                        <select style={s.input} value={storyEditForm.status} onChange={(e) => setStoryEditForm({ ...storyEditForm, status: e.target.value })}>
                            {STATUS_EDIT_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
                        </select>
                        <select style={s.input} value={storyEditForm.team} onChange={(e) => setStoryEditForm({ ...storyEditForm, team: e.target.value })}>
                            {board.teams.map((team) => <option key={team.id} value={team.name}>{team.name}</option>)}
                        </select>
                        <select style={s.input} value={storyEditForm.classOfService} onChange={(e) => setStoryEditForm({ ...storyEditForm, classOfService: e.target.value })}>
                            {board.classOfService.map((cos) => <option key={cos.id} value={cos.name}>{cos.name}</option>)}
                        </select>
                        <input style={s.input} placeholder="Priority" value={storyEditForm.priority} onChange={(e) => setStoryEditForm({ ...storyEditForm, priority: e.target.value })} />
                        <textarea style={s.textareaTall} placeholder="Description" value={storyEditForm.description} onChange={(e) => setStoryEditForm({ ...storyEditForm, description: e.target.value })} />
                        <textarea style={s.textarea} placeholder="Acceptance criteria" value={storyEditForm.acceptanceCriteria} onChange={(e) => setStoryEditForm({ ...storyEditForm, acceptanceCriteria: e.target.value })} />
                        <textarea style={s.textarea} placeholder="Frontend notes" value={storyEditForm.frontend} onChange={(e) => setStoryEditForm({ ...storyEditForm, frontend: e.target.value })} />
                        <textarea style={s.textarea} placeholder="Backend notes" value={storyEditForm.backend} onChange={(e) => setStoryEditForm({ ...storyEditForm, backend: e.target.value })} />
                        <textarea style={s.textarea} placeholder="QA notes" value={storyEditForm.qa} onChange={(e) => setStoryEditForm({ ...storyEditForm, qa: e.target.value })} />
                    </FormGrid>
                    <div style={s.dialogActions}>
                        <button style={s.dangerBtn} onClick={() => { setConfirmingDelete(editingStory); }}>Delete</button>
                        <button style={s.warnBtn} onClick={() => { void closeStory(editingStory); }}>Close</button>
                        <span style={{ flex: 1 }} />
                        <button style={s.secondaryBtn} onClick={() => setEditingStory(null)}>Cancel</button>
                        <button style={s.secondaryBtn} onClick={() => { setAssigningStory(editingStory); setEditingStory(null); }}>Pick Up</button>
                        <button style={s.primaryBtn} onClick={() => { void saveStoryDetail(); }} disabled={savingStory}>{savingStory ? 'Saving...' : 'Save'}</button>
                    </div>
                </Dialog>
            )}

            {showCreateTask && selectedStory && (
                <Dialog title={`Create Task for ${selectedStory.number}`} onClose={() => setShowCreateTask(false)}>
                    <FormGrid>
                        <input style={s.input} placeholder="Task name" value={taskForm.name} onChange={(e) => setTaskForm({ ...taskForm, name: e.target.value })} />
                        <input style={s.input} placeholder="Estimate hours" value={taskForm.estimate} onChange={(e) => setTaskForm({ ...taskForm, estimate: e.target.value })} />
                        <select style={s.input} value={taskForm.agentId} onChange={(e) => {
                            const agentId = e.target.value;
                            setTaskForm({ ...taskForm, agentId, category: AGENT_CATEGORY[agentId] ?? 'Frontend' });
                        }}>
                            {ASSIGNABLE_AGENTS.map((agent) => (
                                <option key={agent.id} value={agent.id}>{agent.name} ({AGENT_CATEGORY[agent.id] ?? agent.role})</option>
                            ))}
                        </select>
                    </FormGrid>
                    <div style={s.dialogActions}>
                        <button style={s.secondaryBtn} onClick={() => setShowCreateTask(false)}>Cancel</button>
                        <button style={s.primaryBtn} onClick={() => { void createTask(); }}>Create</button>
                    </div>
                </Dialog>
            )}

            {assigningStory && (
                <Dialog title={`Pick Up ${assigningStory.number}`} onClose={() => setAssigningStory(null)}>
                    <select style={s.input} value={assignAgentId} onChange={(e) => setAssignAgentId(e.target.value)}>
                        {AGENT_ROSTER.filter((agent) => agent.active && agent.id !== 'reviewer').map((agent) => (
                            <option key={agent.id} value={agent.id}>{agent.name} ({agent.role})</option>
                        ))}
                    </select>
                    <div style={s.dialogActions}>
                        <button style={s.secondaryBtn} onClick={() => setAssigningStory(null)}>Cancel</button>
                        <button style={s.primaryBtn} onClick={() => { void assignStory(); }}>Assign</button>
                    </div>
                </Dialog>
            )}

            {confirmingDelete && (
                <Dialog title={`Delete ${confirmingDelete.number}?`} onClose={() => setConfirmingDelete(null)}>
                    <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: 13 }}>
                        <strong>{confirmingDelete.name}</strong> will be removed from all views.
                        This cannot be undone from the UI.
                    </p>
                    <div style={s.dialogActions}>
                        <button style={s.secondaryBtn} onClick={() => setConfirmingDelete(null)}>Cancel</button>
                        <button style={s.dangerBtn} onClick={() => { void deleteStory(confirmingDelete); }}>Delete</button>
                    </div>
                </Dialog>
            )}
        </div>
    );
}

function Metric({ label, value, sub }: { label: string; value: number; sub?: string }) {
    return (
        <div style={s.metric}>
            <div style={s.metricValue}>{value}{sub && <span style={s.metricSub}>{sub}</span>}</div>
            <div style={s.metricLabel}>{label}</div>
        </div>
    );
}

function Storyboard({
    columns,
    storiesByStatus,
    collapsed,
    onToggle,
    onDrop,
    onOpen,
    onCloseStory,
    onDeleteStory,
    activeNumber,
    columnsStyle,
    inProgressCount,
}: {
    columns: string[];
    storiesByStatus: Map<string, LocalStory[]>;
    collapsed: string[];
    onToggle: (column: string) => void;
    onDrop: (event: DragEvent, status: string) => void;
    onOpen: (story: LocalStory) => void;
    onCloseStory: (story: LocalStory) => void;
    onDeleteStory: (story: LocalStory) => void;
    activeNumber: string;
    columnsStyle: CSSProperties;
    inProgressCount: number;
}) {
    const wipExceeded = inProgressCount > WIP_LIMIT;
    return (
        <div style={s.boardScroll}>
            <div style={{ ...columnsStyle, marginBottom: 6 }}>
                <div style={{ ...s.wipGroup, gridColumn: `1 / span ${IN_PROGRESS_STATUSES.length}`, ...(wipExceeded ? s.wipGroupExceeded : null) }}>
                    In Progress
                    <span style={s.wipNumber}>{inProgressCount} / {WIP_LIMIT}</span>
                </div>
            </div>
            <div style={columnsStyle}>
                {columns.map((column) => {
                    const isCollapsed = collapsed.includes(column);
                    const cards = storiesByStatus.get(column) ?? [];
                    return (
                        <div
                            key={column}
                            style={isCollapsed ? s.columnCollapsed : s.column}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => onDrop(event, column)}
                        >
                            {isCollapsed ? (
                                <button type="button" style={s.collapsedRail} onClick={() => onToggle(column)} title={`${column} (${cards.length})`}>
                                    <span style={s.collapsedRailText}>{column}</span>
                                    <span style={s.collapsedRailCount}>{cards.length}</span>
                                </button>
                            ) : (
                                <>
                                    <div style={s.columnHeader}>
                                        <span style={s.columnTitle}>{column}</span>
                                        <span style={s.columnCount}>{cards.length}</span>
                                        <button type="button" style={s.columnToggle} onClick={() => onToggle(column)} aria-label={`Collapse ${column}`}>‹</button>
                                    </div>
                                    {cards.map((story) => (
                                        <StoryCard
                                            key={story.number}
                                            story={story}
                                            active={story.number === activeNumber}
                                            onClick={() => onOpen(story)}
                                            onClose={onCloseStory}
                                            onDelete={onDeleteStory}
                                        />
                                    ))}
                                </>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function OwnerBadge({ owner }: { owner?: string }) {
    if (!owner) return null;
    const agent = AGENT_ROSTER.find(a => a.name.toLowerCase() === owner.toLowerCase() || a.id === owner.toLowerCase());
    const color = agent?.accentColor ?? 'var(--text-tertiary)';
    const label = agent?.name ?? owner;
    return (
        <span style={{
            display: 'inline-block', padding: '1px 6px', fontSize: 10, fontWeight: 600,
            borderRadius: 3, background: `${color}22`, color, border: `1px solid ${color}44`,
            marginLeft: 4, verticalAlign: 'middle',
        }} title={`Assigned to ${label}`}>{label}</span>
    );
}

function StoryCard({ story, active, onClick, onClose, onDelete }: {
    story: LocalStory; active: boolean; onClick: () => void;
    onClose?: (story: LocalStory) => void; onDelete?: (story: LocalStory) => void;
}) {
    const color = cosColor(story.classOfService);
    const closed = isClosedStatus(story.status);
    const [menuOpen, setMenuOpen] = useState(false);
    return (
        <div
            className="lbv-card"
            style={{ ...(active ? s.storyCardActive : s.storyCard), borderLeft: `4px solid ${color}`, ...(closed ? { opacity: 0.6 } : {}) }}
            onClick={onClick}
            draggable
            onDragStart={(event) => event.dataTransfer.setData('application/json', JSON.stringify({ type: 'story', number: story.number }))}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
        >
            <div style={s.cardIdentity}>
                <span style={s.cardIcon} aria-hidden="true">▤</span>
                <span style={s.cardNumberLink}>{story.number}</span>
                <span style={{ ...s.cosDot, background: color }} title={story.classOfService || 'Standard'} />
                <OwnerBadge owner={story.owner} />
                {(onClose || onDelete) && (
                    <span style={{ position: 'relative' as const, marginLeft: 'auto' }}>
                        <button
                            type="button"
                            style={s.cardMenuBtn}
                            onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
                            onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
                            aria-label="Story actions"
                        >...</button>
                        {menuOpen && (
                            <div style={s.cardMenu}>
                                {onClose && !closed && (
                                    <button type="button" style={s.cardMenuItem} onMouseDown={(e) => { e.preventDefault(); setMenuOpen(false); onClose(story); }}>Close</button>
                                )}
                                {onDelete && (
                                    <button type="button" style={{ ...s.cardMenuItem, color: '#ef4444' }} onMouseDown={(e) => { e.preventDefault(); setMenuOpen(false); onDelete(story); }}>Delete</button>
                                )}
                            </div>
                        )}
                    </span>
                )}
            </div>
            <strong style={{ ...s.cardTitle, ...(closed ? { textDecoration: 'line-through' } : {}) }}>{story.name}</strong>
            <div style={{ ...s.cardStatus, ...(closed ? { textDecoration: 'line-through' } : {}) }}>{story.status}</div>
            <div style={s.cardBottom}>
                <span style={s.cardOwner}>{story.team}</span>
                <span style={s.cardTodo}>{story.estimate ?? 0} pts</span>
            </div>
            {story.priority && <div style={s.cardTab}>{story.priority}</div>}
        </div>
    );
}

function StoryList({
    stories,
    selectedStoryNumber,
    onSelect,
    onPickUp,
    emptyText = 'No open local stories. Create one here when SDLC Framework work should stay local.',
}: {
    stories: LocalStory[];
    selectedStoryNumber: string;
    onSelect: (story: LocalStory) => void;
    onPickUp: (story: LocalStory) => void;
    emptyText?: string;
}) {
    if (stories.length === 0) return <div style={s.empty}>{emptyText}</div>;
    return (
        <div style={s.list} role="list">
            {stories.map((story) => (
                <button
                    key={story.number}
                    type="button"
                    style={story.number === selectedStoryNumber ? s.listRowActive : s.listRow}
                    onClick={() => onSelect(story)}
                    role="listitem"
                >
                    <span style={s.listNumber}>{story.number}</span>
                    <strong style={s.listTitle}>{story.name}</strong>
                    <span style={s.listMeta}>{story.status}</span>
                    <span style={s.listMeta}>{story.team}</span>
                    <span style={s.listMeta}>{story.estimate ?? 0} pts</span>
                    <span style={s.listMeta}>{story.classOfService}</span>
                    <span
                        style={s.listAction}
                        onClick={(event) => {
                            event.stopPropagation();
                            onPickUp(story);
                        }}
                    >
                        Pick Up
                    </span>
                </button>
            ))}
        </div>
    );
}

function RichSection({ title, html, defaultOpen = false }: { title: string; html: string; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);
    if (!html || !html.trim()) return null;
    return (
        <div style={s.accordion}>
            <button type="button" style={s.accordionHeader} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                <span style={s.accordionChevron}>{open ? '▾' : '▸'}</span>
                <span>{title}</span>
            </button>
            {open && (
                <div className="lbv-rich-html" style={s.accordionBody} dangerouslySetInnerHTML={{ __html: html }} />
            )}
        </div>
    );
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
    return (
        <div style={s.overlay} onClick={onClose}>
            <div style={s.dialog} onClick={(e) => e.stopPropagation()}>
                <div style={s.dialogHeader}>
                    <h2 style={s.dialogTitle}>{title}</h2>
                    <button style={s.iconBtn} onClick={onClose} aria-label="Close">&times;</button>
                </div>
                {children}
            </div>
        </div>
    );
}

function FormGrid({ children }: { children: ReactNode }) {
    return <div style={s.formGrid}>{children}</div>;
}

const lbvCss = `
.lbv-card{transition:transform .08s ease, box-shadow .08s ease;}
.lbv-card:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,0.22);}
.lbv-rich-html h1,.lbv-rich-html h2,.lbv-rich-html h3,.lbv-rich-html h4{font-size:13px;font-weight:700;margin:8px 0 4px;color:var(--text-primary);}
.lbv-rich-html h2{font-size:14px;}
.lbv-rich-html p{margin:4px 0;line-height:1.55;}
.lbv-rich-html ul,.lbv-rich-html ol{margin:4px 0 4px 18px;padding:0;}
.lbv-rich-html li{margin:2px 0;line-height:1.5;}
.lbv-rich-html code{font-family:var(--font-mono,'SF Mono',Consolas,monospace);font-size:12px;padding:1px 5px;border-radius:3px;background:var(--bg-secondary);color:var(--accent);}
.lbv-rich-html a{color:var(--accent);text-decoration:underline;}
.lbv-rich-html strong,.lbv-rich-html b{font-weight:600;color:var(--text-primary);}
`;

const s: Record<string, CSSProperties> = {
    page: { minHeight: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)', padding: 16 },
    topbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '10px 0 14px', borderBottom: '4px solid #20c997', flexWrap: 'wrap' },
    brandCluster: { display: 'flex', alignItems: 'center', gap: 12 },
    backBtn: { width: 40, height: 40, border: 0, borderRadius: 8, background: 'var(--accent)', color: '#fff', fontSize: 22, cursor: 'pointer' },
    mascot: { width: 38, height: 38, borderRadius: '50%', background: '#20c997', color: '#04201a', display: 'grid', placeItems: 'center', fontWeight: 900, fontSize: 18 },
    kicker: { fontFamily: 'var(--font-mono)', color: '#20c997', fontWeight: 800, textTransform: 'uppercase', fontSize: 11 },
    title: { margin: 0, fontSize: 24 },
    localBadge: { border: '1px solid #20c997', color: '#20c997', borderRadius: 6, padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 800 },
    metrics: { display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' },
    metric: { textAlign: 'center', minWidth: 64 },
    metricValue: { fontSize: 22, fontWeight: 800, lineHeight: 1 },
    metricSub: { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginLeft: 4 },
    metricLabel: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.04em' },
    actions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    primaryBtn: { border: 0, borderRadius: 7, background: '#0d9488', color: '#fff', padding: '9px 14px', fontWeight: 800, cursor: 'pointer' },
    secondaryBtn: { border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-card)', color: 'var(--text-primary)', padding: '8px 13px', fontWeight: 700, cursor: 'pointer' },
    dragHandle: { cursor: 'grab', color: 'var(--text-secondary)', fontSize: 12, userSelect: 'none' as const, opacity: 0.5 },
    cardMenuBtn: { border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontWeight: 900, fontSize: 14, padding: '0 4px', lineHeight: 1, borderRadius: 4 },
    cardMenu: { position: 'absolute' as const, right: 0, top: '100%', zIndex: 100, minWidth: 100, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.25)', padding: 4 },
    cardMenuItem: { display: 'block', width: '100%', border: 0, background: 'transparent', color: 'var(--text-primary)', padding: '6px 10px', fontSize: 12, fontWeight: 600, textAlign: 'left' as const, borderRadius: 4, cursor: 'pointer' },
    dangerBtn: { border: 0, borderRadius: 7, background: '#dc2626', color: '#fff', padding: '9px 14px', fontWeight: 800, cursor: 'pointer' },
    warnBtn: { border: '1px solid #f59e0b', borderRadius: 7, background: 'rgba(245,158,11,0.12)', color: '#f59e0b', padding: '8px 13px', fontWeight: 700, cursor: 'pointer' },
    personaStrip: { display: 'flex', gap: 16, padding: '12px 2px', overflowX: 'auto', borderBottom: '1px solid var(--border)' },
    persona: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 48 },
    avatar: { width: 36, height: 36, borderRadius: '50%', background: 'var(--bg-card)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13 },
    personaName: { fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' },
    tabs: { display: 'flex', gap: 4, padding: '12px 0', overflowX: 'auto', borderBottom: '1px solid var(--border)', marginBottom: 6 },
    tab: { padding: '7px 16px', border: 0, borderBottom: '3px solid transparent', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 700, cursor: 'pointer' },
    activeTab: { padding: '7px 16px', border: 0, borderBottom: '3px solid #20c997', background: 'transparent', color: 'var(--text-primary)', fontWeight: 900, cursor: 'pointer' },
    error: { margin: '10px 0', padding: 12, border: '1px solid #ef4444', borderRadius: 8, background: 'rgba(239, 68, 68, 0.08)', color: '#ef4444' },
    notice: { margin: '10px 0', padding: 12, border: '1px solid #14b8a6', borderRadius: 8, background: 'rgba(20, 184, 166, 0.10)', color: '#0f766e' },
    loading: { padding: 16, color: 'var(--text-secondary)' },
    main: { display: 'grid', gridTemplateColumns: 'minmax(280px, 0.7fr) minmax(440px, 1.3fr)', gap: 18, alignItems: 'start' },
    singlePane: { display: 'block' },
    storyboard: { minWidth: 0 },
    taskboard: { minWidth: 0 },
    backlogPanel: { minWidth: 0, maxWidth: 720 },
    sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '12px 0' },
    sectionTitle: { margin: 0, fontSize: 20 },
    storyName: { margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: 13 },
    count: { fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontSize: 13 },
    boardScroll: { overflowX: 'auto', paddingBottom: 8 },
    wipGroup: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderBottom: 0, borderRadius: '8px 8px 0 0', padding: '8px 12px', fontWeight: 900, display: 'flex', alignItems: 'center', gap: 8 },
    wipGroupExceeded: { color: '#ef4444', borderColor: '#ef4444' },
    wipNumber: { fontFamily: 'var(--font-mono)', fontWeight: 800, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '1px 8px', fontSize: 12 },
    column: { minHeight: 220, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 8 },
    columnCollapsed: { minHeight: 240, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 4, overflow: 'hidden' },
    columnHeader: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid var(--border)' },
    columnTitle: { fontWeight: 800, fontSize: 13, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    columnCount: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 10, padding: '0 7px' },
    columnToggle: { border: 0, background: 'transparent', color: 'var(--text-secondary)', fontWeight: 900, cursor: 'pointer', padding: '0 4px', fontSize: 14 },
    collapsedRail: { width: '100%', height: '100%', minHeight: 232, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: 0, borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', padding: '8px 0' },
    collapsedRailText: { writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontWeight: 900, whiteSpace: 'nowrap', fontSize: 12 },
    collapsedRailCount: { display: 'grid', placeItems: 'center', width: 26, height: 22, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontWeight: 900 },
    storyCard: { width: '100%', textAlign: 'left', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 9px', marginBottom: 8, background: 'var(--bg-primary)', color: 'var(--text-primary)', cursor: 'pointer' },
    storyCardActive: { width: '100%', textAlign: 'left', border: '1px solid var(--accent)', boxShadow: '0 0 0 1px var(--accent)', borderRadius: 6, padding: '8px 9px', marginBottom: 8, background: 'var(--bg-card-hover)', color: 'var(--text-primary)', cursor: 'pointer' },
    cardIdentity: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
    cardIcon: { color: 'var(--text-secondary)', fontSize: 12 },
    cardNumberLink: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 800, color: 'var(--accent)', flex: 1 },
    cosDot: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block' },
    cardStatus: { marginTop: 6, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.03em' },
    cardBottom: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' },
    cardOwner: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    cardTodo: { fontFamily: 'var(--font-mono)', fontWeight: 700 },
    cardTab: { marginTop: 8, marginLeft: -9, marginRight: -9, marginBottom: -8, padding: '4px 9px', borderTop: '1px solid var(--border)', background: 'var(--bg-card)', fontSize: 11, color: 'var(--text-secondary)', borderRadius: '0 0 6px 6px' },
    cardNumber: { display: 'block', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 },
    cardTitle: { display: 'block', fontSize: 13, lineHeight: 1.3, fontWeight: 700 },
    cardMeta: { display: 'block', marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' },
    taskboardStoryList: { display: 'grid', gap: 8, maxHeight: '70vh', overflowY: 'auto' },
    taskStoryRow: { width: '100%', textAlign: 'left', border: '1px solid var(--border)', borderLeft: '4px solid #14b8a6', borderRadius: 6, padding: 10, background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' },
    taskStoryRowActive: { width: '100%', textAlign: 'left', border: '1px solid var(--accent)', borderLeft: '4px solid var(--accent)', borderRadius: 6, padding: 10, background: 'var(--bg-card-hover)', color: 'var(--text-primary)', cursor: 'pointer' },
    taskCard: { border: '1px solid var(--border)', borderLeft: '4px solid #22c55e', borderRadius: 6, padding: 9, marginBottom: 8, background: 'var(--bg-primary)' },
    backlogList: { display: 'grid', gap: 4, border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--bg-card)' },
    weekSeparator: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 800, color: 'var(--text-secondary)', padding: '8px 6px 4px', borderBottom: '1px solid var(--border)' },
    backlogRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderRadius: 6, cursor: 'pointer', color: 'var(--text-primary)' },
    backlogRowActive: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderRadius: 6, cursor: 'pointer', background: 'var(--bg-card-hover)', color: 'var(--text-primary)' },
    workIcon: { color: '#20c997', fontSize: 14 },
    backlogName: { flex: 1, fontSize: 13 },
    backlogTeam: { fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' },
    list: { display: 'grid', gap: 8 },
    listRow: { width: '100%', display: 'grid', gridTemplateColumns: '120px minmax(240px, 1fr) repeat(4, minmax(90px, 120px)) 90px', alignItems: 'center', gap: 10, textAlign: 'left', border: '1px solid var(--border)', borderLeft: '4px solid #14b8a6', borderRadius: 6, padding: 10, background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' },
    listRowActive: { width: '100%', display: 'grid', gridTemplateColumns: '120px minmax(240px, 1fr) repeat(4, minmax(90px, 120px)) 90px', alignItems: 'center', gap: 10, textAlign: 'left', border: '1px solid var(--accent)', borderLeft: '4px solid var(--accent)', borderRadius: 6, padding: 10, background: 'var(--bg-card-hover)', color: 'var(--text-primary)', cursor: 'pointer' },
    listNumber: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' },
    listTitle: { fontSize: 14, lineHeight: 1.25 },
    listMeta: { fontSize: 12, color: 'var(--text-secondary)' },
    listAction: { justifySelf: 'end', border: '1px solid #0d9488', borderRadius: 6, color: '#0f766e', padding: '5px 8px', fontWeight: 800 },
    empty: { border: '1px dashed var(--border)', borderRadius: 8, padding: 24, color: 'var(--text-secondary)', background: 'var(--bg-card)' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 16, zIndex: 10000 },
    dialog: { width: 'min(760px, 100%)', maxHeight: '88vh', overflow: 'auto', background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.28)' },
    dialogHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 },
    dialogTitle: { margin: 0, fontSize: 20 },
    detailHero: { border: '1px solid var(--border)', borderLeft: '4px solid var(--accent)', borderRadius: 7, padding: 12, marginBottom: 12, background: 'var(--bg-card)' },
    detailHeroRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
    detailTitle: { display: 'block', fontSize: 18, lineHeight: 1.25 },
    cosPill: { fontSize: 10, padding: '2px 10px', borderRadius: 10, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)', fontWeight: 600 },
    statusPill: { fontSize: 10, padding: '2px 10px', borderRadius: 10, background: 'var(--accent-dim)', color: 'var(--text-secondary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
    estPill: { fontSize: 11, padding: '2px 10px', borderRadius: 10, background: 'var(--accent)', color: '#fff', fontWeight: 700 },
    previewWrap: { marginBottom: 14 },
    editHeading: { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', margin: '4px 0 10px' },
    accordion: { marginBottom: 8, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' },
    accordionHeader: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'var(--bg-card)', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)', fontSize: 13, fontWeight: 700 },
    accordionChevron: { fontSize: 12, color: 'var(--text-secondary)', width: 12, flexShrink: 0 },
    accordionBody: { padding: '10px 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, maxHeight: 260, overflowY: 'auto', borderTop: '1px solid var(--border)', background: 'var(--bg-primary)' },
    iconBtn: { border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-card)', color: 'var(--text-primary)', width: 36, height: 36, cursor: 'pointer' },
    formGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 },
    input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 12px', background: 'var(--bg-card)', color: 'var(--text-primary)' },
    textarea: { width: '100%', minHeight: 90, boxSizing: 'border-box', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 12px', background: 'var(--bg-card)', color: 'var(--text-primary)', gridColumn: '1 / -1' },
    textareaTall: { width: '100%', minHeight: 150, boxSizing: 'border-box', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 12px', background: 'var(--bg-card)', color: 'var(--text-primary)', gridColumn: '1 / -1' },
    dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
};
