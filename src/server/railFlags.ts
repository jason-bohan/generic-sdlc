/**
 * Strength-flagged rails (Phase 1).
 *
 * A capable agent runs unburdened; a weak one gets the full rail set. Each worker
 * model has a strength tier (configured in agentStrength); a static table maps that
 * tier to the set of rails that are active for the run. Flags are computed once at
 * assignment and stored on the agent desk; every rail reads them via deskRailFlags.
 *
 * Fail safe: an unknown model, missing config, or a desk without flags is treated as
 * 'weak' (ALL rails) — we never silently drop a guard when uncertain.
 *
 * Phase 2 (not here) layers a runtime "effective strength" that decays on bounce/drift;
 * Phase 3 learns strength from historical success rates.
 */
import { resolve } from 'path';
import { writeFileSync } from 'fs';
import { parseJsonUtf8File } from './json-file';

export type Strength = 'weak' | 'mid' | 'strong';

export type RailFlag =
    | 'emptyCodeGenGate'       // 409 on a generating-code completion with no file changes
    | 'suppressPlanOnReentry'  // drop "execute the plan" on a post-failure re-entry
    | 'idempotentFixPrompt'    // "already in worktree, fix-only, don't re-add" guidance
    | 'commitAmend'            // amend the story commit instead of stacking a new one
    | 'forwardProgressCoerce'  // coerce a PASSED validating away from routing backward
    | 'devLoopPauseCap'        // dev-loop escalate/pause ladder (safety)
    | 'behaviorGate';          // boot the app + probe the story's endpoint

const LEVEL: Record<Strength, number> = { weak: 0, mid: 1, strong: 2 };

/** Each rail is ACTIVE when the agent's strength level is <= this max. */
const RAIL_MAX: Record<RailFlag, number> = {
    behaviorGate: 2,          // always — honest gate, cheap for everyone
    devLoopPauseCap: 2,       // always — safety cap
    emptyCodeGenGate: 1,      // weak + mid
    suppressPlanOnReentry: 1, // weak + mid
    idempotentFixPrompt: 1,   // weak + mid
    commitAmend: 1,           // weak + mid
    forwardProgressCoerce: 0, // weak only — strong models don't bounce a PASSED validation
};

export const ALL_RAIL_FLAGS = Object.keys(RAIL_MAX) as RailFlag[];

export function asStrength(v: unknown): Strength | undefined {
    return v === 'weak' || v === 'mid' || v === 'strong' ? v : undefined;
}

const STRENGTH_BY_LEVEL: Strength[] = ['weak', 'mid', 'strong']; // index === level

/** Dev-loop phases whose re-entries signal a struggling run (drives decay). */
export const DEV_LOOP_PHASES: ReadonlySet<string> = new Set(['analyzing', 'generating-code', 'validating']);

/**
 * Phase 2 — effective strength as a run struggles. Demote tiers by accumulated dev-loop
 * starts (bounces) so a strong agent that *starts* misbehaving gets rails switched on
 * mid-run. Monotonic within an assignment (the count only grows) → rails only tighten,
 * never loosen. Thresholds align with the dev-loop ladder (escalate-cloud at 6):
 * mid at 3, weak at 6.
 */
export function decayStrength(base: Strength, devLoopStarts: number): Strength {
    let level = LEVEL[base];
    if (devLoopStarts >= 6) level -= 2;
    else if (devLoopStarts >= 3) level -= 1;
    return STRENGTH_BY_LEVEL[Math.max(0, level)];
}

/** Look up a model's configured strength. Unknown model / no config → 'weak' (fail safe). */
export function strengthForModel(model: string, configPath: string): Strength {
    try {
        const cfg = parseJsonUtf8File(configPath) as { agentStrength?: Record<string, unknown> };
        const map = cfg.agentStrength;
        if (map && typeof map === 'object') {
            return asStrength(map[model]) ?? asStrength(map._default) ?? 'weak';
        }
    } catch { /* no/unreadable config → weak */ }
    return 'weak';
}

