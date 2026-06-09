import type { IncomingMessage, ServerResponse } from 'http';
import { readBody, json } from '../router';
import type { UseFn } from './types';
import { runOrchestratorTick, type AssignmentPlanItem } from '../orchestrator-tick';
import {
  authorStories, buildGoalFromFindings, selectFindingsForAuthoring, topFindingsForGoal, sortOrderForSeverity,
  type AuthoredStory, type ModelCall, type AuthorResult, type FindingSummary,
} from '../orchestrator-author';
import { claudePrint } from '../claude-print';
import { computeRetryDelayMs, scheduleRetry, executeRetryAction } from '../orchestrator-retry';
import { smartChat } from '../brainModel';
import { createLocalStory, updateLocalStory } from '../local-planning';
import { resolveProjectTracker } from '../providers';
import { getActiveProjectName } from '../project-config';

const ROUTING_HINT_FIELDS = new Set(['backend', 'frontend', 'qa']);

/** Author on the Claude sub via `claude -p`, falling back to the brain only when
 *  the CLI is unavailable (NOT on a usage limit — that pauses & retries). */
function makeAuthoringDeps(rootDir: string, configFile: string) {
  const callModel = async (prompt: string): Promise<ModelCall> => {
    const c = await claudePrint(prompt, { timeoutMs: 120_000 });
    if (c.ok || c.limited) return c;
    const text = await smartChat(prompt, configFile, { maxTokens: 1500, timeoutMs: 60_000 });
    return text ? { ok: true, text } : { ok: false, error: c.error || 'no authoring model available' };
  };
  const createStory = (s: AuthoredStory) => {
    const hint = s.agentHint && ROUTING_HINT_FIELDS.has(s.agentHint) ? { [s.agentHint]: s.description } : {};
    const story = createLocalStory(rootDir, {
      name: s.name,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria ?? '',
      estimate: s.estimate ?? null,
      status: 'Backlog',
      // Tag the story with its origin finding (resolved per-story by the caller) so
      // the AI-QA desk can show which findings already have an authored story.
      ...(s.sourceFindingId ? { sourceFindingId: s.sourceFindingId } : {}),
      // Explicit routing target (e.g. the finding's suggestedOwner) so the story
      // routes deterministically to the right specialist instead of via classification.
      ...(s.preferredAgent ? { preferredAgent: s.preferredAgent } : {}),
      // Board ordering from finding severity so the assign-loop works severe findings first.
      ...(s.sortOrder !== undefined ? { sortOrder: s.sortOrder } : {}),
      ...hint,
    });
    // Fire-and-forget mirror to the external tracker (Linear/GitHub) if configured.
    // Non-blocking, but failures are LOGGED, never swallowed: a story that lands only
    // in the local store while the live tracker is the source of truth is invisible to
    // the assign-loop, so a silent mirror failure must not look like success.
    const pmProvider = (process.env.PM_PROVIDER ?? '').toLowerCase();
    if (pmProvider === 'linear' || pmProvider === 'github') {
      const warn = (e: unknown) =>
        console.warn(`[author] mirror to ${pmProvider} failed for ${story.number} (${s.name}) — story is local-only: ${e instanceof Error ? e.message : String(e)}`);
      resolveProjectTracker(rootDir, configFile).then(tracker => {
        if (!tracker) { warn('no tracker resolved'); return; }
        return tracker.createWorkItem({
          title: s.name,
          description: s.description,
          type: 'story',
          acceptanceCriteria: s.acceptanceCriteria,
          estimate: s.estimate ?? null,
        }).then(ext => {
          if (ext.number) {
            updateLocalStory(rootDir, story.number, { externalRef: ext.number, externalUrl: ext.url });
          } else {
            warn('tracker returned no issue number');
          }
        });
      }).catch(warn);
    }
    return { number: story.number, name: story.name };
  };
  return { callModel, createStory };
}

/** Uniform response for an authoring result: on a usage limit schedule a retry
 *  for the refresh time; on success optionally chain the assign-loop. */
