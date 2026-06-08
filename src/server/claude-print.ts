// One-shot completion from Jason's Claude Code subscription via `claude -p`
// (non-interactive print mode). Used by the orchestrator's story-authoring so
// the highest-judgment role runs on Claude, not the free brain — with usage-limit
// detection so the caller can PAUSE and retry after the quota window refreshes
// (the "waits till tokens refresh" behavior), rather than failing.

import { spawn } from 'child_process';

export interface ClaudePrintResult {
  ok: boolean;
  text?: string;
  /** Hit a usage/rate limit — caller should pause and retry after refresh. */
  limited?: boolean;
  /** ISO time the quota refreshes, parsed from the CLI's limit message (if given). */
  retryAt?: string;
  error?: string;
}

// Heuristic match for the CLI's usage-limit / rate-limit messaging.
const LIMIT_RE = /usage limit|rate limit|limit reached|out of (?:usage|credits)|quota|too many requests|\b429\b|resets? at|upgrade to/i;

/**
 * Best-effort: extract the quota-reset time from a Claude usage-limit message so
 * a retry can be scheduled for exactly when tokens refresh, rather than a blind
 * backoff. Handles a unix epoch (s or ms), an ISO timestamp, a relative
 * "in N hours/minutes", and a clock time "reset(s) at 3[:30] [am/pm]" (resolved
 * to the next occurrence). Returns an ISO string, or undefined when not found.
 */
export function parseResetTime(text: string, now: number = Date.now()): string | undefined {
  if (!text) return undefined;

  // Unix epoch near the word "reset" (10-digit seconds or 13-digit ms).
  const epoch = text.match(/reset[^0-9]{0,24}(\d{10,13})/i);
  if (epoch) {
    const digits = epoch[1];
    const ms = digits.length >= 13 ? Number(digits) : Number(digits) * 1000;
    if (Number.isFinite(ms) && ms > now) return new Date(ms).toISOString();
  }

  // ISO 8601 timestamp anywhere in the message.
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t) && t > now) return new Date(t).toISOString();
  }

  // Relative: "in 2 hours" / "in 30 min".
  const rel = text.match(/in\s+(\d+)\s*(hours?|hrs?|minutes?|mins?)/i);
  if (rel) {
    const unitMs = /^h/i.test(rel[2]) ? 3_600_000 : 60_000;
    return new Date(now + Number(rel[1]) * unitMs).toISOString();
  }

  // Clock time: "resets at 3[:30] [am/pm]" → next occurrence of that time.
  const clock = text.match(/reset[^0-9]{0,24}(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let h = Number(clock[1]);
    const m = clock[2] ? Number(clock[2]) : 0;
    const ap = clock[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || m > 59) return undefined;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  return undefined;
}

/**
 * Run `claude -p` with the prompt on stdin and return its output. Best-effort:
 * resolves (never rejects) with ok:false when the CLI is missing/unauthed/errors,
 * or limited:true when it reports a usage limit. The prompt is piped via stdin to
 * avoid arg-length/escaping issues.
 */
export function claudePrint(
  prompt: string,
  opts?: { timeoutMs?: number; model?: string },
): Promise<ClaudePrintResult> {
  return new Promise((resolveResult) => {
    const args = ['-p'];
    if (opts?.model) args.push('--model', opts.model);

    let child;
    try {
      child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolveResult({ ok: false, error: `claude not available: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: ClaudePrintResult) => { if (!settled) { settled = true; resolveResult(r); } };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, error: 'claude -p timed out' });
    }, opts?.timeoutMs ?? 120_000);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: `claude not available: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = `${out}\n${err}`;
      if (LIMIT_RE.test(combined)) {
        finish({ ok: false, limited: true, retryAt: parseResetTime(combined), error: 'Claude usage limit reached — pause and retry after refresh' });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, error: err.trim() || `claude -p exited with code ${code}` });
        return;
      }
      finish({ ok: true, text: out.trim() });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: `failed to send prompt: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
}
