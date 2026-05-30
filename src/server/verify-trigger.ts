/**
 * Post-implementation verification trigger.
 *
 * Subscribed via the hook-runner's `onEvent`: when an implementation agent
 * reaches a "done" phase (default: build-passed / complete), this fires the
 * Goose `verify-change` recipe to verify the change by actually running the app.
 *
 * Opt-in: gated behind `scheduler.verifyOnComplete` (default off) so no agent
 * lifecycle change silently starts spawning goose processes. The hook-runner
 * already de-dupes per (agentId, phase), so this won't re-fire on rapid writes.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { buildGooseVerifySpawnSpec } from './agent-drivers';
import { parseJsonUtf8File } from './json-file';
import { serverLog as log } from './logger';
import type { StatusChangeEvent } from './status-events';

const DEFAULT_VERIFY_PHASES = ['build-passed', 'complete'];

// Agents that don't produce app code to verify. aiqa is excluded so the verifier
// never triggers verification of itself (loop guard).
const NON_VERIFIABLE_AGENTS = new Set(['aiqa', 'orchestrator', 'reviewer']);

export interface VerifyTriggerConfig {
    enabled: boolean;
    phases: string[];
}

export function readVerifyTriggerConfig(configFile: string): VerifyTriggerConfig {
    try {
        if (!existsSync(configFile)) return { enabled: false, phases: DEFAULT_VERIFY_PHASES };
        const cfg = parseJsonUtf8File(configFile) as Record<string, unknown>;
        const sched = (cfg.scheduler as Record<string, unknown>) ?? {};
        const rawPhases = sched.verifyOnPhases;
        const phases = Array.isArray(rawPhases) && rawPhases.length > 0
            ? rawPhases.map(String)
            : DEFAULT_VERIFY_PHASES;
        return { enabled: sched.verifyOnComplete === true, phases };
    } catch {
        return { enabled: false, phases: DEFAULT_VERIFY_PHASES };
    }
}

export function shouldTriggerVerify(ev: StatusChangeEvent, cfg: VerifyTriggerConfig): boolean {
    if (!cfg.enabled) return false;
    if (NON_VERIFIABLE_AGENTS.has(ev.agentId)) return false;
    const phase = String(ev.status?.currentPhase ?? '');
    return cfg.phases.includes(phase);
}

export function verifyScopeFor(ev: StatusChangeEvent): string {
    const story = ev.status?.storyNumber;
    return story ? `story ${String(story)} (branch diff main..HEAD)` : 'main..HEAD';
}

export interface VerifyTriggerDeps {
    spawnImpl?: typeof spawn;
    config?: VerifyTriggerConfig;
}

/**
 * Decide-and-fire. Returns whether verification was triggered and why. Never
 * throws — a failed trigger must not break the agent lifecycle.
 */
export function maybeTriggerVerification(
    rootDir: string,
    configFile: string,
    ev: StatusChangeEvent,
    deps: VerifyTriggerDeps = {},
): { triggered: boolean; reason: string } {
    const cfg = deps.config ?? readVerifyTriggerConfig(configFile);
    if (!shouldTriggerVerify(ev, cfg)) {
        return { triggered: false, reason: 'phase/agent/config not a verify trigger' };
    }

    const scope = verifyScopeFor(ev);
    const spec = buildGooseVerifySpawnSpec(scope, rootDir);
    if ('error' in spec) {
        log.warn(`[verify-trigger] ${ev.agentId}: cannot verify — ${spec.error}`);
        return { triggered: false, reason: spec.error };
    }

    const spawnImpl = deps.spawnImpl ?? spawn;
    const phase = String(ev.status?.currentPhase ?? '');
    log.info(`[verify-trigger] ${ev.agentId} reached "${phase}"; verifying "${scope}" via goose verify-change recipe`);
    try {
        const child = spawnImpl(spec.cmd, spec.args, {
            cwd: rootDir,
            env: { ...process.env, ...spec.env },
            stdio: 'ignore',
            detached: true,
        }) as ChildProcess;
        child.unref?.();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`[verify-trigger] ${ev.agentId}: spawn failed — ${msg}`);
        return { triggered: false, reason: msg };
    }
    return { triggered: true, reason: scope };
}