async function respondAuthorResult(
  req: IncomingMessage,
  res: ServerResponse,
  rootDir: string,
  opts: { retryGoal: string; autoAssign: boolean },
  result: AuthorResult,
): Promise<void> {
  const host = req.headers.host || 'localhost:3001';

  if (!result.ok) {
    if (result.limited) {
      const delayMs = computeRetryDelayMs(result.retryAt);
      scheduleRetry({
        rootDir,
        key: `author:${opts.retryGoal}`,
        delayMs,
        action: { kind: 'author', goal: opts.retryGoal, autoAssign: opts.autoAssign },
        execute: (action) => executeRetryAction(`http://${host}`, action),
      });
      json(res, { ...result, retryScheduled: { atIso: result.retryAt ?? null, inMs: delayMs } }, 429);
      return;
    }
    json(res, result, 400);
    return;
  }

  if (opts.autoAssign) {
    try {
      const tickRes = await fetch(`http://${host}/api/orchestrator/tick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      const tick = tickRes.ok ? await tickRes.json() : { error: `tick HTTP ${tickRes.status}` };
      json(res, { ...result, tick }, 200);
      return;
    } catch (e) {
      json(res, { ...result, tick: { error: e instanceof Error ? e.message : String(e) } }, 200);
      return;
    }
  }
  json(res, result, 200);
}

/**
 * Orchestrator routes:
 *  - /tick      : deterministic assign-loop (route + assign free backlog stories).
 *  - /author    : decompose a goal into backlog stories (Claude sub → brain).
 *  - /from-aiqa : seed authoring from the AI-QA scorecard findings.
 */
export function mount(use: UseFn, rootDir: string, configFile: string): void {
  use('/api/orchestrator/tick', async (req, res) => {
    if (req.method !== 'POST') {
      json(res, { error: 'Method not allowed' }, 405);
      return;
    }
    try { await readBody(req); } catch { /* no body is fine */ }

    const host = req.headers.host || 'localhost:3001';
    const assign = async (item: AssignmentPlanItem): Promise<boolean> => {
      try {
        const r = await fetch(`http://${host}/api/scheduler/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: item.agentId,
            storyNumber: item.storyNumber,
            storyName: item.storyName,
            storyDescription: item.storyDescription,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        return r.ok;
      } catch {
        return false;
      }
    };

    try {
      const result = await runOrchestratorTick({ rootDir, configFile, assign });
      json(res, result, 200);
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // POST /api/orchestrator/author { goal, autoAssign? }
  use('/api/orchestrator/author', async (req, res) => {
    if (req.method !== 'POST') {
      json(res, { error: 'Method not allowed' }, 405);
      return;
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* empty/invalid */ }
    const goal = String(body.goal ?? '').trim();
    if (!goal) {
      json(res, { error: 'goal is required' }, 400);
      return;
    }
    const { callModel, createStory } = makeAuthoringDeps(rootDir, configFile);
    try {
      const result = await authorStories({ goal, projectKey: getActiveProjectName(configFile), callModel, createStory });
      await respondAuthorResult(req, res, rootDir, { retryGoal: goal, autoAssign: body.autoAssign === true }, result);
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // POST /api/orchestrator/from-aiqa { autoAssign?, maxStories? } — seed authoring
  // from the AI-QA scorecard: pull findings, frame them as a goal, author a fix
  // story per finding. Self-fetches the scorecard (buildAiQaScorecard isn't exported).
  use('/api/orchestrator/from-aiqa', async (req, res) => {
    if (req.method !== 'POST') {
      json(res, { error: 'Method not allowed' }, 405);
      return;
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* empty/invalid */ }
    const host = req.headers.host || 'localhost:3001';
    const maxStories = typeof body.maxStories === 'number' && body.maxStories > 0 ? Math.floor(body.maxStories) : 5;

    // Optional: restrict authoring to specific findings (the per-finding desk action
    // passes one id). Absent → author from the top findings across the whole scorecard.
    const findingIds = Array.isArray(body.findingIds)
      ? body.findingIds.map((x) => String(x)).filter(Boolean)
      : undefined;

    let findings: FindingSummary[] = [];
    try {
      const r = await fetch(`http://${host}/api/aiqa/scorecard`, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) { json(res, { error: `AI-QA scorecard HTTP ${r.status}` }, 502); return; }
      const sc = (await r.json()) as { findings?: Array<Record<string, unknown>> };
      findings = (sc.findings ?? [])
        .map((f) => ({
          id: typeof f.id === 'string' ? f.id : undefined,
          title: String(f.title ?? ''),
          evidence: typeof f.evidence === 'string' ? f.evidence : undefined,
          severity: typeof f.severity === 'string' ? f.severity : undefined,
          suggestedOwner: typeof f.suggestedOwner === 'string' ? f.suggestedOwner : undefined,
        }))
        .filter((f) => f.title);
    } catch (e) {
      json(res, { error: `could not fetch AI-QA scorecard: ${e instanceof Error ? e.message : String(e)}` }, 502);
      return;
    }

    findings = selectFindingsForAuthoring(findings, findingIds);
    if (findings.length === 0) {
      json(res, { ok: false, reason: findingIds ? 'no matching AI-QA findings to author from' : 'no AI-QA findings to author from', authored: [] }, 200);
      return;
    }

    // Resolve each story back to the finding it addresses. The goal numbers findings
    // 1..N (via topFindingsForGoal) and asks the model to set findingRef per story;
    // map that index → finding. A single-finding run resolves deterministically even if
    // the model omits findingRef. From the finding we take both the link (id) and the
    // routing target (suggestedOwner) so the authored story routes to the right specialist.
    const top = topFindingsForGoal(findings, maxStories);
    const indexToFinding = new Map<number, FindingSummary>(top.map((f, i) => [i + 1, f]));
    const findingFor = (s: AuthoredStory): FindingSummary | undefined => {
      if (typeof s.findingRef === 'number' && indexToFinding.has(s.findingRef)) return indexToFinding.get(s.findingRef);
      return top.length === 1 ? top[0] : undefined;
    };
    const sourceFindingIdFor = (s: AuthoredStory): string | undefined => findingFor(s)?.id;
    const preferredAgentFor = (s: AuthoredStory): string | undefined => findingFor(s)?.suggestedOwner;
    const sortOrderFor = (s: AuthoredStory): number | undefined => {
      const f = findingFor(s);
      return f ? sortOrderForSeverity(f.severity) : undefined;
    };

    const goal = buildGoalFromFindings(findings, maxStories);
    const { callModel, createStory } = makeAuthoringDeps(rootDir, configFile);
    try {
      const result = await authorStories({
        goal,
        projectKey: getActiveProjectName(configFile),
        callModel,
        createStory,
        maxStories: Math.min(maxStories, findings.length),
        sourceFindingIdFor,
        preferredAgentFor,
        sortOrderFor,
      });
      await respondAuthorResult(req, res, rootDir, { retryGoal: goal, autoAssign: body.autoAssign === true }, result);
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
