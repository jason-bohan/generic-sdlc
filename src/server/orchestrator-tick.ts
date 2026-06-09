// Orchestrator assign-loop — the deterministic half of the orchestrator vision:
// pull unassigned backlog stories, route each to the right specialist (brain
// triage), and assign it, gated by autonomous mode. No model authoring here and
// no Claude tokens — routing already runs on the brain via resolveStoryAgent;
// assignment is mechanical. This is the foundation the future story-authoring
// agent (claude-code) sits on top of.

import { resolve } from 'path';
import { existsSync } from 'fs';
import type { LocalPlanningStory } from './local-planning';
import { loadLocalPlanningState, updateLocalStoryStatus } from './local-planning';
import { resolveStoryAgent, type StoryForOrchestration } from './orchestrator';
import { isRunnerActive } from './agent-runner/registry';
import { getSchedulerWorkflowMode } from './schedulerMode';
import { getSchedulerConfig } from './route-shared';
import { getActiveProjectName } from './project-config';
import { parseJsonUtf8File } from './json-file';
import type { SdlcAgentId } from '../shared/sdlcContracts';

const BACKLOG_STATUSES = new Set(['backlog']);
// An agent is free when its desk is at one of these (or has no live story).
const FREE_PHASES = new Set(['idle', 'complete', 'error', '']);

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

/** Is an agent occupied? Active in-process runner, or its desk holds a live story. */
export function isAgentBusy(agentId: SdlcAgentId, rootDir: string): boolean {
  if (isRunnerActive(agentId)) return true;
  const file = resolve(rootDir, `.${agentId}-status.json`);
  if (!existsSync(file)) return false;
  try {
    const s = parseJsonUtf8File(file) as Record<string, unknown>;
    const phase = String(s.currentPhase ?? 'idle').trim().toLowerCase();
    return !FREE_PHASES.has(phase) && !!s.storyNumber;
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
