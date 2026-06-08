import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'path';
import { createRegistry, makeCaller, type MethodDescriptor } from '../server/gateway/registry';
import { ROLE_SCOPES, scopesForCaller } from '../server/gateway/scopes';
import { authorizeToolCall } from '../server/gateway/tool-authz';
import { executeToolCall } from '../server/agent-runner/tools';

// A small method set mirroring the real bug-class surface:
//  - review.recordVerdict : reviewer-only, mutating
//  - workflow.completePhase: implementation agents, mutating
//  - build.advance        : devops-only, mutating
//  - story.describe       : everyone, read-only
function methods(handler = vi.fn(async () => 'ok')): MethodDescriptor[] {
  return [
    { name: 'review.recordVerdict', handler, scope: 'review.verdict', controlPlaneWrite: true, owners: ['reviewer'] },
    { name: 'workflow.completePhase', handler, scope: 'story.implement', controlPlaneWrite: true, owners: ['backend', 'frontend', 'qa', 'ux'] },
    { name: 'build.advance', handler, scope: 'build.advance', controlPlaneWrite: true, owners: ['devops'] },
    { name: 'story.describe', handler, scope: 'story.read' },
  ];
}

describe('gateway registry — construction', () => {
  it('rejects an empty method name', () => {
    expect(() => createRegistry([{ name: '  ', handler: vi.fn(), scope: 'story.read' }]))
      .toThrow(/name must not be empty/);
  });

  it('rejects a duplicate method name (authorization/dispatch must not disagree)', () => {
    expect(() => createRegistry([
      { name: 'workflow.completePhase', handler: vi.fn(), scope: 'story.implement' },
      { name: 'workflow.completePhase', handler: vi.fn(), scope: 'story.read' },
    ])).toThrow(/already registered/);
  });

  it('lists registered methods and exposes handlers', () => {
    const reg = createRegistry(methods());
    expect(reg.list().sort()).toEqual(
      ['build.advance', 'review.recordVerdict', 'story.describe', 'workflow.completePhase'],
    );
    expect(reg.getHandler('story.describe')).toBeTypeOf('function');
    expect(reg.getHandler('nope')).toBeUndefined();
  });
});

describe('gateway dispatch — default-deny scope enforcement', () => {
  it('rejects an unknown method', async () => {
    const reg = createRegistry(methods());
    const r = await reg.dispatch('does.not.exist', {}, makeCaller('backend'));
    expect(r).toMatchObject({ ok: false, error: { code: 'UNKNOWN_METHOD' } });
  });

  it('THE bug class: a reviewer cannot call workflow.completePhase (no story.implement scope)', async () => {
    const handler = vi.fn(async () => 'ran');
    const reg = createRegistry(methods(handler));
    const r = await reg.dispatch('workflow.completePhase', {}, makeCaller('reviewer'));
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(handler).not.toHaveBeenCalled(); // rejected BEFORE the handler runs
  });

  it('a reviewer CAN record a verdict (has review.verdict scope + is the owner)', async () => {
    const handler = vi.fn(async () => 'approved');
    const reg = createRegistry(methods(handler));
    const r = await reg.dispatch('review.recordVerdict', { verdict: 'approved' }, makeCaller('reviewer'));
    expect(r).toEqual({ ok: true, value: 'approved' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('an implementation agent CAN complete a phase', async () => {
    const reg = createRegistry(methods());
    const r = await reg.dispatch('workflow.completePhase', {}, makeCaller('backend'));
    expect(r).toMatchObject({ ok: true });
  });

  it('devops cannot record a review verdict (no review.verdict scope)', async () => {
    const reg = createRegistry(methods());
    const r = await reg.dispatch('review.recordVerdict', {}, makeCaller('devops'));
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('every role can read story state', async () => {
    const reg = createRegistry(methods());
    for (const agent of Object.keys(ROLE_SCOPES) as Array<keyof typeof ROLE_SCOPES>) {
      const r = await reg.dispatch('story.describe', {}, makeCaller(agent));
      expect(r.ok).toBe(true);
    }
  });
});

describe('gateway dispatch — owner restriction', () => {
  it('enforces owners even when the caller holds the scope', async () => {
    // story.read is held by everyone; restrict an otherwise-readable method to orchestrator.
    const reg = createRegistry([
      { name: 'orchestrator.markComplete', handler: vi.fn(async () => 'done'), scope: 'story.read', owners: ['orchestrator'] },
    ]);
    expect((await reg.dispatch('orchestrator.markComplete', {}, makeCaller('backend'))).ok).toBe(false);
    expect((await reg.dispatch('orchestrator.markComplete', {}, makeCaller('orchestrator'))).ok).toBe(true);
  });
});

describe('gateway dispatch — privileged + read-only', () => {
  it('human/system bypass scope and owner checks', async () => {
    const reg = createRegistry(methods());
    for (const actor of ['human', 'system'] as const) {
      expect((await reg.dispatch('build.advance', {}, makeCaller(actor))).ok).toBe(true);
      expect((await reg.dispatch('review.recordVerdict', {}, makeCaller(actor))).ok).toBe(true);
    }
  });

  it('read-only mode blocks controlPlaneWrite methods but allows reads', async () => {
    const reg = createRegistry(methods());
    const write = await reg.dispatch('workflow.completePhase', {}, makeCaller('backend'), { readOnly: true });
    expect(write).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
    const read = await reg.dispatch('story.describe', {}, makeCaller('backend'), { readOnly: true });
    expect(read.ok).toBe(true);
  });
});

describe('tool authorization (authorizeToolCall)', () => {
  it('denies a reviewer complete_phase, allows implementation/devops/orchestrator', () => {
    expect(authorizeToolCall('reviewer', 'complete_phase').ok).toBe(false);
    for (const role of ['backend', 'frontend', 'qa', 'ux', 'aiqa', 'devops', 'orchestrator']) {
      expect(authorizeToolCall(role, 'complete_phase').ok).toBe(true);
    }
  });

  it('does not gate non-workflow tools for any role', () => {
    for (const tool of ['read_file', 'search_in_files', 'update_status', 'run_command']) {
      expect(authorizeToolCall('reviewer', tool).ok).toBe(true);
    }
  });
});

describe('tool authorization is LIVE at the executeToolCall boundary', () => {
  it('refuses a reviewer complete_phase before any execution (no status file needed)', async () => {
    const TMP = resolve(__dirname, '.gateway-authz-tmp');
    const out = await executeToolCall('complete_phase', { next_phase: 'complete' }, TMP, TMP, 'reviewer', resolve(TMP, 'cfg.json'));
    expect(out).toMatch(/^Refused:/);
    expect(out).toMatch(/not authorized to complete_phase/);
  });
});

describe('scope model', () => {
  it('reviewer is read-only w.r.t. implementation and build', () => {
    const s = scopesForCaller('reviewer');
    expect(s.has('review.verdict')).toBe(true);
    expect(s.has('story.implement')).toBe(false);
    expect(s.has('build.advance')).toBe(false);
  });

  it('devops owns build but cannot implement or review', () => {
    const s = scopesForCaller('devops');
    expect(s.has('build.advance')).toBe(true);
    expect(s.has('story.implement')).toBe(false);
    expect(s.has('review.verdict')).toBe(false);
  });
});
