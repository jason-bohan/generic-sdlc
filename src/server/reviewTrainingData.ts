import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { resolveWorktreeRepoRoots } from './worktree-cleanup';

const PENDING_DIR = '.review-training-pending';
const OUTPUT_FILE = 'review_training_data.jsonl';

const MAX_FILE_CHARS = 6000;

interface ReviewComment {
  summary: string;
  file?: string;
  line?: number;
  severity?: string;
}

interface PendingReviewRecord {
  prId: number;
  branch: string;
  feedback: ReviewComment[];
  baseSha: string;
  headSha: string;
  contextFiles: Record<string, string>;
  collectedAt: string;
}

interface WorktreeRepoRoots {
  frameworkRoot: string;
  /** Application code workspace(s) — may share the framework root. */
  appRoots: string[];
}

function repoRoots(rootDir: string, configFile: string): WorktreeRepoRoots {
  const all = resolveWorktreeRepoRoots(rootDir, configFile) as string[];
  const frameworkRoot = resolve(rootDir);
  return {
    frameworkRoot,
    appRoots: all.filter(r => resolve(r) !== frameworkRoot),
  };
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return '';
  }
}

function hasBranch(repoRoot: string, branch: string): boolean {
  return git(['rev-parse', '--verify', branch], repoRoot).length > 0;
}

function pendingDir(rootDir: string): string {
  return resolve(rootDir, PENDING_DIR);
}

function pendingPath(rootDir: string, prId: number): string {
  return resolve(pendingDir(rootDir), `pr-${prId}.json`);
}

function ensurePendingDir(rootDir: string): void {
  const d = pendingDir(rootDir);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function loadPending(rootDir: string, prId: number): PendingReviewRecord | null {
  const p = pendingPath(rootDir, prId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PendingReviewRecord;
  } catch {
    return null;
  }
}

function savePending(rootDir: string, record: PendingReviewRecord): void {
  ensurePendingDir(rootDir);
  writeFileSync(pendingPath(rootDir, record.prId), JSON.stringify(record, null, 2));
}

function removePending(rootDir: string, prId: number): void {
  const p = pendingPath(rootDir, prId);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch { /* ok */ }
  }
}

function findRepoForBranch(rootDir: string, configFile: string, branch: string): string | null {
  const roots = repoRoots(rootDir, configFile);
  // Check app roots first (most likely to have the feature branch)
  for (const r of roots.appRoots) {
    if (hasBranch(r, branch)) return r;
  }
  if (hasBranch(roots.frameworkRoot, branch)) return roots.frameworkRoot;
  return null;
}

function fetchContextFiles(repoRoot: string, commitSha: string, paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const p of paths) {
    const content = git(['show', `${commitSha}:${p}`], repoRoot);
    if (content) {
      result[p] = content.slice(0, MAX_FILE_CHARS);
    }
  }
  return result;
}

function parseDiffPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\//);
    if (m) paths.push(m[1]);
  }
  return paths;
}

const TARGET_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.css', '.sql']);
const SKIP_PATH_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.snap$/,
  /dist\//,
  /build\//,
  /node_modules\//,
];

function isTargetPath(path: string): boolean {
  if (SKIP_PATH_PATTERNS.some(p => p.test(path))) return false;
  return TARGET_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? '');
}

function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      count++;
    }
  }
  return count;
}

const MAX_CHANGED_LINES = 120;

function appendExample(rootDir: string, example: Record<string, unknown>): void {
  const outPath = resolve(rootDir, OUTPUT_FILE);
  writeFileSync(outPath, JSON.stringify(example) + '\n', { flag: 'a' });
}

/**
 * Called when the reviewer requests changes on a PR.
 * Captures the current branch state (the agent's code before the fix)
 * and the reviewer's feedback, saving them as a pending record.
 */
