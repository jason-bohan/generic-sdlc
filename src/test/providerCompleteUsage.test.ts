import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider, detectLoopProvider } from '../server/agent-runner/provider';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function mockChatResponse(body: object) {
    global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch;
}

// model:'auto' short-circuits resolveModel() so only the chat/completions call fires.
const provider = () => new OpenAICompatibleProvider({ baseUrl: 'http://localhost:8083/v1', model: 'auto' });

describe('OpenAICompatibleProvider.complete — usage', () => {
    it('surfaces the OpenAI-compatible usage object as normalized input/output tokens', async () => {
        mockChatResponse({
            choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 34, completion_tokens: 2, total_tokens: 36 },
        });
        const res = await provider().complete([{ role: 'user', content: 'hi' }], []);
        expect(res.usage).toEqual({ inputTokens: 34, outputTokens: 2 });
    });

    it('tolerates a partial usage object (missing counts default to 0)', async () => {
        mockChatResponse({
            choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10 },
        });
        const res = await provider().complete([{ role: 'user', content: 'x' }], []);
        expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
    });

    it('leaves usage undefined when the backend reports none', async () => {
        mockChatResponse({
            choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
        });
        const res = await provider().complete([{ role: 'user', content: 'x' }], []);
        expect(res.usage).toBeUndefined();
    });
});

describe('detectLoopProvider — backend buckets the ledger relies on', () => {
    it('maps the MLX local ports (8082/8083) to mlx', () => {
        expect(detectLoopProvider('http://localhost:8083/v1')).toBe('mlx');
        expect(detectLoopProvider('http://localhost:8082/v1')).toBe('mlx');
    });
    it('maps openrouter to its cloud bucket and meshllm/ollama to their own', () => {
        expect(detectLoopProvider('https://openrouter.ai/api/v1')).toBe('openrouter');
        expect(detectLoopProvider('http://localhost:9337/v1')).toBe('meshllm');
        expect(detectLoopProvider('http://localhost:11434/v1')).toBe('ollama');
    });
});
