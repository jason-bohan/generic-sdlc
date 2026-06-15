import {
    existsSync,
    readFileSync,
    writeFileSync,
} from 'fs';
import { resolve } from 'path';
import { parseJsonUtf8File } from '../json-file';
import { normalizeReviewerVerdict, reviewerPhaseForVerdict } from '../reviewer-verdict';
import { emitStatusChange } from '../status-events';
import { buildStatusBroadcast } from '../status-broadcast';
import { DEVOPS_BUILD_CHAIN } from './commit-pr';

export function toolUpdateStatus(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
): string {
    const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
    try {
        const existing = existsSync(statusFile)
            ? parseJsonUtf8File(statusFile) as Record<string, unknown>
            : {};

        const existingPhase = String(existing.currentPhase ?? '');
        if (agentId === 'devops' && DEVOPS_BUILD_CHAIN.has(existingPhase)
            && args.phase !== undefined && String(args.phase) !== existingPhase) {
            return `Refused: devops cannot change phase via update_status inside the build chain (currently "${existingPhase}"). The build chain advances automatically when you call complete_phase — call complete_phase to move forward. Do not set the phase by hand.`;
        }

        const updated: Record<string, unknown> = {
            ...existing,
            currentPhase: args.phase,
            updatedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
        };
        if (args.storyNumber !== undefined) updated.storyNumber = args.storyNumber;
        if (args.currentTask !== undefined) updated.currentTask = args.currentTask;
        if (args.tasks !== undefined) updated.tasks = args.tasks;

        const canonicalVerdict = agentId === 'reviewer' ? normalizeReviewerVerdict(args.verdict) : null;
        if (canonicalVerdict) {
            updated.verdict = canonicalVerdict;
            updated.currentPhase = reviewerPhaseForVerdict(canonicalVerdict);
        } else if (args.verdict !== undefined) {
            updated.verdict = args.verdict;
        }

        const resolvedPhase = updated.currentPhase;
        if (!Array.isArray(updated.events)) updated.events = [];
        (updated.events as unknown[]).push({
            timestamp: new Date().toISOString(),
            type: 'phase',
            message: args.message ?? `Phase: ${resolvedPhase}`,
        });

        writeFileSync(statusFile, JSON.stringify(updated, null, 2));
        emitStatusChange(agentId, buildStatusBroadcast(updated, agentId, true, frameworkDir));
        const v = canonicalVerdict ? ` verdict=${canonicalVerdict}` : (args.verdict ? ` verdict=${args.verdict}` : '');
        const coerced = canonicalVerdict && resolvedPhase !== args.phase ? ` (phase set from verdict; requested ${args.phase})` : '';
        const reviewerVerdictTerminal = agentId === 'reviewer'
            && (resolvedPhase === 'approved' || resolvedPhase === 'changes-requested');
        const stopPrefix = (canonicalVerdict || reviewerVerdictTerminal) ? `PHASE_COMPLETE::${resolvedPhase}\n` : '';
        return `${stopPrefix}Status updated: phase=${resolvedPhase}${v}${coerced}`;
    } catch (e) {
        return `Error updating status: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export async function toolCreateTask(
    args: Record<string, unknown>,
    frameworkDir: string,
    agentId: string,
): Promise<string> {
    const name = String(args.name ?? '').trim();
    if (!name) return 'Error: task name is required';
    const estimate = typeof args.estimate === 'number' ? args.estimate : 2;

    const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
    let storyNumber = '1';
    try {
        const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        if (typeof s.storyNumber === 'string') storyNumber = s.storyNumber;
    } catch { /* use default */ }

    try {
        const serverBaseUrl = process.env.SDLC_SERVER_URL || 'http://localhost:3001';
        const res = await fetch(`${serverBaseUrl}/api/scheduler/create-task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, storyNumber, name, estimate }),
            signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        if (res.status === 404 && text.includes('not found')) {
            return toolCreateTaskLocal(name, estimate, storyNumber, statusFile);
        }
        return `HTTP ${res.status}\n${text.slice(0, 1000)}`;
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

function toolCreateTaskLocal(name: string, estimate: number, storyNumber: string, statusFile: string): string {
    try {
        const s = existsSync(statusFile) ? parseJsonUtf8File(statusFile) as Record<string, unknown> : {};
        const tasks = Array.isArray(s.tasks) ? s.tasks as Array<Record<string, unknown>> : [];
        const taskNumber = `T-${String(tasks.length + 1).padStart(3, '0')}`;
        tasks.push({ id: taskNumber, number: taskNumber, name, status: 'pending', hours: estimate, source: 'local', inherited: false });
        s.tasks = tasks;
        writeFileSync(statusFile, JSON.stringify(s, null, 2));
        return `HTTP 200\n${JSON.stringify({ ok: true, number: taskNumber, name })}`;
    } catch (e) {
        return `Error writing task locally: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export async function toolHttpRequest(args: Record<string, unknown>): Promise<string> {
    const method = String(args.method ?? 'GET').toUpperCase();
    const url = String(args.url ?? '');
    if (!url) return 'Error: url is required';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (args.headers && typeof args.headers === 'object') {
        for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
            headers[k] = String(v);
        }
    }

    const init: RequestInit = { method, headers };
    if (args.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    }

    try {
        const res = await fetch(url, init);
        const text = await res.text();
        return `HTTP ${res.status} ${res.statusText}\n${text.slice(0, 4000)}`;
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}
