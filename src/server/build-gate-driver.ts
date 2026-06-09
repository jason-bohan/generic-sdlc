// Deterministic GitHub build-gate driver.
//
// The devops build chain (pending-build → monitoring-build → build-passed → merge) is pure
// plumbing: once a PR's CI is green and it's mergeable, the framework should merge it. ADO
// pipelines POST /api/handoff/build-complete to drive this; GitHub has no equivalent, so it
// relied on the devops *agent* to check `gh` and advance — which a slow local model can stall
// on, stranding a CI-green, approved, mergeable PR (observed: PR #48 sat at pending-build).
//
// This driver removes the model from that mechanical step: when devops is parked in the build
// chain on a GitHub PR, it calls the same deterministic `autoMergePr` the build-gate uses and
// advances the desk — automating the manual nudge. It reuses autoMergePr's BEHIND/arm/DIRTY
// handling and is idempotent. No-op unless the scheduler is autonomous and step mode is off.

import { resolve } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { parseJsonUtf8File } from './json-file';
import { autoMergePr } from './agent-runner/tools';
import { getSchedulerConfig } from './route-shared';
import { getSchedulerWorkflowMode } from './schedulerMode';
import { isGlobalStepMode, isAgentStepMode } from './stepMode';

// Build-chain phases where devops is waiting on CI/merge and the driver may act.
const DRIVE_PHASES = new Set(['pending-build', 'monitoring-build', 'build-passed']);
const GH_PR_RE = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;

/**
 * Pure: should the framework deterministically drive the build gate for this desk? Only when
 * devops is parked in the build chain on a GitHub PR with step mode off.
 */
export function shouldDriveBuildGate(phase: string, prUrl: string, stepMode: boolean): boolean {
  if (stepMode) return false;
  if (!DRIVE_PHASES.has(String(phase).trim())) return false;
  return GH_PR_RE.test(prUrl || '');
}

function ghRepoAndId(url: string): { repo: string; id: number } | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/pull\/(\d+)/i);
  return m ? { repo: m[1], id: Number(m[2]) } : null;
}

/**
 * One pass. No-op unless autonomous + not step mode + devops parked in the build chain on a
 * GitHub PR. When the PR is already MERGED, advances the desk to complete. Otherwise drives the
 * merge once via autoMergePr (merge now, or arm auto-merge), marking the desk so it doesn't
 * re-arm every tick — then waits for the merge to land on a later pass.
 */
export function driveDevopsBuildGate(rootDir: string, configFile: string): { acted: boolean; note: string } {
  if (getSchedulerWorkflowMode(getSchedulerConfig(rootDir)) !== 'autonomous') return { acted: false, note: 'not autonomous' };
  const devopsFile = resolve(rootDir, '.devops-status.json');
  if (!existsSync(devopsFile)) return { acted: false, note: 'no devops desk' };
  let desk: Record<string, unknown>;
  try { desk = parseJsonUtf8File(devopsFile); } catch { return { acted: false, note: 'unreadable desk' }; }

  const phase = String(desk.currentPhase ?? '');
  const assignedPR = desk.assignedPR as { url?: string } | undefined;
  const prUrl = typeof assignedPR?.url === 'string' ? assignedPR.url : '';
  const stepMode = isGlobalStepMode(configFile) || isAgentStepMode('devops', configFile);
  if (!shouldDriveBuildGate(phase, prUrl, stepMode)) return { acted: false, note: `skip (phase=${phase})` };

  const info = ghRepoAndId(prUrl);
  if (!info) return { acted: false, note: 'unparseable PR url' };

  const advance = (message: string, toComplete: boolean) => {
    desk.currentPhase = toComplete ? 'complete' : phase;
    if (!toComplete) desk.buildGateArmed = true;
    desk.events = [...(Array.isArray(desk.events) ? desk.events : []), { timestamp: new Date().toISOString(), type: 'success', message: `[build-gate-driver] ${message}` }].slice(-50);
    writeFileSync(devopsFile, JSON.stringify(desk, null, 2));
  };

  // Already merged (e.g. an armed auto-merge fired) → finalize the desk.
  let state = '';
  try { state = execFileSync('gh', ['pr', 'view', String(info.id), '-R', info.repo, '--json', 'state', '-q', '.state'], { encoding: 'utf8', timeout: 30_000 }).trim(); } catch { /* gh unavailable — fall through */ }
  if (state === 'MERGED') { advance(`PR #${info.id} merged — desk advanced to complete`, true); return { acted: true, note: 'merged → complete' }; }

  // Already armed on a prior pass — wait for the merge rather than re-running update-branch/arm.
  if (desk.buildGateArmed === true) return { acted: false, note: 'auto-merge already armed; waiting for merge' };

  const r = autoMergePr(rootDir, configFile);
  if (r.ok && r.merged) { advance(r.note, true); return { acted: true, note: r.note }; }
  if (r.ok) { advance(r.note, false); return { acted: true, note: r.note }; }
  return { acted: false, note: r.note }; // DIRTY/unmergeable — leave for rework
}

/** Start the periodic build-gate driver (gated internally to autonomous mode). */
export function startBuildGateDriver(rootDir: string, configFile: string): void {
  const POLL_MS = 30_000;
  setInterval(() => {
    try { driveDevopsBuildGate(rootDir, configFile); }
    catch (e) { console.warn('[build-gate-driver]', e instanceof Error ? e.message : String(e)); }
  }, POLL_MS);
}
