// Gateway method registry + default-deny dispatch.
//
// A single namespace of named methods (e.g. 'review.recordVerdict',
// 'workflow.completePhase', 'build.advance') replaces the scattered, ungated
// /api/* handlers. Every method carries a required Scope and an optional owner
// list; dispatch refuses any call whose caller lacks the scope (or isn't an
// owner). Duplicate names are rejected at construction so authorization and
// dispatch can never disagree about a method's owner/scope.
//
// Pattern adapted from OpenClaw's gateway/methods/registry.ts (control-plane
// spine + default-deny), fitted to our SdlcAgentId role model.

import type { SdlcAgentId } from '../../shared/sdlcContracts';
import { type CallerAgent, type Scope, scopesForCaller } from './scopes';

/** The actor making a call, with its resolved scope set. */
export interface Caller {
  agentId: CallerAgent;
  scopes: ReadonlySet<Scope>;
}

/** Build a Caller from an agent id, resolving its scopes from the role model. */
export function makeCaller(agentId: CallerAgent): Caller {
  return { agentId, scopes: scopesForCaller(agentId) };
}

export type MethodHandler = (params: unknown, caller: Caller) => unknown | Promise<unknown>;

export interface MethodDescriptor {
  /** Unique method name, namespaced by domain, e.g. 'workflow.completePhase'. */
  name: string;
  handler: MethodHandler;
  /** Scope the caller must hold to invoke this method. */
  scope: Scope;
  /** Mutates story/workflow state — blocked when dispatch runs read-only. */
  controlPlaneWrite?: boolean;
  /**
   * Optional hard role restriction layered on top of the scope check (mirrors a
   * phase's `ownerAgents`). human/system bypass it; an agent must be listed.
   */
  owners?: readonly SdlcAgentId[];
}

export type DispatchError =
  | { code: 'UNKNOWN_METHOD'; message: string }
  | { code: 'FORBIDDEN'; message: string }
  | { code: 'READ_ONLY'; message: string };

export type DispatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: DispatchError };

export interface MethodRegistry {
  getHandler(name: string): MethodHandler | undefined;
  getDescriptor(name: string): MethodDescriptor | undefined;
  /** All method names. */
  list(): string[];
  dispatch(name: string, params: unknown, caller: Caller, opts?: DispatchOptions): Promise<DispatchResult>;
}

export interface DispatchOptions {
  /** When true, reject controlPlaneWrite methods (e.g. global step-mode pause). */
  readOnly?: boolean;
}

/**
 * Build a read-only registry. Throws on an empty or duplicate method name —
 * fail fast, before any caller can hit an ambiguous authorization decision.
 */
export function createRegistry(descriptors: readonly MethodDescriptor[]): MethodRegistry {
  const byName = new Map<string, MethodDescriptor>();
  for (const d of descriptors) {
    const name = d.name.trim();
    if (!name) throw new Error('gateway method descriptor name must not be empty');
    if (byName.has(name)) throw new Error(`gateway method already registered: ${name}`);
    byName.set(name, { ...d, name });
  }

  return {
    getHandler: (name) => byName.get(name)?.handler,
    getDescriptor: (name) => byName.get(name),
    list: () => [...byName.keys()],

    async dispatch(name, params, caller, opts) {
      const d = byName.get(name);
      if (!d) {
        return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `unknown method: ${name}` } };
      }
      // Default-deny: the caller must explicitly hold the method's scope.
      if (!caller.scopes.has(d.scope)) {
        return {
          ok: false,
          error: { code: 'FORBIDDEN', message: `${caller.agentId} lacks scope '${d.scope}' for ${name}` },
        };
      }
      // Optional owner restriction (human/system are privileged and bypass it).
      if (d.owners && caller.agentId !== 'human' && caller.agentId !== 'system'
        && !d.owners.includes(caller.agentId)) {
        return {
          ok: false,
          error: { code: 'FORBIDDEN', message: `${name} is owned by ${d.owners.join('/')}, not ${caller.agentId}` },
        };
      }
      // Read-only mode (e.g. step-mode pause) blocks state mutations.
      if (opts?.readOnly && d.controlPlaneWrite) {
        return { ok: false, error: { code: 'READ_ONLY', message: `${name} blocked: gateway is read-only` } };
      }
      return { ok: true, value: await d.handler(params, caller) };
    },
  };
}
