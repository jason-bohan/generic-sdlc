import { describe, expect, it } from 'vitest';
import { isCapablePromptModel } from '../server/agent-runner/registry';

const LOCAL_MLX = 'http://localhost:8083/v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';

describe('isCapablePromptModel (promptLatitude tier)', () => {
    it('keeps small local models strict (no latitude)', () => {
        expect(isCapablePromptModel('mlx-community/Qwen2.5-Coder-14B-Instruct-4bit', LOCAL_MLX)).toBe(false);
        expect(isCapablePromptModel('qwen2.5-coder:7b', LOCAL_MLX)).toBe(false);
        expect(isCapablePromptModel('codellama-13b', LOCAL_MLX)).toBe(false);
    });

    it('grants latitude to large local models', () => {
        expect(isCapablePromptModel('mlx-community/Qwen2.5-Coder-32B-Instruct-4bit', LOCAL_MLX)).toBe(true);
    });

    it('grants latitude to any openrouter-served model', () => {
        expect(isCapablePromptModel('deepseek/deepseek-v3.2', OPENROUTER)).toBe(true);
        // openrouter provider alone is enough, regardless of model name
        expect(isCapablePromptModel('some-unknown-model', OPENROUTER)).toBe(true);
    });

    it('grants latitude to known capable cloud families by name', () => {
        for (const m of ['claude-opus-4-8', 'gpt-4o', 'gpt-5', 'gemini-2.0-pro', 'o3-mini', 'deepseek-chat']) {
            expect(isCapablePromptModel(m, LOCAL_MLX), m).toBe(true);
        }
    });
});
