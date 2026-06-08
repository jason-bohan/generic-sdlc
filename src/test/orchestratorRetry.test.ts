import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseResetTime } from '../server/claude-print';
import {
  computeRetryDelayMs, scheduleRetry, cancelRetry, pendingRetryKeys,
  resumeRetries, loadPersistedRetries, type RetryAction,
} from '../server/orchestrator-retry';

const TMP = resolve(__dirname, '.orchestrator-retry-tmp');
const ACTION: RetryAction = { kind: 'author', goal: 'add a thing', autoAssign: false };

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

describe('scheduleRetry (persisted)', () => {
  beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
  afterEach(() => { for (const k of pendingRetryKeys()) cancelRetry(TMP, k); rmSync(TMP, { recursive: true, force: true }); });

  it('persists a record, fires the action, and removes the record', async () => {
    let fired = false;
    scheduleRetry({ rootDir: TMP, key: 'k', delayMs: 5, action: ACTION, execute: () => { fired = true; } });
    expect(pendingRetryKeys()).toContain('k');
    expect(loadPersistedRetries(TMP).map((r) => r.key)).toContain('k');
    await new Promise((r) => setTimeout(r, 25));
    expect(fired).toBe(true);
    expect(loadPersistedRetries(TMP)).toHaveLength(0);
  });

  it('replaces (does not stack) a retry for the same key', async () => {
    let count = 0;
    scheduleRetry({ rootDir: TMP, key: 'k', delayMs: 5, action: ACTION, execute: () => { count += 1; } });
    scheduleRetry({ rootDir: TMP, key: 'k', delayMs: 5, action: ACTION, execute: () => { count += 10; } });
    expect(loadPersistedRetries(TMP)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(count).toBe(10);
  });

  it('cancelRetry removes the timer and the persisted record', () => {
    scheduleRetry({ rootDir: TMP, key: 'k', delayMs: 10_000, action: ACTION, execute: () => { /* never */ } });
    expect(cancelRetry(TMP, 'k')).toBe(true);
    expect(pendingRetryKeys()).not.toContain('k');
    expect(loadPersistedRetries(TMP)).toHaveLength(0);
    expect(cancelRetry(TMP, 'missing')).toBe(false);
  });
});

describe('resumeRetries (survives restart)', () => {
  beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
  afterEach(() => { for (const k of pendingRetryKeys()) cancelRetry(TMP, k); rmSync(TMP, { recursive: true, force: true }); });

  it('reschedules a persisted retry whose fire time already passed (fires ~now)', async () => {
    // Simulate a record written before a "restart", already due.
    writeFileSync(resolve(TMP, '.orchestrator-retries.json'), JSON.stringify([
      { key: 'author:g', fireAt: Date.now() - 1000, action: ACTION },
    ]));
    const fired: RetryAction[] = [];
    const n = resumeRetries(TMP, (a) => { fired.push(a); });
    expect(n).toBe(1);
    await new Promise((r) => setTimeout(r, 2_200)); // RESUME_FLOOR_MS is ~2s
    expect(fired).toHaveLength(1);
    expect(fired[0].goal).toBe('add a thing');
    expect(loadPersistedRetries(TMP)).toHaveLength(0);
  });

  it('ignores a malformed retries file', () => {
    writeFileSync(resolve(TMP, '.orchestrator-retries.json'), 'not json');
    expect(resumeRetries(TMP, () => { /* none */ })).toBe(0);
  });
});
