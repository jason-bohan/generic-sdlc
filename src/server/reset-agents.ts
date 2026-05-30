import { existsSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { cleanupStoryWorktrees, resolveWorktreeRepoRoots } from './worktree-cleanup';
import { isMockExternalMode } from './external-mode';
import { parseJsonUtf8File } from './json-file';

export interface AgentIdleResetResult {
    written: string[];
    clearedMessages: string[];
}

/** Writable filenames relative to workspace root (for responses only). */
function storyNumberFromAgentStatusFile(baseDir: string, agentId: string): string | undefined {
    const statusPath = resolve(baseDir, `.${agentId}-status.json`);
    if (!existsSync(statusPath)) return undefined;
    try {
        const raw = parseJsonUtf8File(statusPath) as Record<string, unknown>;
        const direct = raw.storyNumber;
        if (typeof direct === 'string' && direct.trim()) return direct.trim();
        const ap = raw.assignedPR as { storyNumber?: string } | undefined;
        if (ap && typeof ap.storyNumber === 'string' && ap.storyNumber.trim()) return ap.storyNumber.trim();
    } catch { /* ignore */ }
    return undefined;
}

export function resetAllAgentsToIdle(baseDir: string): AgentIdleResetResult {
    const isoNow = new Date().toISOString();
    const written: string[] = [];
    const clearedMessages: string[] = [];

    const configPath = resolve(baseDir, '.sdlc-framework.config.json');
    const worktreeRoots = resolveWorktreeRepoRoots(baseDir, configPath);
    const storyNums = new Set<string>();
    for (const agentId of ['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops', 'orchestrator', 'aiqa']) {
        const n = storyNumberFromAgentStatusFile(baseDir, agentId);
        if (n) storyNums.add(n);
    }

    const idleEvent = [{ timestamp: isoNow, type: 'info', message: 'Reset to idle.' }];
    const tokens = { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } };
    const cypress = {
        lastRun: null as string | null,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        failures: [] as unknown[] };

    const storyOwner = {
        storyNumber: null as string | null,
        storyName: null as string | null,
        storyDescription: null as string | null,
        currentPhase: 'idle' as const,
        currentTask: null as string | null,
        startedAt: null as string | null,
        tokens,
        tasks: [] as unknown[],
        prs: [] as unknown[],
        requests: [] as unknown[],
        cypress,
        events: idleEvent,
        handoffDispatched: false };

    for (const id of ['frontend', 'backend', 'qa'] as const) {
        const rel = `.${id}-status.json`;
        const path = resolve(baseDir, rel);
        writeFileSync(path, JSON.stringify(storyOwner, null, 2));
        written.push(rel);
    }

    const uxIdle = {
        ...storyOwner,
        collaborators: [] as unknown[],
        designSpec: null as string | null };
    writeFileSync(resolve(baseDir, '.ux-status.json'), JSON.stringify(uxIdle, null, 2));
    written.push('.ux-status.json');

    const reviewerIdle = {
        assignedPR: null,
        currentPhase: 'idle',
        requestedAt: null,
        events: idleEvent,
        projectKey: null as string | null };
    writeFileSync(resolve(baseDir, '.reviewer-status.json'), JSON.stringify(reviewerIdle, null, 2));
    written.push('.reviewer-status.json');

    const devopsIdle = {
        currentPhase: 'idle',
        assignedPR: null,
        events: idleEvent,
        projectKey: null as string | null };
    writeFileSync(resolve(baseDir, '.devops-status.json'), JSON.stringify(devopsIdle, null, 2));
    written.push('.devops-status.json');

    if (existsSync(baseDir)) {
        for (const name of readdirSync(baseDir)) {
            if (/^\.[^/]+-messages\.json$/.test(name)) {
                writeFileSync(resolve(baseDir, name), '[]', 'utf-8');
                clearedMessages.push(name);
            }
        }
    }

    if (!isMockExternalMode(configPath)) {
        for (const sn of storyNums) {
            for (const root of worktreeRoots) {
                try {
                    cleanupStoryWorktrees(root, sn);
                } catch (e) {
                    console.warn(`[reset-agents] worktree cleanup failed for story ${sn} in ${root}:`, e);
                }
            }
        }
    }

    return { written, clearedMessages };
}
