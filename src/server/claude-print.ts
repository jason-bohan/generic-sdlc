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
  error?: string;
}

// Heuristic match for the CLI's usage-limit / rate-limit messaging.
const LIMIT_RE = /usage limit|rate limit|limit reached|out of (?:usage|credits)|quota|too many requests|\b429\b|resets? at|upgrade to/i;

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
        finish({ ok: false, limited: true, error: 'Claude usage limit reached — pause and retry after refresh' });
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
