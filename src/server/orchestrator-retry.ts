// Retry scheduling for orchestrator actions paused by a Claude usage limit.
// When `claude -p` reports a limit it also reports WHEN the quota refreshes
// (parseResetTime in claude-print) — so we schedule the retry for exactly then
// instead of a blind backoff. Falls back to a 1h delay when no reset time was
// parseable, and clamps to a sane window.
//
// Retries are PERSISTED to `.orchestrator-retries.json` and rescheduled on boot
// (resumeRetries), so a pause that spans a server restart still fires when the
// quota refreshes. The in-memory timers are unref'd so they never keep the
// process alive on their own.

import { resolve } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { parseJsonUtf8File } from './json-file';

const DEFAULT_RETRY_MS = 60 * 60 * 1000; // 1h when the CLI gave no reset time
const MIN_RETRY_MS = 60 * 1000; // never hammer sooner than 1m
const MAX_RETRY_MS = 6 * 60 * 60 * 1000; // never sleep past 6h
const CUSHION_MS = 5_000; // wait a touch past the stated reset
const RESUME_FLOOR_MS = 2_000; // on boot, an already-due retry fires ~now

/** A retry's intent — enough to reconstruct the action after a restart. */
export type RetryAction = { kind: 'author'; goal: string; autoAssign: boolean };

export interface RetryRecord {
  key: string;
  fireAt: number; // epoch ms
  action: RetryAction;
}

/**
 * Pure: how long to wait before retrying, given the parsed reset time (ISO) and
 * a fallback. Clamped to [MIN, MAX]; adds a small cushion past the reset.
 */
export function computeRetryDelayMs(
  retryAt: string | undefined,
  now: number = Date.now(),
  fallbackMs: number = DEFAULT_RETRY_MS,
): number {
  let target = fallbackMs;
  if (retryAt) {
    const t = Date.parse(retryAt);
    if (!Number.isNaN(t)) target = t - now + CUSHION_MS;
  }
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, target));
}

// ── Persistence ────────────────────────────────────────────────────────────
function retriesFile(rootDir: string): string {
  return resolve(rootDir, '.orchestrator-retries.json');
}

function isRecord(r: unknown): r is RetryRecord {
  const o = r as Record<string, unknown> | null;
  return !!o && typeof o.key === 'string' && typeof o.fireAt === 'number'
    && !!o.action && (o.action as RetryAction).kind === 'author'
    && typeof (o.action as RetryAction).goal === 'string';
}

function readRecords(rootDir: string): RetryRecord[] {
  if (!existsSync(retriesFile(rootDir))) return [];
  try {
    const data = parseJsonUtf8File(retriesFile(rootDir));
    return Array.isArray(data) ? data.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function writeRecords(rootDir: string, recs: RetryRecord[]): void {
  try {
    writeFileSync(retriesFile(rootDir), JSON.stringify(recs, null, 2));
  } catch {
    /* persistence is best-effort; the in-memory timer still fires this session */
  }
}

function upsertRecord(rootDir: string, rec: RetryRecord): void {
  writeRecords(rootDir, [...readRecords(rootDir).filter((r) => r.key !== rec.key), rec]);
}

function removeRecord(rootDir: string, key: string): void {
  const recs = readRecords(rootDir);
  const filtered = recs.filter((r) => r.key !== key);
  if (filtered.length !== recs.length) writeRecords(rootDir, filtered);
}

/** Inspect the persisted queue (for tests / diagnostics). */
export function loadPersistedRetries(rootDir: string): RetryRecord[] {
  return readRecords(rootDir);
}

// ── Scheduling ───────────────────────────────────────────────────────────────
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function arm(
  rootDir: string,
  key: string,
  delayMs: number,
  action: RetryAction,
  execute: (action: RetryAction) => void,
): void {
  const handle = setTimeout(() => {
    timers.delete(key);
    removeRecord(rootDir, key); // remove before executing so a re-pause re-persists
    try { execute(action); } catch { /* retry failures are non-fatal */ }
  }, delayMs);
  if (typeof handle.unref === 'function') handle.unref();
  timers.set(key, handle);
}

/**
 * Schedule (and persist) a retry. Keyed so a repeat for the same key REPLACES the
 * pending retry rather than stacking. The record is removed when it fires or is
 * cancelled. `execute` runs the action (injected so this stays HTTP-free/testable).
 */
export function scheduleRetry(opts: {
  rootDir: string;
  key: string;
  delayMs: number;
  action: RetryAction;
  execute: (action: RetryAction) => void;
}): void {
  const { rootDir, key, delayMs, action, execute } = opts;
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  upsertRecord(rootDir, { key, fireAt: Date.now() + delayMs, action });
  arm(rootDir, key, delayMs, action, execute);
}

export function cancelRetry(rootDir: string, key: string): boolean {
  const handle = timers.get(key);
  if (handle) {
    clearTimeout(handle);
    timers.delete(key);
  }
  const had = readRecords(rootDir).some((r) => r.key === key);
  removeRecord(rootDir, key);
  return !!handle || had;
}

export function pendingRetryKeys(): string[] {
  return [...timers.keys()];
}

/**
 * On boot: reschedule every persisted retry. A retry whose fire time already
 * passed (e.g. the quota refreshed while the server was down) fires shortly;
 * future ones fire at their time (capped). Returns how many were resumed.
 */
export function resumeRetries(rootDir: string, execute: (action: RetryAction) => void): number {
  const recs = readRecords(rootDir);
  const now = Date.now();
  for (const rec of recs) {
    const delay = Math.min(MAX_RETRY_MS, Math.max(RESUME_FLOOR_MS, rec.fireAt - now));
    arm(rootDir, rec.key, delay, rec.action, execute);
  }
  return recs.length;
}

/** Default executor: re-fire the action against a running server. */
export function executeRetryAction(baseUrl: string, action: RetryAction): void {
  if (action.kind === 'author') {
    fetch(`${baseUrl}/api/orchestrator/author`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: action.goal, autoAssign: action.autoAssign }),
    }).catch(() => { /* if still limited, the route re-schedules a fresh retry */ });
  }
}
