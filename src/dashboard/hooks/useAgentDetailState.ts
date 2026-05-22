import { useState, useEffect, useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import type { AgentProfile, AgentStatus, RequestItem } from '../types';
import { isWrapUpDeskRequestId, wrapUpDeskRequestId } from '../types';
import { getDefaultStepModePhases, phaseAllowsContinueTaskScope } from '../../shared/agentPhases';
import {
    CONTEXT_ACTION_BAR_PHASES,
    isTaskTerminalStatus,
    pluralize,
    normalizeTaskStatus,
} from '../agent-detail-utils';

export interface UseAgentDetailStateResult {
    stepMode: boolean;
    globalStepMode: boolean;
    stepModePhases: string[];
    continuing: boolean;
    selectedTaskIds: Set<string>;
    selectedRequestIds: Set<string>;
    dismissedIds: Set<string>;
    assigningMore: boolean;
    setAssigningMore: Dispatch<SetStateAction<boolean>>;
    checkpointBanner: { tone: 'success' | 'error'; text: string } | null;
    setCheckpointBanner: Dispatch<SetStateAction<{ tone: 'success' | 'error'; text: string } | null>>;
    toggleStepMode: () => Promise<void>;
    handleContinue: (opts?: { phaseHint?: string }) => Promise<Record<string, unknown>>;
    effectiveStepMode: boolean;
    isPausedAtStep: boolean;
    stepPauseReady: boolean;
    taskSelectionAllowed: boolean;
    showContextualActionBar: boolean;
    contextualBarTasksAllComplete: boolean;
    assignMoreTasks: () => void;
    continueAutonomously: () => Promise<void>;
    toggleTask: (taskId: string) => void;
    selectableTasks: NonNullable<AgentStatus['tasks']>;
    devopsSyntheticWrapUpRequest: RequestItem | null;
    requestsForDesk: RequestItem[];
    openRequests: RequestItem[];
    selectedOpenRequests: RequestItem[];
    hasOpenRequests: boolean;
    hasSelectedRequests: boolean;
    showDevopsWrapUpRun: boolean;
    toggleRequest: (reqId: string) => void;
    totalSelected: number;
    selectedCountLabel: string;
    selectAll: () => void;
    deselectAll: () => void;
    dismissItem: (itemId: string, itemType: 'task' | 'request') => Promise<void>;
    resolveTaskReconciliation: (action: 'reuse' | 'recreate') => Promise<void>;
}

export function useAgentDetailState(agent: AgentProfile, status: AgentStatus): UseAgentDetailStateResult {
    const [stepMode, setStepMode] = useState(false);
    const [globalStepMode, setGlobalStepMode] = useState(false);
    const [stepModePhases, setStepModePhases] = useState<string[]>(() => [...getDefaultStepModePhases(agent.id)]);
    const [continuing, setContinuing] = useState(false);
    const phaseAtContinue = useRef<string | null>(null);
    const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
    const [selectedRequestIds, setSelectedRequestIds] = useState<Set<string>>(new Set());
    const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
    const [assigningMore, setAssigningMore] = useState(false);
    const [checkpointBanner, setCheckpointBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

    useEffect(() => {
        fetch(`${window.location.origin}/api/agent/step-mode/${agent.id}`)
            .then(r => r.json())
            .then(d => {
                setStepMode(!!d.stepMode);
                setGlobalStepMode(!!d.globalStepMode);
                setStepModePhases(Array.isArray(d.stepModePhases) ? d.stepModePhases : [...getDefaultStepModePhases(agent.id)]);
            })
            .catch(() => setStepModePhases([...getDefaultStepModePhases(agent.id)]));
    }, [agent.id]);

    useEffect(() => {
        if (!phaseAllowsContinueTaskScope(status.currentPhase)) setSelectedTaskIds(new Set());
    }, [status.currentPhase]);

    const toggleStepMode = useCallback(async () => {
        try {
            const res = await fetch(`${window.location.origin}/api/agent/step-mode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent.id, stepMode: !stepMode }),
            });
            if (res.ok) {
                const d = await res.json();
                setStepMode(!!d.stepMode);
                if (Array.isArray(d.stepModePhases)) setStepModePhases(d.stepModePhases);
            }
        } catch { /* silent */ }
    }, [agent.id, stepMode]);

    const handleContinue = useCallback(async (opts?: { phaseHint?: string }) => {
        setContinuing(true);
        phaseAtContinue.current = status.currentPhase;
        setAssigningMore(false);
        try {
            const payload: Record<string, unknown> = { agentId: agent.id };
            const taskScopeAllowed = phaseAllowsContinueTaskScope(status.currentPhase);
            if (taskScopeAllowed && selectedTaskIds.size > 0) payload.selectedTaskIds = [...selectedTaskIds];
            if (selectedRequestIds.size > 0) payload.selectedRequestIds = [...selectedRequestIds];
            if (opts?.phaseHint) payload.phaseHint = opts.phaseHint;
            const res = await fetch(`${window.location.origin}/api/agent/continue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const body = await res.json().catch(() => ({})) as { error?: string };
            if (!res.ok) {
                phaseAtContinue.current = null;
                throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
            }
            return body;
        } catch (e) {
            setContinuing(false);
            throw e;
        }
    }, [agent.id, status.currentPhase, selectedTaskIds, selectedRequestIds]);

    useEffect(() => {
        if (continuing && phaseAtContinue.current && status.currentPhase !== phaseAtContinue.current) {
            setContinuing(false);
            phaseAtContinue.current = null;
        }
    }, [continuing, status.currentPhase]);

    useEffect(() => {
        if (!continuing) return;
        const timer = setTimeout(() => {
            setContinuing(false);
            phaseAtContinue.current = null;
        }, 8000);
        return () => clearTimeout(timer);
    }, [continuing]);

    const effectiveStepMode = globalStepMode || stepMode;
    const isPausedAtStep = effectiveStepMode && stepModePhases.includes(status.currentPhase);
    const stepPauseReady = isPausedAtStep && (status.handoffDispatched === true || !status.isRunning);
    const taskSelectionAllowed = phaseAllowsContinueTaskScope(status.currentPhase);

    const showContextualActionBar = useMemo(() => {
        if (!effectiveStepMode || !isPausedAtStep) return false;
        if (stepPauseReady) return true;
        if (!status.isRunning) return true;
        if (assigningMore) return true;
        const latePipelinePhase = CONTEXT_ACTION_BAR_PHASES.has(status.currentPhase);
        const taskList = status.tasks ?? [];
        const allTasksInListTerminal = taskList.length > 0 && taskList.every(isTaskTerminalStatus);
        const allSelectedTasksTerminal = selectedTaskIds.size > 0 && [...selectedTaskIds].every((selId) => {
            const task = taskList.find((t) => {
                const tid = String(t.id ?? (t as { number?: string }).number ?? '');
                return tid === String(selId);
            });
            return task != null && isTaskTerminalStatus(task);
        });
        const tasksCompleteCondition = allTasksInListTerminal || allSelectedTasksTerminal;
        return tasksCompleteCondition || latePipelinePhase;
    }, [effectiveStepMode, isPausedAtStep, stepPauseReady, status.currentPhase, status.isRunning, status.tasks, selectedTaskIds, assigningMore]);

    useEffect(() => {
        if (!showContextualActionBar) setCheckpointBanner(null);
    }, [showContextualActionBar]);

    const contextualBarTasksAllComplete = useMemo(() => {
        const taskList = status.tasks ?? [];
        const allTasksInListTerminal = taskList.length > 0 && taskList.every(isTaskTerminalStatus);
        const allSelectedTasksTerminal = selectedTaskIds.size > 0 && [...selectedTaskIds].every((selId) => {
            const task = taskList.find((t) => {
                const tid = String(t.id ?? (t as { number?: string }).number ?? '');
                return tid === String(selId);
            });
            return task != null && isTaskTerminalStatus(task);
        });
        return allTasksInListTerminal || allSelectedTasksTerminal;
    }, [status.tasks, selectedTaskIds]);

    const assignMoreTasks = useCallback(() => {
        setAssigningMore(true);
        setSelectedTaskIds(new Set());
        setSelectedRequestIds(new Set());
    }, []);

    const continueAutonomously = useCallback(async () => {
        if (globalStepMode) return;
        setContinuing(true);
        try {
            const sm = await fetch(`${window.location.origin}/api/agent/step-mode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent.id, enabled: false }),
            });
            if (sm.ok) {
                const d = await sm.json();
                setStepMode(!!d.stepMode);
            }
            await fetch(`${window.location.origin}/api/agent/continue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent.id }),
            });
        } catch { /* silent */ }
        setTimeout(() => setContinuing(false), 3000);
    }, [agent.id, globalStepMode]);

    const toggleTask = useCallback((taskId: string) => {
        setSelectedTaskIds(prev => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
            return next;
        });
    }, []);

    const selectableTasks = useMemo(() => (status.tasks ?? []).filter(t => {
        const ns = normalizeTaskStatus(t.status);
        return ns !== 'completed' && ns !== 'failed' && ns !== 'in_progress';
    }), [status.tasks]);

    const devopsSyntheticWrapUpRequest = useMemo((): RequestItem | null => {
        if (agent.id !== 'devops') return null;
        if (status.currentPhase !== 'build-passed') return null;
        const prList = status.prs ?? [];
        const activePr = prList.find(p => p.status === 'active');
        if (!activePr) return null;
        const reqs = status.requests ?? [];
        const hasOpenWrap = reqs.some(
            (r) => isWrapUpDeskRequestId(r.id) && String(r.id).endsWith(`-PR-${activePr.id}`) && r.status !== 'resolved',
        );
        if (hasOpenWrap) return null;
        const id = wrapUpDeskRequestId(status.storyNumber ?? undefined, activePr.id);
        if (dismissedIds.has(id)) return null;
        const sn = status.storyNumber?.trim();
        return {
            id,
            type: 'build',
            source: 'sdlc-framework',
            summary: activePr.title
                ? `CI passed for PR #${activePr.id}: ${activePr.title} - complete story wrap-up.`
                : `CI passed for PR #${activePr.id}. Complete story wrap-up.`,
            status: 'open',
            prId: activePr.id,
            ...(sn ? { storyNumber: sn } : {}),
            createdAt: new Date().toISOString(),
        };
    }, [agent.id, status.currentPhase, status.storyNumber, status.requests, status.prs, dismissedIds]);

    const requestsForDesk = useMemo(() => {
        const base = [...(status.requests ?? [])];
        if (devopsSyntheticWrapUpRequest) base.push(devopsSyntheticWrapUpRequest);
        return base;
    }, [status.requests, devopsSyntheticWrapUpRequest]);

    const openRequests = useMemo(
        () => requestsForDesk.filter(r => r.status !== 'resolved'),
        [requestsForDesk],
    );

    useEffect(() => {
        const openIds = new Set(openRequests.map(r => r.id));
        setSelectedRequestIds(prev => {
            const next = new Set([...prev].filter(id => openIds.has(id)));
            return next.size === prev.size ? prev : next;
        });
    }, [openRequests]);

    const selectedOpenRequests = useMemo(
        () => openRequests.filter(r => selectedRequestIds.has(r.id)),
        [openRequests, selectedRequestIds],
    );
    const hasOpenRequests = openRequests.length > 0;
    const hasSelectedRequests = selectedOpenRequests.length > 0;
    const showDevopsWrapUpRun =
        agent.id === 'devops'
        && status.currentPhase === 'build-passed'
        && openRequests.some((r) => isWrapUpDeskRequestId(r.id));

    const toggleRequest = useCallback((reqId: string) => {
        setSelectedRequestIds(prev => {
            const next = new Set(prev);
            if (next.has(reqId)) next.delete(reqId); else next.add(reqId);
            return next;
        });
    }, []);

    const totalSelected = selectedTaskIds.size + selectedRequestIds.size;
    const selectedCountLabel = useMemo(() => {
        const parts: string[] = [];
        if (selectedTaskIds.size > 0) parts.push(pluralize(selectedTaskIds.size, 'task'));
        if (selectedRequestIds.size > 0) parts.push(pluralize(selectedRequestIds.size, 'request'));
        return parts.length > 0 ? `${parts.join(', ')} selected` : '';
    }, [selectedTaskIds, selectedRequestIds]);

    const selectAll = useCallback(() => {
        if (taskSelectionAllowed) {
            setSelectedTaskIds(new Set(selectableTasks.map(t => t.id ?? (t as { number?: string }).number ?? '')));
        }
        setSelectedRequestIds(new Set(openRequests.map(r => r.id)));
    }, [selectableTasks, openRequests, taskSelectionAllowed]);

    const deselectAll = useCallback(() => { setSelectedTaskIds(new Set()); setSelectedRequestIds(new Set()); }, []);

    const dismissItem = useCallback(async (itemId: string, itemType: 'task' | 'request') => {
        setDismissedIds(prev => new Set(prev).add(itemId));
        try {
            await fetch(`${window.location.origin}/api/agent/dismiss-item`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: agent.id, itemId, itemType }),
            });
        } catch { /* silent */ }
    }, [agent.id]);

    const resolveTaskReconciliation = useCallback(async (action: 'reuse' | 'recreate') => {
        const res = await fetch(`${window.location.origin}/api/agent/task-reconciliation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: agent.id, action }),
        });
        const body = await res.json().catch(() => ({})) as { error?: string };
        if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
        setCheckpointBanner({
            tone: 'success',
            text: action === 'reuse'
                ? 'Existing task list approved for reuse.'
                : 'Existing task list archived locally. Continue to recreate Phase 1 tasks.',
        });
    }, [agent.id]);

    return {
        stepMode,
        globalStepMode,
        stepModePhases,
        continuing,
        selectedTaskIds,
        selectedRequestIds,
        dismissedIds,
        assigningMore,
        checkpointBanner,
        setCheckpointBanner,
        toggleStepMode,
        handleContinue,
        effectiveStepMode,
        isPausedAtStep,
        stepPauseReady,
        taskSelectionAllowed,
        showContextualActionBar,
        contextualBarTasksAllComplete,
        assignMoreTasks,
        continueAutonomously,
        toggleTask,
        selectableTasks,
        devopsSyntheticWrapUpRequest,
        requestsForDesk,
        openRequests,
        selectedOpenRequests,
        hasOpenRequests,
        hasSelectedRequests,
        showDevopsWrapUpRun,
        toggleRequest,
        totalSelected,
        selectedCountLabel,
        selectAll,
        deselectAll,
        dismissItem,
        resolveTaskReconciliation,
        setAssigningMore,
    };
}