export function saveReviewPending(
  rootDir: string,
  configFile: string,
  prId: number,
  branch: string,
  feedback: ReviewComment[],
): void {
  const repoRoot = findRepoForBranch(rootDir, configFile, branch);
  if (!repoRoot) {
    console.warn(`[reviewTrainingData] no repo found for branch ${branch} — skipping`);
    return;
  }

  const headSha = git(['rev-parse', branch], repoRoot);
  if (!headSha) {
    console.warn(`[reviewTrainingData] cannot resolve ${branch} in ${repoRoot} — skipping`);
    return;
  }

  const baseSha = git(['merge-base', branch, 'HEAD'], repoRoot);
  if (!baseSha) {
    console.warn(`[reviewTrainingData] cannot compute merge-base for ${branch} — skipping`);
    return;
  }

  // Get the diff of the agent's work (what's on the branch that the reviewer looked at)
  const diff = git(['diff', baseSha, headSha, '-M', '--diff-filter=M', '-p', '--'], repoRoot);
  if (!diff) {
    // Branch might be same as base — no changes at all. This is unusual but not
    // a reason to crash. The reviewer must have found something to comment on.
    // Skip silently.
    return;
  }

  const changedPaths = parseDiffPaths(diff);
  const targetPaths = changedPaths.filter(p => isTargetPath(p));
  if (!targetPaths.length) return;
  if (countChangedLines(diff) > MAX_CHANGED_LINES) return;

  // Fetch file contents at the base (before the agent's changes) for context
  const contextFiles = fetchContextFiles(repoRoot, baseSha, targetPaths.slice(0, 5));
  if (!Object.keys(contextFiles).length) return;

  const record: PendingReviewRecord = {
    prId,
    branch,
    feedback,
    baseSha,
    headSha,
    contextFiles,
    collectedAt: new Date().toISOString(),
  };

  savePending(rootDir, record);
  console.log(`[reviewTrainingData] saved pending record for PR #${prId} (${branch}) — ${targetPaths.length} file(s)`);
}

/**
 * Called when the reviewer approves a PR.
 * Looks up the pending record (saved at changes-requested time), computes
 * the fix diff (headSha → current branch HEAD), and writes a complete
 * training example to `review_training_data.jsonl`.
 */
export function completeReviewTrainingData(
  rootDir: string,
  configFile: string,
  prId: number,
  branch?: string,
): void {
  const pending = loadPending(rootDir, prId);
  if (!pending) return; // no pending record — this round wasn't tracked
  if (!branch) branch = pending.branch;

  const repoRoot = findRepoForBranch(rootDir, configFile, branch);
  if (!repoRoot) {
    console.warn(`[reviewTrainingData] cannot find repo for ${branch} to complete PR #${prId}`);
    return;
  }

  const newHeadSha = git(['rev-parse', branch], repoRoot);
  if (!newHeadSha) {
    console.warn(`[reviewTrainingData] cannot resolve ${branch} — skipping completion`);
    return;
  }

  // If the head hasn't changed, the agent may have approved without fixing.
  if (newHeadSha === pending.headSha) {
    console.log(`[reviewTrainingData] PR #${prId}: no new commits since changes-requested — skipping`);
    removePending(rootDir, prId);
    return;
  }

  // Compute the fix diff: from the original HEAD (when changes were requested) to the new HEAD
  const fixDiff = git(['diff', pending.headSha, newHeadSha, '-M', '--diff-filter=M', '-p', '--'], repoRoot);
  if (!fixDiff || countChangedLines(fixDiff) > MAX_CHANGED_LINES) {
    console.log(`[reviewTrainingData] PR #${prId}: fix diff empty or too large — skipping`);
    removePending(rootDir, prId);
    return;
  }

  const fixPaths = parseDiffPaths(fixDiff);
  const targetFixPaths = fixPaths.filter(p => isTargetPath(p));
  if (!targetFixPaths.length) {
    console.log(`[reviewTrainingData] PR #${prId}: no target-language files in fix — skipping`);
    removePending(rootDir, prId);
    return;
  }

  const feedbackSummaries = pending.feedback.map(f => {
    let s = f.summary;
    if (f.file) s = `[${f.file}${f.line ? `:${f.line}` : ''}] ${s}`;
    if (f.severity) s = `[${f.severity.toUpperCase()}] ${s}`;
    return s;
  });

  const example: Record<string, unknown> = {
    instruction: `The reviewer requested changes on PR #${prId}:\n${feedbackSummaries.join('\n')}`,
    context: {
      files: pending.contextFiles,
    },
    response: fixDiff.trim(),
    _meta: {
      source: 'review',
      pr_id: prId,
      branch: branch,
      review_comments: pending.feedback,
      old_head: pending.headSha,
      new_head: newHeadSha,
      collected_at: new Date().toISOString(),
    },
  };

  appendExample(rootDir, example);
  removePending(rootDir, prId);
  console.log(`[reviewTrainingData] wrote training example for PR #${prId} (${branch})`);
}
