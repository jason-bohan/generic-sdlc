import type { SdlcAgentId, SdlcPhaseId } from '../shared/sdlcContracts';
import { normalizeReviewerWorkCardPrs } from './reviewer-work-card';

export const SDLC_AGENT_IDS = new Set(['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops', 'orchestrator']);
export const SDLC_PHASE_IDS = new Set([
    'story-intake', 'pre-planning', 'reading-story', 'analyzing', 'generating-code',
    'validating', 'creating-pr', 'watching-reviews', 'addressing-feedback',
    'researching', 'designing', 'spec-ready', 'collaborating', 'reviewing',
    'commenting', 'approved', 'changes-requested', 'pending-build',
    'monitoring-build', 'build-passed', 'build-failed', 'running-cypress',
    'complete', 'error',
]);

const TASKS_DONE_PHASES = new Set([
    'complete',
]);

const DEVOPS_TASK_PREFIX_RE = /^(PR-BUILD-|WRAPUP-)/i;

export function asSdlcAgentId(agentId: string): SdlcAgentId | undefined {
    return SDLC_AGENT_IDS.has(agentId) ? agentId as SdlcAgentId : undefined;
}

export function asSdlcPhaseId(phase: string): SdlcPhaseId | undefined {
    return SDLC_PHASE_IDS.has(phase) ? phase as SdlcPhaseId : undefined;
}

export interface RawTask { id?: string; number?: string; name?: string; status?: string; [key: string]: unknown; }

/** Stable key for matching duplicate mock/local tasks (id and number are aliases from Agility). */
export function taskIdentityKey(t: RawTask): string {
    const raw = t.id ?? t.number;
    if (raw == null) return '';
    const s = String(raw).trim();
    return s;
}

/** First occurrence wins; keeps task order from the source list. */
export function dedupeTasksPreserveOrder(tasks: RawTask[]): RawTask[] {
    const seen = new Set<string>();
    const out: RawTask[] = [];
    for (const t of tasks) {
        const key = taskIdentityKey(t);
        if (!key) {
            out.push(t);
            continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
    }
    return out;
}

export function normalizeTasks(tasks: RawTask[]): RawTask[] {
    let counter = 0;
    const mapped = tasks.map(t => ({
        ...t,
        id: t.id ?? t.number ?? `task-${++counter}`,
        number: t.number ?? t.id,
        status: t.status === 'complete' ? 'completed' : (t.status ?? 'pending'),
    }));
    return dedupeTasksPreserveOrder(mapped);
}

function normalizeTokens(rawTokens: unknown) {
    const defaults = getDefaultStatus().tokens;
    if (!rawTokens || typeof rawTokens !== 'object') return defaults;
    const tokens = rawTokens as Record<string, { input?: unknown; output?: unknown }>;
    return {
        cloud: {
            input: typeof tokens.cloud?.input === 'number' ? tokens.cloud.input : 0,
            output: typeof tokens.cloud?.output === 'number' ? tokens.cloud.output : 0,
        },
        meshllm: {
            input: typeof tokens.meshllm?.input === 'number' ? tokens.meshllm.input : 0,
            output: typeof tokens.meshllm?.output === 'number' ? tokens.meshllm.output : 0,
        },
        ollama: {
            input: typeof tokens.ollama?.input === 'number' ? tokens.ollama.input : 0,
            output: typeof tokens.ollama?.output === 'number' ? tokens.ollama.output : 0,
        },
        mlx: {
            input: typeof tokens.mlx?.input === 'number' ? tokens.mlx.input : 0,
            output: typeof tokens.mlx?.output === 'number' ? tokens.mlx.output : 0,
        },
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeStatus(raw: Record<string, any>, agentId: string, rootDir: string) {
    const defaults = getDefaultStatus(agentId);
    const assignedPRs = raw.assignedPR ? [{ id: raw.assignedPR.id, title: raw.assignedPR.title, status: 'active', url: raw.assignedPR.url }] : [];
    if (raw.storyNumber !== undefined || raw.tasks !== undefined) {
        let mergedPrs: Array<{ id: number; title: string; status: string; comments?: number; approvals?: number; url?: string }>;
        let tasks = normalizeTasks(raw.tasks ?? []);
        if (agentId === 'reviewer') {
            mergedPrs = normalizeReviewerWorkCardPrs(raw);
            if (!raw.assignedPR && ['idle', 'complete', 'approved'].includes(String(raw.currentPhase ?? 'idle'))) {
                tasks = tasks.map((t) => {
                    const tid = String(t.id ?? t.number ?? '');
                    const st = String(t.status ?? '');
                    if (tid.startsWith('PR-REVIEW-') && st !== 'completed' && st !== 'failed') {
                        return { ...t, status: 'completed' as const };
                    }
                    return t;
                });
            }
        } else {
            mergedPrs = (raw.prs && raw.prs.length > 0) ? raw.prs : assignedPRs;
            if (agentId === 'devops' && raw.storyNumber == null) {
                tasks = tasks.filter(t => {
                    const tid = String(t.id ?? t.number ?? '');
                    if (DEVOPS_TASK_PREFIX_RE.test(tid)) return true;
                    const cat = String(t.category ?? '').toLowerCase();
                    return cat === 'devops' || cat === 'build';
                });
            }
            const phase = String(raw.currentPhase ?? 'idle');
            if (TASKS_DONE_PHASES.has(phase)) {
                tasks = tasks.map(t => {
                    const st = String(t.status ?? '');
                    if (st !== 'completed' && st !== 'failed') {
                        return { ...t, status: 'completed' as const };
                    }
                    return t;
                });
            }
        }
        return { ...defaults, ...raw, tokens: normalizeTokens(raw.tokens), tasks, prs: mergedPrs, cypress: raw.cypress ?? defaults.cypress, events: raw.events ?? [], requests: raw.requests ?? [], storyNumber: raw.storyNumber ?? raw.assignedPR?.storyNumber ?? null, sessionId: raw.sessionId ?? raw.activeSessionId ?? null, activeSessionId: raw.activeSessionId ?? raw.sessionId ?? null };
    }
    const prs = agentId === 'reviewer' ? normalizeReviewerWorkCardPrs(raw) : assignedPRs;
    const extra: Record<string, unknown> = {};
    if (raw.buildId !== undefined) extra.buildId = raw.buildId;
    if (raw.pipelineId !== undefined) extra.pipelineId = raw.pipelineId;
    return { ...defaults, storyNumber: raw.assignedPR?.storyNumber || null, storyName: raw.assignedPR?.title || null, currentPhase: raw.currentPhase ?? 'idle', startedAt: raw.requestedAt ?? null, prs, events: raw.events ?? [], requests: raw.requests ?? [], sessionId: raw.sessionId ?? raw.activeSessionId ?? null, activeSessionId: raw.activeSessionId ?? raw.sessionId ?? null, ...extra };
}

export function getDefaultStatus(agentId = 'frontend') {
    const name = agentId.charAt(0).toUpperCase() + agentId.slice(1);
    return {
        storyNumber: null, storyName: null, storyDescription: null, currentPhase: 'idle', currentTask: null, startedAt: null,
        tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 }, mlx: { input: 0, output: 0 } },
        tasks: [], prs: [], requests: [],
        sessionId: null, activeSessionId: null,
        cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        events: [{ timestamp: new Date().toISOString(), type: 'info', message: `${name} is idle. Assign a story to begin.` }],
    };
}
