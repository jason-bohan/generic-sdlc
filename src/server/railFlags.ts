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

function asStrength(v: unknown): Strength | undefined {
    return v === 'weak' || v === 'mid' || v === 'strong' ? v : undefined;
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
