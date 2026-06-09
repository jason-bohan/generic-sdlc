// Loop run-state — the autonomous "brake".
//
// The orchestrator has no desk (it coordinates, it doesn't work a workflow), but the autonomous
// LOOP needs a control plane: a way to pause/resume/stop the whole fleet that's distinct from
// step mode (which is "approve at each gate", not a halt) and from reset-to-idle (which nukes
// all desk state). This is run-state, not a desk — fully compatible with "no orchestrator desk".
//
// A single flag, checked by every autonomous trigger (assign-loop tick, auto-continue/respawn,
// handoff auto-spawns, build-gate driver). When not 'running', none of them fire — in-flight
// desk state is preserved and the loop resumes exactly where it left off.

import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { parseJsonUtf8File } from './json-file';

export type LoopState = 'running' | 'paused' | 'stopped';

function stateFile(rootDir: string): string {
  return resolve(rootDir, '.sdlc-framework', 'loop-state.json');
}

/** Current loop state. Absent file = 'running' (the loop is on by default). Never throws. */
export function getLoopState(rootDir: string): LoopState {
  const f = stateFile(rootDir);
  if (!existsSync(f)) return 'running';
  try {
    const raw = (parseJsonUtf8File(f) as { state?: string }).state;
    return raw === 'paused' || raw === 'stopped' ? raw : 'running';
  } catch {
    return 'running';
  }
}

/** Persist the loop state. */
export function setLoopState(rootDir: string, state: LoopState): void {
  const dir = resolve(rootDir, '.sdlc-framework');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(rootDir), JSON.stringify({ state, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * The gate every autonomous trigger checks. Only 'running' lets the loop act; 'paused' and
 * 'stopped' both freeze it (in-flight work is left untouched, resumable on 'running').
 */
export function isLoopActive(rootDir: string): boolean {
  return getLoopState(rootDir) === 'running';
}
