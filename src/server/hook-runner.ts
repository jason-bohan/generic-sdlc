/**
 * Server-side hook-runner: subscribes to the status-events bus and fires
 * watcher logic in-process whenever a .*-status.json file changes.
 *
 * Replaces the per-agent *.ps1 watcher hooks for paths where an IDE stop-hook
 * is not required (server boot, autonomous scheduler, etc.).
 *
 * Idempotency: each (agentId, phase) combination is only actioned once until
 * the phase changes again, preventing duplicate reactions to rapid file writes.
 */

import { onStatusChange, startStatusFileWatcher, type StatusChangeEvent } from './status-events';
import { serverLog as log } from './logger';

export interface HookRunnerOptions {
    /** Absolute path to the SDLC Framework workspace root (where .*-status.json files live). */
    rootDir: string;
    /**
     * Called when a status change event passes the idempotency check.
     * Receives the full StatusChangeEvent so subscribers can implement
     * domain-specific reactions (phase transitions, nudges, etc.).
     */
    onEvent?: (ev: StatusChangeEvent) => void;
}

/** Tracks the last-seen phase per agentId to gate duplicate reactions. */
const _lastPhase = new Map<string, string>();

let _unsubscribe: (() => void) | null = null;
let _rootDir: string | null = null;

/**
 * Start the hook-runner.
 * Ensures the file watcher is running, subscribes to the status bus, and
 * fires `options.onEvent` for each unique (agentId, phase) transition.
 * Calling `startHookRunner` again with the same rootDir is a no-op.
 */
export function startHookRunner(options: HookRunnerOptions): void {
    if (_unsubscribe !== null && _rootDir === options.rootDir) return;
    if (_unsubscribe !== null) stopHookRunner();

    _rootDir = options.rootDir;
    startStatusFileWatcher(options.rootDir);

    _unsubscribe = onStatusChange((ev: StatusChangeEvent) => {
        const phase = String((ev.status as Record<string, unknown>).currentPhase ?? '');
        const key = ev.agentId;
        if (_lastPhase.get(key) === phase) return;
        _lastPhase.set(key, phase);
        log.info(`[hook-runner] ${ev.agentId} → ${phase || '(no phase)'}`);
        options.onEvent?.(ev);
    });

    log.info('[hook-runner] started');
}

/**
 * Stop the hook-runner and unsubscribe from the status bus.
 * The file watcher is left running (managed independently by status-events).
 */
export function stopHookRunner(): void {
    if (_unsubscribe === null) return;
    _unsubscribe();
    _unsubscribe = null;
    _rootDir = null;
    _lastPhase.clear();
    log.info('[hook-runner] stopped');
}

/** Returns true when the hook-runner is currently subscribed. */
export function isHookRunnerActive(): boolean {
    return _unsubscribe !== null;
}
