// Orchestrator assign-loop — the deterministic half of the orchestrator vision:
// pull unassigned backlog stories, route each to the right specialist (brain
// triage), and assign it, gated by autonomous mode. No model authoring here and
// no Claude tokens — routing already runs on the brain via resolveStoryAgent;
// assignment is mechanical. This is the foundation the future story-authoring
// agent (claude-code) sits on top of.

import { resolve } from 'path';
import { existsSync } from 'fs';
import type { LocalPlanningStory } from './local-planning';
import { serverLog as log } from './logger';
import { loadLocalPlanningState, updateLocalStoryStatus } from './local-planning';
import { resolveStoryAgent, type StoryForOrchestration } from './orchestrator';
import { isRunnerActive } from './agent-runner/registry';
import { isAgentActive } from './spawn-agent';
import { getSchedulerWorkflowMode } from './schedulerMode';
import { getSchedulerConfig } from './route-shared';
import { isLoopActive, getLoopState } from './loop-control';
import { getActiveProjectName } from './project-config';
import { parseJsonUtf8File } from './json-file';
import { writeFileSync } from 'fs';
import type { SdlcAgentId } from '../shared/sdlcContracts';

const BACKLOG_STATUSES = new Set(['backlog']);
// An agent is free when its desk is at one of these (or has no live story).
const FREE_PHASES = new Set(['idle', 'complete', 'error', '']);
// How long without a heartbeat before a non-running agent is considered stalled.
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface AssignmentPlanItem {
  storyNumber: string;
  storyName: string;
  storyDescription: string;
  agentId: SdlcAgentId;
}

export interface OrchestratorTickResult {
  ran: boolean; // false when not in autonomous mode (no-op)
  reason?: string;
  assigned: AssignmentPlanItem[];
  skipped: Array<{ storyNumber: string; reason: string }>;
}

