import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';
import { updateTokens, defaultTokenState } from '../server/tokens';

/**
 * Tests that dashboard code handles missing/null fields gracefully.
 * These mirror the patterns used in Floor3D mainframe stats and AgentDetail.
 */

describe('null-safety patterns', () => {
    const makeStatus = (overrides: Record<string, any> = {}) => ({
        storyNumber: null,
        storyName: null,
        currentPhase: 'idle',
        currentTask: null,
        startedAt: null,
        tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 } },
        tasks: [],
        prs: [],
        cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
        events: [],
        ...overrides,
    });

    describe('mainframe stats aggregation', () => {
        it('handles status with missing tokens', () => {
            const statuses: Record<string, any> = {
                frontend: makeStatus({ tokens: { cloud: { input: 100, output: 50 }, meshllm: { input: 0, output: 0 }, ollama: { input: 10, output: 5 } } }),
                reviewer: makeStatus({ tokens: undefined }),
                backend: null,
            };

            const cloudTotal = Object.values(statuses).reduce(
                (sum: number, s: any) => sum + (s?.tokens?.cloud?.input ?? 0) + (s?.tokens?.cloud?.output ?? 0), 0);
            expect(cloudTotal).toBe(150);

            const ollamaTotal = Object.values(statuses).reduce(
                (sum: number, s: any) => sum + (s?.tokens?.ollama?.input ?? 0) + (s?.tokens?.ollama?.output ?? 0), 0);
            expect(ollamaTotal).toBe(15);
        });

        it('handles status with missing tasks array', () => {
            const statuses: Record<string, any> = {
                frontend: makeStatus({ tasks: [{ status: 'in_progress' }, { status: 'completed' }] }),
                reviewer: makeStatus({ tasks: undefined }),
            };

            const activeTasks = Object.values(statuses).reduce(
                (sum: number, s: any) => sum + (s?.tasks?.filter((t: any) => t.status === 'in_progress')?.length ?? 0), 0);
            expect(activeTasks).toBe(1);
        });

        it('handles status with missing prs array', () => {
            const statuses: Record<string, any> = {
                frontend: makeStatus({ prs: [{ status: 'active' }, { status: 'completed' }] }),
                reviewer: makeStatus({ prs: undefined }),
            };

            const openPrs = Object.values(statuses).reduce(
                (sum: number, s: any) => sum + (s?.prs?.filter((p: any) => p.status === 'active')?.length ?? 0), 0);
            expect(openPrs).toBe(1);
        });

        it('handles status with missing cypress', () => {
            const statuses: Record<string, any> = {
                frontend: makeStatus({ cypress: { lastRun: '2026-05-01', total: 5, passed: 4, failed: 1, skipped: 0, failures: [] } }),
                reviewer: makeStatus({ cypress: undefined }),
            };

            const cy = Object.values(statuses).find((s: any) => s?.cypress?.lastRun)?.cypress;
            expect(cy).toBeDefined();
            expect(cy.passed).toBe(4);
        });
    });

    describe('AgentDetail null-safety', () => {
        it('handles task.hours being undefined', () => {
            const tasks = [
                { number: 'TK-1', name: 'Task 1', status: 'completed', hours: undefined },
                { number: 'TK-2', name: 'Task 2', status: 'in_progress', hours: 3 },
            ];

            const totalHours = tasks.reduce((sum, t) => sum + ((t as any).hours ?? 0), 0);
            expect(totalHours).toBe(3);
        });

        it('normalizes complete to completed for task status', () => {
            const taskStatus = 'complete';
            const normalized = taskStatus === 'complete' ? 'completed' : taskStatus;
            expect(normalized).toBe('completed');
        });

        it('handles events not being an array', () => {
            const status = makeStatus({ events: undefined });
            const events = Array.isArray(status.events) ? status.events : [];
            expect(events).toEqual([]);
        });

        it('handles events being null', () => {
            const status = makeStatus({ events: null });
            const events = Array.isArray(status.events) ? status.events : [];
            expect(events).toEqual([]);
        });
    });

    describe('updateTokens cloud backfill', () => {
        const TMP_DIR = __dirname;
        const AGENT = 'null-test-agent';
        const STATUS_FILE = resolve(TMP_DIR, `.${AGENT}-status.json`);

        afterEach(() => {
            if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
        });

        it('backfills missing tokens.cloud to { input: 0, output: 0 } before accumulation', () => {
            writeFileSync(STATUS_FILE, JSON.stringify({
                storyNumber: 'B-100',
                tokens: { ollama: { input: 50, output: 20 } },
            }, null, 2));

            const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 100, output: 40 });
            expect(r.ok).toBe(true);
            expect(r.tokens?.cloud.input).toBe(100);
            expect(r.tokens?.cloud.output).toBe(40);
            expect(r.tokens?.ollama.input).toBe(50);
            expect(r.tokens?.ollama.output).toBe(20);
        });

        it('backfills entirely missing tokens object before cloud accumulation', () => {
            writeFileSync(STATUS_FILE, JSON.stringify({ storyNumber: 'B-200' }, null, 2));

            const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 75, output: 30 });
            expect(r.ok).toBe(true);
            expect(r.tokens?.cloud.input).toBe(75);
            expect(r.tokens?.cloud.output).toBe(30);
            expect(r.tokens?.ollama.input).toBe(0);
            expect(r.tokens?.ollama.output).toBe(0);
        });
    });
});
