import { readBody, json } from '../router';
import type { UseFn } from './types';
import { runOrchestratorTick, type AssignmentPlanItem } from '../orchestrator-tick';
import { authorStories, type AuthoredStory, type ModelCall } from '../orchestrator-author';
import { claudePrint } from '../claude-print';
import { computeRetryDelayMs, scheduleRetry } from '../orchestrator-retry';
import { smartChat } from '../brainModel';
import { createLocalStory } from '../local-planning';
import { getActiveProjectName } from '../project-config';

const ROUTING_HINT_FIELDS = new Set(['backend', 'frontend', 'qa']);

/**
 * Orchestrator routes. /api/orchestrator/tick runs one deterministic assign-loop
 * pass: in autonomous mode, route every free backlog story to its specialist and
 * assign it. Triggerable manually now; a periodic caller can drive it later.
 */
export function mount(use: UseFn, rootDir: string, configFile: string): void {
  use('/api/orchestrator/tick', async (req, res) => {
    if (req.method !== 'POST') {
      json(res, { error: 'Method not allowed' }, 405);
      return;
    }
    // Body is optional; accept and ignore for forward-compat (e.g. future limits).
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

  // POST /api/orchestrator/author { goal, autoAssign? } — the Layer-2 authoring
  // step: decompose a goal into backlog stories using Claude (the sub) with the
  // brain as fallback. Optionally chain the assign-loop to kick them off.
  use('/api/orchestrator/author', async (req, res) => {
    if (req.method !== 'POST') {
      json(res, { error: 'Method not allowed' }, 405);
      return;
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* empty/invalid body */ }
    const goal = String(body.goal ?? '').trim();
    if (!goal) {
      json(res, { error: 'goal is required' }, 400);
      return;
    }

    // Author on the Claude subscription via `claude -p`; fall back to the brain
    // (OpenRouter) only when the CLI is unavailable. A usage limit is surfaced as
    // limited (do NOT fall back — the orchestrator should pause and retry later).
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
        ...hint,
      });
      return { number: story.number, name: story.name };
    };

    try {
      const result = await authorStories({
        goal,
        projectKey: getActiveProjectName(configFile),
        callModel,
        createStory,
      });
      if (!result.ok) {
        // Usage limit: schedule the retry for exactly when the quota refreshes
        // (the time the CLI reported), re-firing the same authoring request.
        if (result.limited) {
          const host = req.headers.host || 'localhost:3001';
          const delayMs = computeRetryDelayMs(result.retryAt);
          scheduleRetry(`author:${goal}`, delayMs, () => {
            fetch(`http://${host}/api/orchestrator/author`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ goal, autoAssign: body.autoAssign === true }),
            }).catch(() => { /* next scheduled retry (if still limited) will re-arm */ });
          });
          json(res, { ...result, retryScheduled: { atIso: result.retryAt ?? null, inMs: delayMs } }, 429);
          return;
        }
        json(res, result, 400);
        return;
      }
      // Optional: immediately route+assign the freshly authored backlog.
      if (body.autoAssign === true) {
        const host = req.headers.host || 'localhost:3001';
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
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