/** Pure: backlog stories only (not deleted/closed/in-progress), in board order. */
export function selectBacklogCandidates(stories: LocalPlanningStory[]): LocalPlanningStory[] {
  return stories
    .filter((s) => !s.deleted && BACKLOG_STATUSES.has(String(s.status).trim().toLowerCase()))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

function toOrchestrationStory(s: LocalPlanningStory, projectKey: string): StoryForOrchestration {
  return {
    number: s.number,
    name: s.name,
    description: s.description,
    frontend: s.frontend || null,
    backend: s.backend || null,
    qa: s.qa || null,
    preferredAgent: s.preferredAgent || null,
    projectKey,
  };
}

/**
 * Build an assignment plan: route each candidate and keep it only when the target
 * agent is free AND hasn't already taken a story in THIS tick (one story per agent
 * per tick — don't pile work on one specialist). `route` and `isBusy` are injected
 * so the planner is unit-testable without the brain or live runners.
 */
export async function planAssignments(
  candidates: LocalPlanningStory[],
  route: (s: StoryForOrchestration) => Promise<SdlcAgentId>,
  isBusy: (agentId: SdlcAgentId) => boolean,
  projectKey: string,
): Promise<{ assigned: AssignmentPlanItem[]; skipped: Array<{ storyNumber: string; reason: string }> }> {
  const assigned: AssignmentPlanItem[] = [];
  const skipped: Array<{ storyNumber: string; reason: string }> = [];
  const claimedThisTick = new Set<SdlcAgentId>();
  for (const s of candidates) {
    const agentId = await route(toOrchestrationStory(s, projectKey));
    if (claimedThisTick.has(agentId)) {
      skipped.push({ storyNumber: s.number, reason: `${agentId} already assigned this tick` });
      continue;
    }
    if (isBusy(agentId)) {
      skipped.push({ storyNumber: s.number, reason: `${agentId} busy` });
      continue;
    }
    claimedThisTick.add(agentId);
    assigned.push({ storyNumber: s.number, storyName: s.name, storyDescription: s.description, agentId });
  }
  return { assigned, skipped };
}

/**
 * Release a stalled agent's assignment: reset the status file to idle and
 * mark the story back to backlog so the orchestrator can reassign it.
 * Returns true when recovery was performed.
 */
export function recoverStalledAgent(agentId: string, rootDir: string): boolean {
  const file = resolve(rootDir, `.${agentId}-status.json`);
  if (!existsSync(file)) return false;
  try {
    const s = parseJsonUtf8File(file) as Record<string, unknown>;
    const phase = String(s.currentPhase ?? 'idle').trim().toLowerCase();
    const storyNum = String(s.storyNumber ?? '').trim();
    if (FREE_PHASES.has(phase) || !storyNum) return false;

    const isoNow = new Date().toISOString();
    const events = Array.isArray(s.events) ? [...s.events] : [];
    events.push({ timestamp: isoNow, type: 'info', message: `Agent ${agentId} stalled (process dead, heartbeat stale) — assignment released for story ${storyNum}.` });

    writeFileSync(file, JSON.stringify({
      ...s,
      currentPhase: 'idle',
      storyNumber: null,
      storyName: null,
      storyDescription: null,
      handoffDispatched: false,
      lastHeartbeat: isoNow,
      spawnedPid: null,
      events,
    }, null, 2));

    try { updateLocalStoryStatus(rootDir, storyNum, 'backlog'); } catch { /* non-critical */ }

    log.warn(`[stall-recovery] ${agentId} on ${storyNum}: reset to idle, story returned to backlog`);
    return true;
  } catch {
    return false;
  }
}

/** Is an agent occupied? Active in-process runner, its subprocess is alive, or its desk holds a live story. */
export function isAgentBusy(agentId: SdlcAgentId, rootDir: string): boolean {
  if (isRunnerActive(agentId)) return true;
  if (isAgentActive(agentId)) return true;
  const file = resolve(rootDir, `.${agentId}-status.json`);
  if (!existsSync(file)) return false;
  try {
    const s = parseJsonUtf8File(file) as Record<string, unknown>;
    const phase = String(s.currentPhase ?? 'idle').trim().toLowerCase();
    if (FREE_PHASES.has(phase) || !s.storyNumber) return false;
    // Agent desk says busy, but check if the process is dead with a stale heartbeat.
    const heartbeat = s.lastHeartbeat;
    if (typeof heartbeat === 'string') {
      const elapsed = Date.now() - new Date(heartbeat).getTime();
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        // Process is not tracked as active and heartbeat is stale — treat as stalled.
        recoverStalledAgent(agentId, rootDir);
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one orchestrator tick. In autonomous mode: route + assign every backlog
 * story whose target specialist is free, then mark it In Progress so it isn't
 * re-picked next tick. `assign` is injected — the route handler self-POSTs
 * /api/scheduler/assign (which spawns the agent). Returns what it did.
 */
export async function runOrchestratorTick(opts: {
  rootDir: string;
  configFile: string;
  assign: (item: AssignmentPlanItem) => Promise<boolean>;
}): Promise<OrchestratorTickResult> {
  const { rootDir, configFile, assign } = opts;

  if (!isLoopActive(rootDir)) {
    return { ran: false, reason: `loop ${getLoopState(rootDir)}`, assigned: [], skipped: [] };
  }
  const mode = getSchedulerWorkflowMode(getSchedulerConfig(rootDir));
  if (mode !== 'autonomous') {
    return { ran: false, reason: 'scheduler mode is not autonomous', assigned: [], skipped: [] };
  }

  const projectKey = getActiveProjectName(configFile);
  const candidates = selectBacklogCandidates(loadLocalPlanningState(rootDir).stories);
  const { assigned, skipped } = await planAssignments(
    candidates,
    (story) => resolveStoryAgent(story, { configPath: configFile }),
    (agentId) => isAgentBusy(agentId, rootDir),
    projectKey,
  );

  const confirmed: AssignmentPlanItem[] = [];
  for (const item of assigned) {
    const ok = await assign(item);
    if (ok) {
      confirmed.push(item);
      try {
        updateLocalStoryStatus(rootDir, item.storyNumber, 'In Progress');
      } catch {
        /* assignment succeeded; status bookkeeping is non-fatal */
      }
    } else {
      skipped.push({ storyNumber: item.storyNumber, reason: 'assign failed' });
    }
  }

  return { ran: true, assigned: confirmed, skipped };
}
