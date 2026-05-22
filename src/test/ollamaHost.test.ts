/**
 * Tests for ollamaHost() normalization in ollamaManager.
 *
 * This function has two consumers: ollamaManager itself and help-chat.ts
 * (which imports it directly). The root bug this covers was OLLAMA_HOST=0.0.0.0
 * being used as a raw URL, causing fetch() to throw "Failed to parse URL".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ollamaHost } from '../server/ollamaManager';

describe('ollamaHost() normalization', () => {
    let savedEnv: string | undefined;

    beforeEach(() => { savedEnv = process.env.OLLAMA_HOST; });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.OLLAMA_HOST;
        else process.env.OLLAMA_HOST = savedEnv;
    });

    it('returns http://localhost:11434 when OLLAMA_HOST is unset', () => {
        delete process.env.OLLAMA_HOST;
        expect(ollamaHost()).toBe('http://localhost:11434');
    });

    it('converts bare 0.0.0.0 to http://127.0.0.1:11434', () => {
        // This was the root bug: OLLAMA_HOST=0.0.0.0 is a valid bind address
        // for ollama serve but not a valid fetch() destination on any OS.
        process.env.OLLAMA_HOST = '0.0.0.0';
        expect(ollamaHost()).toBe('http://127.0.0.1:11434');
    });

    it('converts 0.0.0.0:11434 to http://127.0.0.1:11434', () => {
        process.env.OLLAMA_HOST = '0.0.0.0:11434';
        expect(ollamaHost()).toBe('http://127.0.0.1:11434');
    });

    it('converts http://0.0.0.0:11434 to http://127.0.0.1:11434', () => {
        process.env.OLLAMA_HOST = 'http://0.0.0.0:11434';
        expect(ollamaHost()).toBe('http://127.0.0.1:11434');
    });

    it('adds http:// when protocol is missing', () => {
        process.env.OLLAMA_HOST = 'localhost';
        expect(ollamaHost()).toBe('http://localhost:11434');
    });

    it('adds port 11434 when host has no port', () => {
        process.env.OLLAMA_HOST = 'http://myhost';
        expect(ollamaHost()).toBe('http://myhost:11434');
    });

    it('preserves custom host and port', () => {
        process.env.OLLAMA_HOST = 'http://ollama-container:11434';
        expect(ollamaHost()).toBe('http://ollama-container:11434');
    });

    it('preserves custom port on localhost', () => {
        process.env.OLLAMA_HOST = 'http://localhost:21434';
        expect(ollamaHost()).toBe('http://localhost:21434');
    });

    it('returns http://localhost:11434 on completely invalid value', () => {
        process.env.OLLAMA_HOST = 'not a url at all :::';
        // Should fall back rather than throw
        const result = ollamaHost();
        expect(result).toMatch(/^http:\/\//);
        expect(() => new URL(result)).not.toThrow();
    });
});
