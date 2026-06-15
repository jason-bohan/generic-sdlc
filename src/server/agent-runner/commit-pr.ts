import {
    existsSync,
    readFileSync,
    writeFileSync,
} from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
import { getSdlcPhaseContract, type SdlcPhaseId } from '../../shared/sdlcContracts';
import { isMockExternalMode } from '../external-mode';
import { parseJsonUtf8File } from '../json-file';
import { findStoryWorktree } from './worktree';

/**
 * Build/-tooling artifacts that must never be staged into a story commit.
 */
const COMMIT_JUNK_RE = /(^|\/)(node_modules|dist|build|out|coverage|\.vite|\.cache|\.next|\.turbo|\.nyc_output|\.claude)(\/|$)|(^|\/)\.DS_Store$|\.(log|tmp)$/i;

/** Parse `git status --porcelain` into changed paths (handles quoting and renames). */
function parsePorcelainPaths(porcelain: string): string[] {
    return porcelain.split('\n').map((line) => line.trimEnd()).filter(Boolean).map((line) => {
        let p = line.slice(3); // strip "XY " status prefix
        if (p.includes(' -> ')) p = p.slice(p.indexOf(' -> ') + 4); // rename: take the new path
        if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // git quotes paths with specials
        return p;
    }).filter(Boolean);
}

export interface AutoCommitResult { ok: boolean; committed: boolean; note: string; }

/**
 * Deterministically commit the story's worktree so the `committing` phase always
 * produces a real commit.
 */
export function autoCommitWorktree(workspaceDir: string, agentId: string, storyNumber: string, message: string): AutoCommitResult {
    const wt = findStoryWorktree(workspaceDir, agentId, storyNumber);
    if (!wt) {
        return { ok: false, committed: false, note: `no worktree found for ${agentId}-${storyNumber} — work must happen in .claude/worktrees/${agentId}-${storyNumber}` };
    }
    const git = (cargs: string[]): string => {
        try { return execFileSync('git', ['-C', wt, ...cargs], { encoding: 'utf8', timeout: 30_000 }).trimEnd(); }
        catch (e) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            return `__ERR__${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`;
        }
    };
    const status = git(['status', '--porcelain']);
    if (status.startsWith('__ERR__')) {
        return { ok: false, committed: false, note: `git status failed in worktree ${wt}: ${status.slice(7, 200)}` };
    }
    if (!status) {
        return { ok: true, committed: false, note: `already committed (clean): ${git(['log', '-1', '--oneline']) || '(no log)'}` };
    }
    const realPaths = parsePorcelainPaths(status).filter((p) => !COMMIT_JUNK_RE.test(p));
    if (realPaths.length === 0) {
        return { ok: false, committed: false, note: 'no real work to commit (only build/cache junk changed)' };
    }
    if (git(['add', '--', ...realPaths]).startsWith('__ERR__')) {
        return { ok: false, committed: false, note: `git add failed in worktree ${wt}` };
    }
    const out = git(['commit', '-m', message]);
    if (out.startsWith('__ERR__')) {
        return { ok: false, committed: false, note: `auto-commit failed in worktree ${wt}: ${out.slice(7, 200)}` };
    }
    return { ok: true, committed: true, note: `committed ${realPaths.length} file(s) → ${git(['rev-parse', '--short', 'HEAD'])}: ${message}` };
}

export interface AutoPrResult {
    pr?: Record<string, unknown>;
    mockPr?: Record<string, unknown>;
    handoff: string;
    note: string;
    ok: boolean;
}

/**
 * Deterministically push the story branch and create-or-reuse its PR when the
 * creating-pr phase completes.
 */
