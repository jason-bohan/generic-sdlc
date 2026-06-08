// Retry scheduling for orchestrator actions paused by a Claude usage limit.
// When `claude -p` reports a limit it also reports WHEN the quota refreshes
// (parseResetTime in claude-print) — so we schedule the retry for exactly then
// instead of a blind backoff. Falls back to a 1h delay when no reset time was
// parseable, and clamps to a sane window.
//
// v1 is in-memory (an unref'd timer): a pending retry does not survive a server
// restart. Good enough to "wait till tokens refresh" within a session; persisting
// the queue across restarts is a follow-on.

const DEFAULT_RETRY_MS = 60 * 60 * 1000; // 1h when the CLI gave no reset time
const MIN_RETRY_MS = 60 * 1000; // never hammer sooner than 1m
const MAX_RETRY_MS = 6 * 60 * 60 * 1000; // never sleep past 6h
const CUSHION_MS = 5_000; // wait a touch past the stated reset

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

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule `fn` to run after `delayMs`, keyed so a repeated request for the same
 * key replaces (not stacks) the pending retry. The timer is unref'd so it never
 * keeps the process alive on its own.
 */
export function scheduleRetry(key: string, delayMs: number, fn: () => void): void {
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    pending.delete(key);
    try { fn(); } catch { /* retry failures are non-fatal */ }
  }, delayMs);
  if (typeof handle.unref === 'function') handle.unref();
  pending.set(key, handle);
}

export function cancelRetry(key: string): boolean {
  const handle = pending.get(key);
  if (!handle) return false;
  clearTimeout(handle);
  pending.delete(key);
  return true;
}

export function pendingRetryKeys(): string[] {
  return [...pending.keys()];
}
