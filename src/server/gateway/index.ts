// Gateway: a scoped, default-deny method registry over the SDLC agent roles.
// See registry.ts (dispatch) and scopes.ts (role→authority model).
export type { Scope, CallerAgent } from './scopes';
export { ROLE_SCOPES, ALL_SCOPES, scopesForCaller } from './scopes';
export type {
  Caller,
  MethodHandler,
  MethodDescriptor,
  MethodRegistry,
  DispatchResult,
  DispatchError,
  DispatchOptions,
} from './registry';
export { createRegistry, makeCaller } from './registry';
