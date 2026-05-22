import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { updateTokens, isValidTokenSource, defaultTokenState } from '../server/tokens';

const TMP_DIR = __dirname;
const AGENT = 'test-agent';
const STATUS_FILE = resolve(TMP_DIR, `.${AGENT}-status.json`);

function writeStatus(data: object) {
    writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
}

function readStatus() {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
}

afterEach(() => {
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
});

describe('isValidTokenSource', () => {
    it('accepts "cloud", "meshllm", and "ollama"', () => {
        expect(isValidTokenSource('cloud')).toBe(true);
        expect(isValidTokenSource('meshllm')).toBe(true);
        expect(isValidTokenSource('ollama')).toBe(true);
    });

    it('rejects invalid sources', () => {
        expect(isValidTokenSource('openai')).toBe(false);
        expect(isValidTokenSource('')).toBe(false);
    });
});

describe('defaultTokenState', () => {
    it('returns zeroed state', () => {
        const s = defaultTokenState();
        expect(s.cloud.input).toBe(0);
        expect(s.cloud.output).toBe(0);
        expect(s.meshllm.input).toBe(0);
        expect(s.meshllm.output).toBe(0);
        expect(s.ollama.input).toBe(0);
        expect(s.ollama.output).toBe(0);
    });
});

describe('updateTokens', () => {
    it('rejects missing agentId', () => {
        const r = updateTokens(TMP_DIR, { agentId: '', source: 'cloud', input: 10, output: 5 });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('agentId');
    });

    it('rejects invalid source', () => {
        writeStatus({ tokens: defaultTokenState() });
        const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'openai' as any, input: 10, output: 5 });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('source');
    });

    it('rejects non-number input/output', () => {
        writeStatus({ tokens: defaultTokenState() });
        const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 'abc' as any, output: 5 });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('numbers');
    });

    it('auto-initializes status file when missing', () => {
        const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 50, output: 25 });
        expect(r.ok).toBe(true);
        expect(r.tokens?.cloud.input).toBe(50);
        expect(r.tokens?.cloud.output).toBe(25);

        const status = readStatus();
        expect(status.tokens.cloud.input).toBe(50);
        expect(status.tokens.cloud.output).toBe(25);
    });

    it('handles malformed status file gracefully', () => {
        writeFileSync(STATUS_FILE, '{{not valid json');
        const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'ollama', input: 10, output: 5 });
        expect(r.ok).toBe(true);
        expect(r.tokens?.ollama.input).toBe(10);

        const status = readStatus();
        expect(status.tokens.ollama.input).toBe(10);
        expect(status.events).toBeDefined();
        expect(status.events.length).toBeGreaterThan(0);
        expect(status.events[0].message).toContain('Malformed');
    });

    it('increments cloud tokens correctly', () => {
        writeStatus({ tokens: defaultTokenState() });
        const r1 = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 100, output: 50 });
        expect(r1.ok).toBe(true);
        expect(r1.tokens?.cloud.input).toBe(100);
        expect(r1.tokens?.cloud.output).toBe(50);
        expect(r1.tokens?.ollama.input).toBe(0);

        const r2 = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 200, output: 75 });
        expect(r2.ok).toBe(true);
        expect(r2.tokens?.cloud.input).toBe(300);
        expect(r2.tokens?.cloud.output).toBe(125);
    });

    it('increments ollama tokens correctly', () => {
        writeStatus({ tokens: defaultTokenState() });
        const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'ollama', input: 500, output: 200 });
        expect(r.ok).toBe(true);
        expect(r.tokens?.ollama.input).toBe(500);
        expect(r.tokens?.ollama.output).toBe(200);
        expect(r.tokens?.cloud.input).toBe(0);
    });

    it('increments meshllm tokens correctly', () => {
        writeStatus({ tokens: defaultTokenState() });
        const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'meshllm', input: 300, output: 120 });
        expect(r.ok).toBe(true);
        expect(r.tokens?.meshllm.input).toBe(300);
        expect(r.tokens?.meshllm.output).toBe(120);
        expect(r.tokens?.cloud.input).toBe(0);
        expect(r.tokens?.ollama.input).toBe(0);
    });

    it('creates tokens object if missing from status', () => {
        writeStatus({ storyNumber: 'B-123' });
        const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 10, output: 5 });
        expect(r.ok).toBe(true);
        expect(r.tokens?.cloud.input).toBe(10);

        const status = readStatus();
        expect(status.storyNumber).toBe('B-123');
        expect(status.tokens.cloud.input).toBe(10);
    });

    it('persists to disk', () => {
        writeStatus({ tokens: defaultTokenState() });
        updateTokens(TMP_DIR, { agentId: AGENT, source: 'ollama', input: 42, output: 17 });
        const status = readStatus();
        expect(status.tokens.ollama.input).toBe(42);
        expect(status.tokens.ollama.output).toBe(17);
    });

    it('handles zero-count updates without error', () => {
        writeStatus({ tokens: defaultTokenState() });
        const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 0, output: 0 });
        expect(r.ok).toBe(true);
        expect(r.tokens?.cloud.input).toBe(0);
        expect(r.tokens?.cloud.output).toBe(0);
    });

    it('accumulates across multiple calls for different sources', () => {
        writeStatus({ tokens: defaultTokenState() });
        updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 100, output: 50 });
        updateTokens(TMP_DIR, { agentId: AGENT, source: 'meshllm', input: 75, output: 30 });
        updateTokens(TMP_DIR, { agentId: AGENT, source: 'ollama', input: 200, output: 80 });
        updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 50, output: 25 });

        const status = readStatus();
        expect(status.tokens.cloud.input).toBe(150);
        expect(status.tokens.cloud.output).toBe(75);
        expect(status.tokens.meshllm.input).toBe(75);
        expect(status.tokens.meshllm.output).toBe(30);
        expect(status.tokens.ollama.input).toBe(200);
        expect(status.tokens.ollama.output).toBe(80);
    });

    it('preserves existing status fields when auto-initializing tokens', () => {
        writeStatus({ storyNumber: 'B-999', currentPhase: 'generating-code', tasks: [{ id: 'TK-1' }] });
        const r = updateTokens(TMP_DIR, { agentId: AGENT, source: 'ollama', input: 30, output: 15 });
        expect(r.ok).toBe(true);

        const status = readStatus();
        expect(status.storyNumber).toBe('B-999');
        expect(status.currentPhase).toBe('generating-code');
        expect(status.tasks).toHaveLength(1);
        expect(status.tokens.ollama.input).toBe(30);
    });

    it('accumulates cloud tokens additively across two POSTs', () => {
        writeStatus({ tokens: defaultTokenState() });
        const r1 = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 1200, output: 400 });
        expect(r1.ok).toBe(true);
        expect(r1.tokens?.cloud.input).toBe(1200);
        expect(r1.tokens?.cloud.output).toBe(400);

        const r2 = updateTokens(TMP_DIR, { agentId: AGENT, source: 'cloud', input: 800, output: 300 });
        expect(r2.ok).toBe(true);
        expect(r2.tokens?.cloud.input).toBe(2000);
        expect(r2.tokens?.cloud.output).toBe(700);

        expect(r2.tokens?.ollama.input).toBe(0);
        expect(r2.tokens?.ollama.output).toBe(0);
    });
});
