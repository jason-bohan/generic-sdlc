import { afterEach, describe, expect, it, vi } from 'vitest';
import { meshllmGenerateForClass, resolveModelForClass } from '../server/meshllmProvider';

describe('resolveModelForClass', () => {
    const originalDefaultModel = process.env.SDLC_FRAMEWORK_DEFAULT_MODEL;

    afterEach(() => {
        if (originalDefaultModel === undefined) delete process.env.SDLC_FRAMEWORK_DEFAULT_MODEL;
        else process.env.SDLC_FRAMEWORK_DEFAULT_MODEL = originalDefaultModel;
    });

    it('prefers the tuned edit model when it is available', () => {
        expect(resolveModelForClass('edit', ['qwen3:8b', 'sdlc-tuned'])).toBe('sdlc-tuned');
    });

    it('keeps the actual available model id casing', () => {
        expect(resolveModelForClass('edit', ['SDLC_FRAMEWORK-TUNED'])).toBe('SDLC_FRAMEWORK-TUNED');
    });

    it('chooses the strongest configured reason model by priority', () => {
        expect(resolveModelForClass('reason', ['Qwen3-8B', 'qwen3:32b', 'qwen3:14b'])).toBe('qwen3:14b');
    });

    it('falls back to the first available model when no class candidate matches', () => {
        expect(resolveModelForClass('fast', ['custom-local-model', 'another-model'])).toBe('custom-local-model');
    });

    it('uses SDLC_FRAMEWORK_DEFAULT_MODEL when MeshLLM has no models', () => {
        process.env.SDLC_FRAMEWORK_DEFAULT_MODEL = 'local-default';
        expect(resolveModelForClass('fast', [])).toBe('local-default');
    });
});

describe('meshllmGenerateForClass', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('requests the selected class model from MeshLLM', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url === 'http://localhost:9337/v1/models') {
                return new Response(JSON.stringify({
                    data: [
                        { id: 'Qwen3-8B', object: 'model' },
                        { id: 'sdlc-tuned', object: 'model' },
                    ],
                }), { status: 200 });
            }
            if (url === 'http://localhost:9337/v1/chat/completions') {
                const body = JSON.parse(String(init?.body));
                expect(body.model).toBe('sdlc-tuned');
                return new Response(JSON.stringify({
                    choices: [{ message: { content: 'patched' } }],
                    usage: { prompt_tokens: 5, completion_tokens: 2 },
                }), { status: 200 });
            }
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;
        global.fetch = fetchMock;

        const result = await meshllmGenerateForClass('edit', {
            prompt: 'fix the diff',
            maxTokens: 32,
            temperature: 0,
        });

        expect(result).toEqual({
            response: 'patched',
            model: 'sdlc-tuned',
            tokens: { input: 5, output: 2 },
            provider: 'meshllm',
        });
    });
});
