// Dependency-PR babysitter — autonomously merges safe dependency bumps.
//
// Renovate/Dependabot open a stream of dep-update PRs. The safe ones (non-major, CI-green,
// mergeable) need zero judgment — exactly the kind of plumbing the framework should handle
// instead of a human (or the story fleet, which can't "implement" an already-built PR). This
// is the same pattern as the build-gate driver: poll → safe + green → merge.
//
// Major bumps are NEVER auto-merged (they can break APIs / runtime); they're left for a human.
// Handles both bots (Dependabot titles "Bump X from A to B"; Renovate body `A` → `B` deltas)
// across a configurable list of repos. Gated by the loop brake + autonomous mode.

import { execFileSync } from 'child_process';
import { parseJsonUtf8File } from './json-file';
import { getSchedulerConfig } from './route-shared';
import { getSchedulerWorkflowMode } from './schedulerMode';
import { isLoopActive } from './loop-control';

export type DepUpdateClass = 'safe' | 'major' | 'unknown';

/** First integer of a version token, ignoring any v/^/~/== prefix. null if none. */
function majorOf(version: string): number | null {
  const m = String(version).match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** Extract (from → to) version pairs from a Dependabot title and/or a Renovate body table. */
function versionPairs(title: string, body: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  // Dependabot: "Bump <pkg> from 1.2.3 to 1.3.0" (also "Update ... from X to Y")
  const t = title.match(/\bfrom\s+([\w.^~=v-]+)\s+to\s+([\w.^~=v-]+)/i);
  if (t) pairs.push([t[1], t[2]]);
  // Parse ONLY the top of the body — the later Release Notes / changelog sections are full of
  // unrelated version mentions that must not be read as the bump. Truncate at the first rule /
  // heading / release-notes marker.
  const top = (body || '').split(/\n\s*(?:-{3,}|#{1,6}\s|Release Notes\b|Changelog\b|Configuration\b)/i)[0];
  let m: RegExpExecArray | null;
  // Renovate update table: `4.8.5` → `5.0.0`, `==4.8.5` → `==5.0.0`
  const reRenovate = /`(={0,2}[0-9v][^`]*)`\s*(?:→|-&gt;|->)\s*`(={0,2}[0-9v][^`]*)`/g;
  while ((m = reRenovate.exec(top)) !== null) pairs.push([m[1], m[2]]);
  // Dependabot body, including GROUPED PRs: "Updates `vite` from 5.4.21 to 8.0.16",
  // "Bumps `esbuild` from 0.21.0 to 0.25.0" — one line per package.
  const reDependabot = /(?:Updates?|Bumps?)\s+`?[^`\s]+`?\s+from\s+([\w.^~=v-]+)\s+to\s+([\w.^~=v-]+)/gi;
  while ((m = reDependabot.exec(top)) !== null) pairs.push([m[1], m[2]]);
  return pairs;
}

/**
 * Pure: classify a dependency PR's update. `major` if any bump crosses a major version (block);
 * `safe` if every parsed bump stays within its major; `unknown` if nothing parses (don't merge —
 * conservative). A 0.x → 0.y bump is treated as non-major (CI is the safety net), but a true
 * X→X+1 (incl. 0.x → 1.x) is major.
 */
export function classifyDepPr(title: string, body: string): DepUpdateClass {
  const pairs = versionPairs(title, body);
  if (pairs.length === 0) return 'unknown';
  let sawSafe = false;
  for (const [from, to] of pairs) {
    const fm = majorOf(from);
    const tm = majorOf(to);
    if (fm === null || tm === null) return 'unknown'; // can't be sure → don't auto-merge
    if (tm > fm) return 'major';
    sawSafe = true;
  }
  return sawSafe ? 'safe' : 'unknown';
}

const BOT_RE = /renovate|dependabot/i;

function gh(args: string[]): { ok: boolean; out: string } {
  try { return { ok: true, out: execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000 }).trim() }; }
  catch (e) { const err = e as { stdout?: string; stderr?: string; message?: string }; return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.trim() }; }
}

/** Repos to babysit: this framework repo + the active target repo + any configured extras. */
export function resolveBabysitRepos(rootDir: string, configFile: string): string[] {
  const repos = new Set<string>();
  const self = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (self.ok && /\S+\/\S+/.test(self.out)) repos.add(self.out);
  try {
    const cfg = parseJsonUtf8File(configFile) as { github?: { repo?: string }; scheduler?: { depBabysitterRepos?: string[] } };
    if (cfg.github?.repo) repos.add(cfg.github.repo);
    for (const r of cfg.scheduler?.depBabysitterRepos ?? []) if (r) repos.add(r);
  } catch { /* config optional */ }
  return [...repos];
}

export interface BabysitResult { merged: string[]; skipped: Array<{ pr: string; reason: string }>; }

/** One pass across all babysat repos. Merges safe + CLEAN dep PRs; skips everything else. */
export function babysitDepPRs(rootDir: string, configFile: string): BabysitResult {
  const result: BabysitResult = { merged: [], skipped: [] };
  if (!isLoopActive(rootDir)) return result;
  if (getSchedulerWorkflowMode(getSchedulerConfig(rootDir)) !== 'autonomous') return result;

  for (const repo of resolveBabysitRepos(rootDir, configFile)) {
    const list = gh(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '50', '--json', 'number,title,body,author,mergeStateStatus']);
    if (!list.ok) continue;
    let prs: Array<{ number: number; title: string; body: string; author?: { login?: string }; mergeStateStatus: string }>;
    try { prs = JSON.parse(list.out); } catch { continue; }
    for (const pr of prs) {
      if (!BOT_RE.test(pr.author?.login ?? '')) continue;
      const tag = `${repo}#${pr.number}`;
      const cls = classifyDepPr(pr.title ?? '', pr.body ?? '');
      if (cls !== 'safe') { result.skipped.push({ pr: tag, reason: cls }); continue; }
      // `gh pr list` returns mergeStateStatus lazily (UNKNOWN until a PR is viewed). Force the
      // compute with `gh pr view` so an idle-but-mergeable PR isn't skipped forever.
      let state = pr.mergeStateStatus;
      if (state === 'UNKNOWN') {
        const v = gh(['pr', 'view', String(pr.number), '-R', repo, '--json', 'mergeStateStatus', '-q', '.mergeStateStatus']);
        if (v.ok && v.out) state = v.out.trim();
      }
      // Only merge a CLEAN PR (mergeable + green + up to date). BEHIND/BLOCKED/CONFLICTING are
      // left for the bot to rebase and a later pass to retry — avoids lockfile merge churn.
      if (state !== 'CLEAN') { result.skipped.push({ pr: tag, reason: `not clean (${state})` }); continue; }
      const merged = gh(['pr', 'merge', String(pr.number), '-R', repo, '--squash', '--delete-branch']);
      if (merged.ok) result.merged.push(tag);
      else result.skipped.push({ pr: tag, reason: `merge failed: ${merged.out.slice(0, 120)}` });
    }
  }
  return result;
}

/** Start the periodic dep babysitter (gated internally to loop-active + autonomous). */
export function startDepBabysitter(rootDir: string, configFile: string): void {
  const POLL_MS = 10 * 60_000; // dep PRs are slow-moving
  setInterval(() => {
    try {
      const r = babysitDepPRs(rootDir, configFile);
      if (r.merged.length) console.log(`[dep-babysitter] merged ${r.merged.length} safe dep PR(s): ${r.merged.join(', ')}`);
    } catch (e) { console.warn('[dep-babysitter]', e instanceof Error ? e.message : String(e)); }
  }, POLL_MS);
}
