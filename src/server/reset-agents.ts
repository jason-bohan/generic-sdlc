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

/** Does an agent desk reference this story (by storyNumber) or PR id? */
function deskMatchesStory(raw: Record<string, unknown>, storyNumber: string, prId?: number): boolean {
    const sn = typeof raw.storyNumber === 'string' ? raw.storyNumber.trim() : '';
    if (sn && sn === storyNumber) return true;
    const ap = raw.assignedPR as { id?: unknown; storyNumber?: string } | undefined;
    if (ap) {
        if (typeof ap.storyNumber === 'string' && ap.storyNumber.trim() === storyNumber) return true;
        if (prId != null && Number(ap.id) === prId) return true;
    }
    if (prId != null && Array.isArray(raw.prs) && raw.prs.some((p) => Number((p as { id?: unknown }).id) === prId)) return true;
    return false;
}

/**
 * Story-scoped completion (orchestrator-owned, replaces the blunt global reset for the
 * autonomous path). Frees ONLY the agent desks tied to this story/PR — sets them idle and
 * clears assignedPR/storyNumber — and cleans up the story's worktrees. Desks working OTHER
 * stories are left untouched, so completing story A can't wipe story B (the cross-story
 * contamination we hit: a stale reviewer desk from a prior PR derailing the next run). The
 * DB workflow item is the authoritative "complete" marker; this just releases the agents.
 */
/**
 * Pure: best-effort story number for an agent desk — its own storyNumber, else the assigned PR's
 * storyNumber, else parsed from the PR branch (e.g. `backend-LOCAL-B-0064` → `LOCAL-B-0064`).
 * Used to free the owner when a devops build completes with no story_number on the workflow item.
 */
export function storyNumberFromDesk(desk: { storyNumber?: unknown; assignedPR?: { storyNumber?: unknown; branch?: unknown } | null }): string {
  if (typeof desk.storyNumber === 'string' && desk.storyNumber.trim()) return desk.storyNumber.trim();
  const pr = desk.assignedPR;
  if (pr) {
    if (typeof pr.storyNumber === 'string' && pr.storyNumber.trim()) return pr.storyNumber.trim();
    if (typeof pr.branch === 'string') {
      const m = pr.branch.match(/([A-Z][A-Z0-9]*-(?:B-)?\d+)/);
      if (m) return m[1];
    }
  }
  return '';
}

export function freeStoryAgents(baseDir: string, storyNumber: string, prId?: number): { freed: string[] } {
    const isoNow = new Date().toISOString();
    const freed: string[] = [];
    const event = [{ timestamp: isoNow, type: 'info', message: `Story ${storyNumber} complete — desk freed.` }];

    for (const agentId of ['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops', 'aiqa']) {
        const rel = `.${agentId}-status.json`;
        const path = resolve(baseDir, rel);
        if (!existsSync(path)) continue;
        let raw: Record<string, unknown>;
        try { raw = parseJsonUtf8File(path) as Record<string, unknown>; } catch { continue; }
        if (!deskMatchesStory(raw, storyNumber, prId)) continue;
        // Preserve the desk's own shape (reviewer/devops differ from story owners); just
        // reset the work-holding fields so the agent is genuinely free for the next story.
        const idle: Record<string, unknown> = {
            ...raw,
            currentPhase: 'idle',
            storyNumber: null,
            assignedPR: null,
            handoffDispatched: false,
            reworkStuck: false,
            escalatedModel: null,
            events: [...(Array.isArray(raw.events) ? raw.events.slice(-10) : []), ...event],
        };
        writeFileSync(path, JSON.stringify(idle, null, 2));
        freed.push(rel);
    }

    if (!isMockExternalMode(resolve(baseDir, '.sdlc-framework.config.json'))) {
        for (const root of resolveWorktreeRepoRoots(baseDir, resolve(baseDir, '.sdlc-framework.config.json'))) {
            try { cleanupStoryWorktrees(root, storyNumber); } catch (e) { console.warn(`[free-story] worktree cleanup failed for ${storyNumber} in ${root}:`, e); }
        }
    }
    return { freed };
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
