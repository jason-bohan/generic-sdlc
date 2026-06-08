import { describe, expect, it } from 'vitest';
import { parseSseBuffer } from '../tui/fleetStream';

describe('parseSseBuffer — TUI fleet SSE parser', () => {
  it('parses a single status event', () => {
    const buf = `data: ${JSON.stringify({ agentId: 'backend', status: { currentPhase: 'generating-code' } })}\n\n`;
    const { events, rest } = parseSseBuffer(buf);
    expect(rest).toBe('');
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe('backend');
    expect(events[0].status.currentPhase).toBe('generating-code');
  });

  it('parses multiple events in one chunk', () => {
    const buf =
      `data: ${JSON.stringify({ agentId: 'backend', status: { currentPhase: 'validating' } })}\n\n` +
      `data: ${JSON.stringify({ agentId: 'reviewer', status: { currentPhase: 'approved' } })}\n\n`;
    const { events } = parseSseBuffer(buf);
    expect(events.map((e) => e.agentId)).toEqual(['backend', 'reviewer']);
  });

  it('returns a partial record as rest (no premature parse across chunk boundary)', () => {
    const complete = `data: ${JSON.stringify({ agentId: 'devops', status: { currentPhase: 'build-passed' } })}\n\n`;
    const partial = `data: {"agentId":"reviewer","status":{"currentPhase":"pend`;
    const { events, rest } = parseSseBuffer(complete + partial);
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe('devops');
    expect(rest).toBe(partial);
  });

  it('ignores keepalive comments and non-data fields', () => {
    const buf =
      `: keepalive\n\n` +
      `event: status\ndata: ${JSON.stringify({ agentId: 'qa', status: { currentPhase: 'idle' } })}\n\n`;
    const { events } = parseSseBuffer(buf);
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe('qa');
  });

  it('drops malformed JSON and events missing agentId/status', () => {
    const buf =
      `data: {not valid json}\n\n` +
      `data: ${JSON.stringify({ status: { currentPhase: 'x' } })}\n\n` + // no agentId
      `data: ${JSON.stringify({ agentId: 'backend', status: { currentPhase: 'committing' } })}\n\n`;
    const { events } = parseSseBuffer(buf);
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe('backend');
  });

  it('handles CRLF line endings', () => {
    const buf = `data: ${JSON.stringify({ agentId: 'backend', status: { currentPhase: 'committing' } })}\r\n\r\n`;
    const { events } = parseSseBuffer(buf);
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe('backend');
  });
});