/** The rails active for a strength tier. */
export function computeRailFlags(strength: Strength): RailFlag[] {
    return ALL_RAIL_FLAGS.filter(f => LEVEL[strength] <= RAIL_MAX[f]);
}

/**
 * Rails active for a running agent, read off its desk (written at assignment).
 * Absent (legacy/in-flight run) → 'weak' set, so a guard is never dropped by accident.
 */
export function deskRailFlags(agentId: string, rootDir: string): Set<RailFlag> {
    try {
        const desk = parseJsonUtf8File(resolve(rootDir, `.${agentId}-status.json`)) as { railFlags?: unknown };
        if (Array.isArray(desk.railFlags)) {
            return new Set(desk.railFlags.filter((f): f is RailFlag => ALL_RAIL_FLAGS.includes(f as RailFlag)));
        }
    } catch { /* no desk → weak */ }
    return new Set(computeRailFlags('weak'));
}

// ─── Phase 3: learned strength from a model's track record ──────────────────

export interface ModelStats {
    runs: number;
    cleanRuns: number;       // reached complete without pausing for a human
    stalledRuns: number;     // paused/stuck
    devLoopStartsTotal: number;
}

const MODEL_STATS_FILE = '.sdlc-framework/model-stats.json';
/** Minimum completed runs before a model's history is trusted over the config prior. */
export const LEARNED_STRENGTH_MIN_SAMPLES = 5;

const EMPTY_STATS: ModelStats = { runs: 0, cleanRuns: 0, stalledRuns: 0, devLoopStartsTotal: 0 };

/**
 * Derive a strength tier from a model's history, or undefined when there isn't enough
 * data yet (caller falls back to the config prior). A model that finishes cleanly with
 * little bouncing earns 'strong'; a decent record earns 'mid'; a poor one 'weak'.
 */
export function learnedStrengthFrom(stats: ModelStats): Strength | undefined {
    if (stats.runs < LEARNED_STRENGTH_MIN_SAMPLES) return undefined;
    const cleanRate = stats.cleanRuns / stats.runs;
    const avgBounce = stats.devLoopStartsTotal / stats.runs;
    if (cleanRate >= 0.8 && avgBounce <= 1) return 'strong';
    if (cleanRate >= 0.5) return 'mid';
    return 'weak';
}

export function readModelStats(rootDir: string, model: string): ModelStats {
    try {
        const all = parseJsonUtf8File(resolve(rootDir, MODEL_STATS_FILE)) as Record<string, Partial<ModelStats>>;
        const s = all?.[model];
        if (s) return { ...EMPTY_STATS, ...s };
    } catch { /* no stats yet */ }
    return { ...EMPTY_STATS };
}

/** Record a terminal run outcome for a model (best-effort; never throws). */
export function recordRunOutcome(rootDir: string, model: string | undefined, outcome: { stalled: boolean; devLoopStarts: number }): void {
    if (!model) return;
    try {
        const path = resolve(rootDir, MODEL_STATS_FILE);
        let all: Record<string, Partial<ModelStats>> = {};
        try { all = parseJsonUtf8File(path) as Record<string, Partial<ModelStats>>; } catch { /* first write */ }
        const s = { ...EMPTY_STATS, ...(all[model] ?? {}) };
        s.runs += 1;
        if (outcome.stalled) s.stalledRuns += 1; else s.cleanRuns += 1;
        s.devLoopStartsTotal += Math.max(0, outcome.devLoopStarts | 0);
        all[model] = s;
        writeFileSync(path, JSON.stringify(all, null, 2));
    } catch { /* non-fatal — learning is best-effort */ }
}

/**
 * Base strength for a run: a model's learned strength once it has enough history,
 * otherwise the configured prior (which itself falls back to 'weak'). Phase 2 decay
 * then applies on top of this during the run.
 */
export function resolveBaseStrength(model: string, configPath: string, rootDir: string): Strength {
    return learnedStrengthFrom(readModelStats(rootDir, model)) ?? strengthForModel(model, configPath);
}
