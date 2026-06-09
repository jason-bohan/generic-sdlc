// Orchestrator story authoring (Layer 2): turn a goal/intent into concrete,
// independently-shippable backlog stories. The JUDGMENT (decompose the goal) is
// one structured model call — on Claude (the sub) via claude-print, falling back
// to the brain; the PLUMBING (parse + create) is deterministic and tested. The
// authored stories land in the Backlog, where the assign-loop (Layer 1,
// orchestrator-tick) routes and kicks them off.

export interface AuthoredStory {
  name: string;
  description: string;
  acceptanceCriteria?: string;
  estimate?: number;
  /** Optional routing hint the model may emit (backend/frontend/qa/ux). */
  agentHint?: string;
}

export interface ModelCall {
  ok: boolean;
  text?: string;
  limited?: boolean;
  /** ISO time the quota refreshes (when the model reported it). */
  retryAt?: string;
  error?: string;
}

export interface AuthorResult {
  ok: boolean;
  reason?: string;
  /** True when the model hit a usage limit — pause and retry after refresh. */
  limited?: boolean;
  /** ISO time the quota refreshes, for scheduling the retry. */
  retryAt?: string;
  authored: Array<{ number: string; name: string }>;
}

/** A QA finding reduced to what authoring needs. */
export interface FindingSummary {
  /** Stable finding id (source:agentId:title:evidence) — links an authored story back to its finding. */
  id?: string;
  title: string;
  evidence?: string;
  severity?: string;
  suggestedOwner?: string;
}

/**
 * Pure: pick which findings to author from. With no ids, author from all (the
 * caller still caps + severity-sorts). With ids, restrict to those findings —
 * the per-finding "Author story" desk action passes a single id.
 */
export function selectFindingsForAuthoring(findings: FindingSummary[], findingIds?: string[]): FindingSummary[] {
  if (!findingIds || findingIds.length === 0) return findings;
  const wanted = new Set(findingIds);
  return findings.filter((f) => f.id !== undefined && wanted.has(f.id));
}

const SEVERITY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
export function severityRank(s?: string): number {
  return SEVERITY_RANK[(s ?? '').toLowerCase()] ?? 0;
}

/**
 * Frame the most-severe QA findings as an authoring goal (most severe first,
 * capped). The orchestrator then authors one fix story per finding. Returns ''
 * when there are no findings.
 */
export function buildGoalFromFindings(findings: FindingSummary[], max: number = 5): string {
  const top = [...findings]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, Math.max(1, max));
  if (top.length === 0) return '';
  const lines = top.map((f, i) =>
    `${i + 1}. [${f.severity ?? 'finding'}] ${f.title}${f.evidence ? ` — ${f.evidence}` : ''}${f.suggestedOwner ? ` (suggested owner: ${f.suggestedOwner})` : ''}`);
  return [
    'These are findings from the AI-QA audit of the codebase. Author one focused, independently-mergeable fix story per finding below (a single change each):',
    '',
    ...lines,
  ].join('\n');
}

/** The orchestrator's authoring instruction. Asks for a bare JSON array. */
export function buildAuthoringPrompt(goal: string, projectKey: string): string {
  return [
    `You are the SDLC orchestrator. Decompose the goal below into a small set of concrete, independently-shippable stories for the "${projectKey}" codebase.`,
    '',
    `GOAL: ${goal}`,
    '',
    'Rules:',
    '- 1 to 5 stories. Each must be a single, focused, independently-mergeable change. Returning ONE story is fine.',
    '- Prefer the smallest decomposition that satisfies the goal.',
    '- Each story needs: a short imperative "name", a clear "description" of the exact change, "acceptanceCriteria" (1-3 checks), and an "estimate" (1-8).',
    '- You may add "agentHint" (one of: backend, frontend, qa, ux) when the specialty is obvious.',
    '- Output ONLY a JSON array — no prose, no markdown fences. Example:',
    '  [{"name":"Add GET /api/ping/version","description":"...","acceptanceCriteria":"...","estimate":2,"agentHint":"backend"}]',
  ].join('\n');
}

/**
 * Pure: extract authored stories from raw model output. Tolerant of surrounding
 * prose / markdown fences — takes the first top-level JSON array. Drops elements
 * without a name. Never throws.
 */
export function parseAuthoredStories(raw: string): AuthoredStory[] {
  if (!raw) return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const stories: AuthoredStory[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) continue;
    stories.push({
      name,
      description: typeof o.description === 'string' ? o.description.trim() : '',
      acceptanceCriteria: typeof o.acceptanceCriteria === 'string' ? o.acceptanceCriteria.trim() : undefined,
      estimate: typeof o.estimate === 'number' && Number.isFinite(o.estimate) ? o.estimate : undefined,
      agentHint: typeof o.agentHint === 'string' ? o.agentHint.trim().toLowerCase() : undefined,
    });
  }
  return stories;
}

/**
 * Author stories from a goal: call the model, parse, create each in the backlog.
 * `callModel` and `createStory` are injected so this is unit-testable without a
 * live model or the planning store. Surfaces a usage-limit pause distinctly.
 */
export async function authorStories(opts: {
  goal: string;
  projectKey: string;
  callModel: (prompt: string) => Promise<ModelCall>;
  createStory: (s: AuthoredStory) => { number: string; name: string };
  maxStories?: number;
}): Promise<AuthorResult> {
  const goal = opts.goal?.trim();
  if (!goal) return { ok: false, reason: 'goal is required', authored: [] };

  const res = await opts.callModel(buildAuthoringPrompt(goal, opts.projectKey));
  if (res.limited) {
    return { ok: false, limited: true, retryAt: res.retryAt, reason: 'model usage limit reached — pause and retry after refresh', authored: [] };
  }
  if (!res.ok || !res.text) {
    return { ok: false, reason: res.error || 'model returned no output', authored: [] };
  }

  const stories = parseAuthoredStories(res.text).slice(0, opts.maxStories ?? 5);
  if (stories.length === 0) {
    return { ok: false, reason: 'model output contained no valid stories', authored: [] };
  }

  const authored = stories.map((s) => opts.createStory(s));
  return { ok: true, authored };
}
