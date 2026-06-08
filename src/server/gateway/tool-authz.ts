// Gateway tool authorization — the scope model made load-bearing at the agent
// tool boundary. Every agent tool call passes through authorizeToolCall before
// it executes; workflow-mutating tools are gated by role scope, default-allow
// for the rest. This turns the reviewer-can't-advance-a-phase guarantee from a
// corrective AgentRunner nudge into a structural deny that no model can wander
// around — and generalizes it to any role/tool mismatch.

import { scopesForCaller, type CallerAgent, type Scope } from './scopes';

/** Scopes that authorize advancing a workflow phase via complete_phase. */
const WORKFLOW_ADVANCE_SCOPES: readonly Scope[] = ['story.implement', 'build.advance', 'orchestrate'];

export type ToolAuthz = { ok: true } | { ok: false; reason: string };

/**
 * Authorize an agent tool call against the role scope model. Only the
 * workflow-mutating tools are gated; everything else is allowed (read tools,
 * search, status refresh, etc. are open to every role). Returns a refusal reason
 * the model can act on when denied.
 */
export function authorizeToolCall(agentId: string, toolName: string): ToolAuthz {
  switch (toolName) {
    case 'complete_phase': {
      // Advancing a workflow phase requires a workflow-driving scope. The reviewer
      // holds only review.verdict + story.read, so it is structurally denied —
      // it records its decision with update_status{verdict} instead.
      const scopes = scopesForCaller(agentId as CallerAgent);
      if (WORKFLOW_ADVANCE_SCOPES.some((s) => scopes.has(s))) return { ok: true };
      return {
        ok: false,
        reason: `${agentId} is not authorized to complete_phase. Reviewers do not advance workflow phases — record your decision with update_status{verdict:"approved"|"changes-requested"}. Only implementation, devops, and orchestrator roles advance phases.`,
      };
    }
    default:
      return { ok: true };
  }
}