export function autoCreatePr(
    workspaceDir: string,
    agentId: string,
    storyNumber: string,
    title: string,
    body: string,
    configPath: string,
): AutoPrResult {
    const wt = findStoryWorktree(workspaceDir, agentId, storyNumber);
    if (!wt) {
        return { handoff: `${agentId}: no worktree found for ${agentId}-${storyNumber}`, note: `no worktree found for ${agentId}-${storyNumber}`, ok: false };
    }
    const sh = (bin: string, cargs: string[]): { ok: boolean; out: string } => {
        try { return { ok: true, out: execFileSync(bin, cargs, { cwd: wt, encoding: 'utf8', timeout: 60_000 }).trim() }; }
        catch (e) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.trim() };
        }
    };
    const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out || `${agentId}-${storyNumber}`;
    const prTitle = (title.trim().slice(0, 120)) || `${storyNumber}: ${agentId} changes`;

    if (isMockExternalMode(configPath)) {
        const mockPr = { number: 0, url: `mock://pr/${branch}`, branch, title: prTitle, state: 'open', mock: true };
        return { mockPr, handoff: `${agentId}: opened mock PR for ${branch}`, note: `mock mode — synthesized mockPr for ${branch}`, ok: true };
    }

    const baseRef = sh('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).out || 'origin/main';
    const changed = sh('git', ['diff', '--name-only', `${baseRef}...HEAD`]);
    if (changed.ok && changed.out.trim() === '') {
        return {
            handoff: `${agentId}: refusing to open an empty PR for ${branch} (no changes vs ${baseRef})`,
            note: `empty diff vs ${baseRef} — no PR created for ${branch}`,
            ok: false,
        };
    }

    const push = sh('git', ['-C', wt, 'push', '-u', 'origin', branch]);
    const existing = sh('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1']);
    let prNum: number | null = null;
    let prUrl = '';
    let reused = false;
    if (existing.ok) {
        try {
            const arr = JSON.parse(existing.out) as Array<{ number: number; url: string }>;
            if (arr[0]) { prNum = arr[0].number; prUrl = arr[0].url; reused = true; }
        } catch { /* fall through to create */ }
    }
    if (prNum === null) {
        const created = sh('gh', ['pr', 'create', '--head', branch, '--title', prTitle, '--body', body || prTitle]);
        if (!created.ok) {
            const reason = (created.out || push.out || 'unknown error').slice(0, 200);
            return { handoff: `${agentId}: could not open a PR for ${branch}`, note: `PR creation failed for ${branch}: ${reason}`, ok: false };
        }
        const view = sh('gh', ['pr', 'view', branch, '--json', 'number,url']);
        if (view.ok) {
            try { const o = JSON.parse(view.out) as { number: number; url: string }; prNum = o.number; prUrl = o.url; } catch { /* keep url from create output */ }
        }
        if (!prUrl) prUrl = (created.out.match(/https?:\/\/\S+/) || [''])[0];
    }
    const pr = { number: prNum, url: prUrl, branch, title: prTitle, state: 'open' };
    return {
        pr,
        handoff: `${agentId}: ${reused ? 'reusing' : 'opened'} PR${prNum !== null ? ` #${prNum}` : ''} for ${branch} → ${prUrl}`,
        note: `${reused ? 'reused existing' : 'created'} PR${prNum !== null ? ` #${prNum}` : ''} for ${branch}`,
        ok: true,
    };
}

export interface AutoMergeResult { ok: boolean; merged: boolean; note: string; }

/** Devops build-chain phases the framework routes forward deterministically. */
export const DEVOPS_BUILD_CHAIN = new Set<string>(['pending-build', 'monitoring-build', 'build-passed']);

/**
 * The deterministic forward phase for a devops build-chain hop.
 */
export function devopsBuildChainNextPhase(phase: SdlcPhaseId): SdlcPhaseId | undefined {
    return getSdlcPhaseContract(phase).allowedNext.find((p) => p !== 'error' && p !== 'build-failed');
}

/**
 * Pure: classify a GitHub PR's CI from its `statusCheckRollup`.
 */
export function classifyCiRollup(rollup: Array<Record<string, unknown>>): 'failed' | 'pending' | 'passed' | 'unknown' {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'unknown';
  let pending = false;
  for (const c of rollup) {
    const conclusion = String(c.conclusion ?? '').toUpperCase();
    const state = String(c.state ?? '').toUpperCase();
    const status = String(c.status ?? '').toUpperCase();
    if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) return 'failed';
    if (['FAILURE', 'ERROR'].includes(state)) return 'failed';
    if (['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'].includes(status)) pending = true;
    if (['PENDING', 'EXPECTED'].includes(state)) pending = true;
    if (status && status !== 'COMPLETED' && !conclusion) pending = true;
  }
  return pending ? 'pending' : 'passed';
}

/**
 * A PR with no additions, deletions, and changed files is empty.
 */
export function prIsEmpty(stat: { additions?: number; deletions?: number; changedFiles?: number }): boolean {
    return (stat.additions ?? 0) === 0 && (stat.deletions ?? 0) === 0 && (stat.changedFiles ?? 0) === 0;
}

/**
 * Deterministic PR merge for the devops build-gate.
 */
