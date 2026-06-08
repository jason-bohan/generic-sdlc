import { describe, expect, it, afterEach } from 'vitest';
import { parseResetTime } from '../server/claude-print';
import { computeRetryDelayMs, scheduleRetry, cancelRetry, pendingRetryKeys } from '../server/orchestrator-retry';

const NOW = Date.parse('2026-06-08T12:00:00.000Z');

describe('parseResetTime', () => {
  it('parses a unix epoch (seconds) near "reset"', () => {
    const at = Math.floor((NOW + 2 * 3600_000) / 1000); // +2h
    const out = parseResetTime(`5-hour limit reached · resets ${at}`, NOW);
    expect(out).toBe(new Date(at * 1000).toISOString());
  });

  it('parses an ISO timestamp', () => {
    const out = parseResetTime('Your limit resets at 2026-06-08T15:30:00Z.', NOW);
    expect(out).toBe('2026-06-08T15:30:00.000Z');
  });

  it('parses a relative "in N hours"', () => {
    const out = parseResetTime('usage limit reached, try again in 3 hours', NOW);
    expect(out).toBe(new Date(NOW + 3 * 3600_000).toISOString());
  });

  it('parses a clock time and rolls to the next occurrence when already passed', () => {
    // NOW is 12:00Z; "reset at 9am" already passed today → next day 09:00 local.
    const out = parseResetTime('limit reached. resets at 9am', NOW);
    expect(out).toBeDefined();
    expect(Date.parse(out!)).toBeGreaterThan(NOW);
  });

  it('returns undefined when no time is present or input is empty', () => {
    expect(parseResetTime('usage limit reached', NOW)).toBeUndefined();
    expect(parseResetTime('', NOW)).toBeUndefined();
  });
});

describe('computeRetryDelayMs', () => {
  it('targets the reset time (plus a small cushion)', () => {
    const retryAt = new Date(NOW + 90 * 60_000).toISOString(); // +90m
    const d = computeRetryDelayMs(retryAt, NOW);
    expect(d).toBeGreaterThan(90 * 60_000);
    expect(d).toBeLessThan(90 * 60_000 + 10_000);
  });

  it('falls back to the default when retryAt is missing/invalid', () => {
    expect(computeRetryDelayMs(undefined, NOW)).toBe(60 * 60 * 1000);
    expect(computeRetryDelayMs('not-a-date', NOW)).toBe(60 * 60 * 1000);
  });

  it('clamps below the 1m floor and above the 6h ceiling', () => {
    expect(computeRetryDelayMs(new Date(NOW - 10_000).toISOString(), NOW)).toBe(60 * 1000); // past → floor
    expect(computeRetryDelayMs(new Date(NOW + 99 * 3600_000).toISOString(), NOW)).toBe(6 * 60 * 60 * 1000); // far → ceiling
  });
});

describe('scheduleRetry', () => {
  afterEach(() => { for (const k of pendingRetryKeys()) cancelRetry(k); });

  it('tracks a pending retry and fires it', async () => {
    let fired = false;
    scheduleRetry('k', 5, () => { fired = true; });
    expect(pendingRetryKeys()).toContain('k');
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(true);
    expect(pendingRetryKeys()).not.toContain('k');
  });

  it('replaces (does not stack) a retry for the same key', async () => {
    let count = 0;
    scheduleRetry('k', 5, () => { count += 1; });
    scheduleRetry('k', 5, () => { count += 10; }); // replaces the first
    await new Promise((r) => setTimeout(r, 20));
    expect(count).toBe(10);
  });

  it('cancelRetry removes a pending retry', () => {
    scheduleRetry('k', 10_000, () => { /* never */ });
    expect(cancelRetry('k')).toBe(true);
    expect(pendingRetryKeys()).not.toContain('k');
    expect(cancelRetry('missing')).toBe(false);
  });
});
