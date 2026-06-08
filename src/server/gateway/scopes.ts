// Gateway scope model — the role→authority map made STRUCTURAL.
//
// Today an agent can call any handler; nothing stops the reviewer from calling
// complete_phase or devops from setting its own phase backward. Those were real
// bugs we patched with nudges/guards in AgentRunner + tools. This encodes the
// same intent as data: each role holds a fixed set of scopes, each gateway method
// requires one, and dispatch is default-deny. The grants below mirror the existing
// per-phase `ownerAgents` in shared/sdlcContracts.ts — read off the role model,
// not invented.

import type { SdlcAgentId } from '../../shared/sdlcContracts';

export type Scope =
  | 'story.read'       // observe story/workflow state — every role
  | 'story.implement'  // mutate code/dev phases — implementation agents
  | 'review.verdict'   // record an approve/changes-requested verdict — reviewer only
  | 'build.advance'    // advance the devops build chain / merge — devops only
  | 'orchestrate';     // assign stories, route, mark complete — orchestrator only

/** A caller is an SDLC agent, or a privileged human/system actor. */
export type CallerAgent = SdlcAgentId | 'human' | 'system';

/**
 * Role → granted scopes. THIS is the read-only guarantee: the reviewer has
 * `review.verdict` but never `story.implement` or `build.advance`, so a reviewer
 * calling an implement/build method is rejected by scope, not by prose.
 */
export const ROLE_SCOPES: Record<SdlcAgentId, ReadonlySet<Scope>> = {
  frontend: new Set(['story.read', 'story.implement']),
  backend: new Set(['story.read', 'story.implement']),
  qa: new Set(['story.read', 'story.implement']),
  ux: new Set(['story.read', 'story.implement']),
  reviewer: new Set(['story.read', 'review.verdict']),
  devops: new Set(['story.read', 'build.advance']),
  orchestrator: new Set(['story.read', 'orchestrate']),
  // aiqa owns implementation phases (analyzing/generating-code/validating per
  // sdlcContracts ownerAgents), so it advances phases like the dev roles.
  aiqa: new Set(['story.read', 'story.implement']),
};

/** Every scope — the authority a privileged human/system actor holds. */
export const ALL_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'story.read',
  'story.implement',
  'review.verdict',
  'build.advance',
  'orchestrate',
]);

/** Resolve the scope set for a caller. human/system are fully privileged. */
export function scopesForCaller(agent: CallerAgent): ReadonlySet<Scope> {
  if (agent === 'human' || agent === 'system') return ALL_SCOPES;
  return ROLE_SCOPES[agent] ?? new Set<Scope>();
}
