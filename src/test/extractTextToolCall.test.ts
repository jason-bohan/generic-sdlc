import { describe, it, expect } from 'vitest';
import { _extractTextToolCall } from '../server/agent-runner/AgentRunner';

describe('_extractTextToolCall', () => {
    describe('MLX <tools> block format (Qwen2.5-Coder via mlx_lm.server)', () => {
        it('extracts a tool call from a <tools> XML block', () => {
            const content = '<tools>\n{\n  "name": "list_directory",\n  "arguments": {\n    "path": "."\n  }\n}\n</tools>';
            const result = _extractTextToolCall(content);
            expect(result).not.toBeNull();
            expect(result!.function.name).toBe('list_directory');
            expect(JSON.parse(result!.function.arguments)).toEqual({ path: '.' });
            expect(result!.type).toBe('function');
        });

        it('handles <tools> block with surrounding text', () => {
            const content = 'Sure, I will list the directory.\n<tools>\n{"name": "list_directory", "arguments": {"path": "/tmp"}}\n</tools>';
            const result = _extractTextToolCall(content);
            expect(result).not.toBeNull();
            expect(result!.function.name).toBe('list_directory');
            expect(JSON.parse(result!.function.arguments)).toEqual({ path: '/tmp' });
        });

        it('handles <tools> block with inline JSON', () => {
            const content = '<tools>{"name": "read_file", "arguments": {"path": "src/index.ts"}}</tools>';
            const result = _extractTextToolCall(content);
            expect(result).not.toBeNull();
            expect(result!.function.name).toBe('read_file');
            expect(JSON.parse(result!.function.arguments)).toEqual({ path: 'src/index.ts' });
        });
    });

    describe('MeshLLM/llama.cpp markdown block format', () => {
        it('extracts a tool call from a ```json code block', () => {
            const content = '```json\n{"name": "run_command", "arguments": {"command": "ls -la"}}\n```';
            const result = _extractTextToolCall(content);
            expect(result).not.toBeNull();
            expect(result!.function.name).toBe('run_command');
            expect(JSON.parse(result!.function.arguments)).toEqual({ command: 'ls -la' });
        });

        it('extracts a tool call from a ``` code block without language tag', () => {
            const content = '```\n{"name": "write_file", "arguments": {"path": "out.txt", "content": "hello"}}\n```';
            const result = _extractTextToolCall(content);
            expect(result).not.toBeNull();
            expect(result!.function.name).toBe('write_file');
        });
    });

    describe('bare JSON fallback', () => {
        it('extracts a tool call from bare JSON in content', () => {
            const content = 'I will call the tool: {"name": "http_request", "arguments": {"url": "http://localhost:3001/api/status"}}';
            const result = _extractTextToolCall(content);
            expect(result).not.toBeNull();
            expect(result!.function.name).toBe('http_request');
        });

        it('accepts parameters as an alias for arguments', () => {
            const content = '{"name": "read_file", "parameters": {"path": "package.json"}}';
            const result = _extractTextToolCall(content);
            expect(result).not.toBeNull();
            expect(result!.function.name).toBe('read_file');
            expect(JSON.parse(result!.function.arguments)).toEqual({ path: 'package.json' });
        });
    });

    describe('non-matching content', () => {
        it('returns null for plain text with no JSON', () => {
            expect(_extractTextToolCall('I will help you with that.')).toBeNull();
        });

        it('returns null for JSON without a name field', () => {
            expect(_extractTextToolCall('{"action": "list", "path": "."}')).toBeNull();
        });

        it('returns null for empty string', () => {
            expect(_extractTextToolCall('')).toBeNull();
        });
    });
});
