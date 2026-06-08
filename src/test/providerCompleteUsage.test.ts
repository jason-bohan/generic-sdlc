import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider, detectLoopProvider } from '../server/agent-runner/provider';

// Mock generateText from the ai SDK — must use vi.hoisted before vi.mock (hoisted to top)
const mockGenerateText = vi.hoisted(() => vi.fn());
vi.mock('ai', async () => {
    const actual = await vi.importActual('ai');
    return {
        ...actual,
        generateText: mockGenerateText,
    };
});

afterEach(() => { vi.restoreAllMocks(); });

// model:'auto' short-circuits resolveModel() so only the chat/completions call fires.
const provider = () => new OpenAICompatibleProvider({ baseUrl: 'http://localhost:8083/v1', model: 'auto' });

describe('OpenAICompatibleProvider.complete — usage', () => {
    it('surfaces the OpenAI-compatible usage object as normalized input/output tokens', async () => {
        mockGenerateText.mockResolvedValueOnce({
            text: 'hi',
            toolCalls: undefined,
            finishReason: 'stop',
            usage: { inputTokens: 34, outputTokens: 2 },
        });
        const res = await provider().complete([{ role: 'user', content: 'hi' }], []);
        expect(res.usage).toEqual({ inputTokens: 34, outputTokens: 2 });
    });

    it('tolerates a partial usage object (missing counts default to 0)', async () => {
        mockGenerateText.mockResolvedValueOnce({
            text: 'x',
            toolCalls: undefined,
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: undefined },
        });
        const res = await provider().complete([{ role: 'user', content: 'x' }], []);
        expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
    });

    it('leaves usage undefined when the backend reports none', async () => {
        mockGenerateText.mockResolvedValueOnce({
            text: 'x',
            toolCalls: undefined,
            finishReason: 'stop',
            usage: undefined,
        });
        const res = await provider().complete([{ role: 'user', content: 'x' }], []);
        expect(res.usage).toBeUndefined();
    });

    it('maps tool calls from generateText result', async () => {
        mockGenerateText.mockResolvedValueOnce({
            text: null,
            toolCalls: [
                { toolCallId: 'call_1', toolName: 'read_file', input: { path: 'src/index.ts' } },
            ],
            finishReason: 'tool-calls',
            usage: undefined,
        });
        const res = await provider().complete(
            [{ role: 'user', content: 'read file' }],
            [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
        );
        expect(res.message.tool_calls).toHaveLength(1);
        expect(res.message.tool_calls![0].function.name).toBe('read_file');
        expect(res.message.tool_calls![0].function.arguments).toBe(JSON.stringify({ path: 'src/index.ts' }));
        expect(res.finish_reason).toBe('tool_calls');
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