export function autoMergePr(frameworkDir: string, configPath: string): AutoMergeResult {
    const devopsFile = resolve(frameworkDir, '.devops-status.json');
    let pr: { id?: number; url?: string } | undefined;
    try {
        const s = parseJsonUtf8File(devopsFile) as { assignedPR?: { id?: number; url?: string } };
        pr = s.assignedPR;
    } catch { /* no desk */ }
    const prId = typeof pr?.id === 'number' ? pr.id : Number(pr?.id);
    if (!Number.isFinite(prId) || prId <= 0) return { ok: false, merged: false, note: 'no assigned PR id on the devops desk — cannot merge' };
    const prUrl = typeof pr?.url === 'string' ? pr.url : '';

    if (isMockExternalMode(configPath)) return { ok: true, merged: false, note: `mock mode — PR #${prId} not merged` };

    let repo = '';
    if (prUrl) {
        const m = prUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/pull\//i);
        if (m) repo = m[1];
        else return { ok: true, merged: false, note: `PR #${prId} is not a GitHub PR — left for its own host to finalize` };
    } else {
        try { repo = (parseJsonUtf8File(configPath) as { github?: { repo?: string } }).github?.repo || ''; } catch { /* */ }
    }
    if (!repo) return { ok: false, merged: false, note: `could not resolve a GitHub repo for PR #${prId}` };

    const gh = (args: string[]): { ok: boolean; out: string } => {
        try { return { ok: true, out: execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000 }).trim() }; }
        catch (e) { const err = e as { stdout?: string; stderr?: string; message?: string }; return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.trim() }; }
    };

    const statRes = gh(['pr', 'view', String(prId), '-R', repo, '--json', 'additions,deletions,changedFiles']);
    if (statRes.ok) {
        try {
            const stat = JSON.parse(statRes.out) as { additions?: number; deletions?: number; changedFiles?: number };
            if (prIsEmpty(stat)) {
                return { ok: false, merged: false, note: `EMPTY-PR:PR #${prId} in ${repo} has no file changes — refusing to merge (false completion).` };
            }
        } catch { /* couldn't parse — fall through, don't block a real PR on a read error */ }
    }

    const view = gh(['pr', 'view', String(prId), '-R', repo, '--json', 'mergeStateStatus,state']);
    let mergeState = '';
    try { mergeState = (JSON.parse(view.out) as { mergeStateStatus?: string }).mergeStateStatus ?? ''; } catch { /* */ }
    if (mergeState === 'DIRTY') {
        const prInfo = gh(['pr', 'view', String(prId), '-R', repo, '--json', 'headRefName,baseRefName']);
        let headBranch = '';
        let baseBranch = 'main';
        try {
            const parsed = JSON.parse(prInfo.out) as { headRefName?: string; baseRefName?: string };
            headBranch = parsed.headRefName ?? '';
            baseBranch = parsed.baseRefName ?? 'main';
        } catch { /* use defaults */ }
        return {
            ok: false,
            merged: false,
            note: `DIRTY:PR #${prId} in ${repo} (${headBranch} → ${baseBranch}) — resolve conflicts via: git fetch origin && git checkout ${headBranch} && git merge origin/${baseBranch}, resolve conflict markers in affected files, git add/commit, git push origin ${headBranch}, then retry complete_phase`,
        };
    }
    const rollupRes = gh(['pr', 'view', String(prId), '-R', repo, '--json', 'statusCheckRollup']);
    let ci: ReturnType<typeof classifyCiRollup> = 'unknown';
    try { ci = classifyCiRollup((JSON.parse(rollupRes.out) as { statusCheckRollup?: Array<Record<string, unknown>> }).statusCheckRollup ?? []); } catch { /* unknown — fall through */ }
    if (ci === 'failed') {
        return { ok: false, merged: false, note: `BUILD-FAILED:PR #${prId} in ${repo} — CI checks failed; route to rework (do not merge).` };
    }

    if (mergeState === 'BEHIND') {
        const upd = gh(['pr', 'update-branch', String(prId), '-R', repo]);
        if (!upd.ok && !/up to date|no new commits/i.test(upd.out)) {
            // couldn't update (e.g. conflict) — fall through; the merge attempt will report why
        }
    }

    const direct = gh(['pr', 'merge', String(prId), '--squash', '--delete-branch', '-R', repo]);
    if (direct.ok) return { ok: true, merged: true, note: `squash-merged PR #${prId} in ${repo}` };

    const auto = gh(['pr', 'merge', String(prId), '--squash', '--delete-branch', '--auto', '-R', repo]);
    if (auto.ok) return { ok: true, merged: false, note: `auto-merge armed for PR #${prId} in ${repo} — GitHub will squash-merge when required checks pass` };

    return { ok: false, merged: false, note: `merge failed for PR #${prId}: ${(direct.out || auto.out || 'unknown').slice(0, 200)}` };
}
