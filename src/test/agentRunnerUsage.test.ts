import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { AgentRunner } from '../server/agent-runner/AgentRunner';
import type { CompletionResponse, RunnerEvent } from '../server/agent-runner/types';

/**
 * Fake provider that returns plain text (no tool calls) with a fixed usage object
 * on every turn, and counts how many times complete() is called. AgentRunner only
 * ever calls provider.complete(), so this is enough to drive a real run.
 */
function fakeProvider(perCall: { inputTokens: number; outputTokens: number }) {
    let calls = 0;
    return {
        get calls() { return calls; },
        async complete(): Promise<CompletionResponse> {
            calls++;
            return {
                message: { role: 'assistant', content: 'Done — no further action needed.' },
                finish_reason: 'stop',
                usage: perCall,
            };
        },
    };
}

describe('AgentRunner token usage', () => {
    it('accumulates per-turn usage and reports the total on the complete event', async () => {
        const provider = fakeProvider({ inputTokens: 100, outputTokens: 20 });
        const dir = resolve(tmpdir(), `agent-runner-usage-${Date.now()}`);
        const runner = new AgentRunner('backend', provider as never, dir, dir, resolve(dir, 'config.json'));

        const completeEvt = await new Promise<RunnerEvent>((res) => {
            runner.on('complete', (ev: RunnerEvent) => res(ev));
            void runner.run('system', 'Run SDLC phase "analyzing"');
        });

        const usage = (completeEvt.data as { usage?: { input: number; output: number } }).usage;
        expect(usage).toBeDefined();
        expect(provider.calls).toBeGreaterThan(0);
        // Total must equal per-call usage summed across every completion in the run.
        expect(usage!.input).toBe(100 * provider.calls);
        expect(usage!.output).toBe(20 * provider.calls);
    });

    it('reports zero usage when the provider reports none (no ledger row will be written)', async () => {
        const provider = {
            async complete(): Promise<CompletionResponse> {
                return { message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' };
            },
        };
        const dir = resolve(tmpdir(), `agent-runner-nousage-${Date.now()}`);
        const runner = new AgentRunner('backend', provider as never, dir, dir, resolve(dir, 'config.json'));

        const completeEvt = await new Promise<RunnerEvent>((res) => {
            runner.on('complete', (ev: RunnerEvent) => res(ev));
            void runner.run('system', 'Run SDLC phase "analyzing"');
        });

        const usage = (completeEvt.data as { usage?: { input: number; output: number } }).usage;
        expect(usage).toEqual({ input: 0, output: 0 });
    });
});
