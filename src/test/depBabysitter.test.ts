import { describe, expect, it } from 'vitest';
import { classifyDepPr } from '../server/dep-babysitter';

describe('classifyDepPr', () => {
  it('Dependabot title: minor/patch within a major is safe', () => {
    expect(classifyDepPr('Bump express from 4.18.2 to 4.19.0', '')).toBe('safe');
    expect(classifyDepPr('Bump @types/node from 24.1.0 to 24.3.1', '')).toBe('safe');
  });

  it('Dependabot title: a major crossing is blocked', () => {
    expect(classifyDepPr('Bump react from 18.2.0 to 19.0.0', '')).toBe('major');
    expect(classifyDepPr('Bump @types/node from 24.1.0 to 25.9.2', '')).toBe('major');
  });

  it('Renovate body Change column: parses the version delta', () => {
    // real-shape rows from Renovate PR bodies
    const minor = '| [pkg](url) | [`1.170.10` → `1.170.15`](diff) |';
    const major = '| [datasets](url) | `==4.8.5` → `==5.0.0` |';
    expect(classifyDepPr('chore(deps): update tanstack to v1.170.15', minor)).toBe('safe');
    expect(classifyDepPr('chore(deps): update dependency datasets to v5', major)).toBe('major');
  });

  it('treats 0.x minor bumps as non-major (CI is the safety net), but 0.x → 1.x as major', () => {
    expect(classifyDepPr('Bump safetensors from 0.7.0 to 0.8.0', '')).toBe('safe');
    expect(classifyDepPr('Bump foo from 0.9.0 to 1.0.0', '')).toBe('major');
  });

  it('grouped Dependabot PRs: versions parsed from the body (incl. a major)', () => {
    // real-shape grouped Dependabot body — versions are in the body, not the title
    const body = 'Bumps [vite] and [@vitejs/plugin-react]. These needed to be updated together.\nUpdates `vite` from 5.4.21 to 8.0.16\nUpdates `@vitejs/plugin-react` from 4.0.0 to 4.3.0';
    expect(classifyDepPr('chore(deps-dev): bump vite and @vitejs/plugin-react', body)).toBe('major');

    const safeBody = 'Updates `esbuild` from 0.21.0 to 0.21.5\nUpdates `vite` from 5.4.0 to 5.4.21';
    expect(classifyDepPr('chore(deps): bump esbuild and vite', safeBody)).toBe('safe');
  });

  it('truly unparseable updates are unknown (not auto-merged)', () => {
    expect(classifyDepPr('Bump the npm group with 3 updates', 'just a description, no versions')).toBe('unknown');
    expect(classifyDepPr('chore(deps): update something', 'no versions here')).toBe('unknown');
  });

  it('any major in a multi-package PR blocks the whole PR', () => {
    const body = '| a | `1.0.0` → `1.2.0` |\n| b | `2.0.0` → `3.0.0` |';
    expect(classifyDepPr('group update', body)).toBe('major');
  });
});
