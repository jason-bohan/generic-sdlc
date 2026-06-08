// Thin SSE client for the fleet status stream (/api/status/stream?agentId=all).
// Makes the TUI a client of the SAME event spine the web dashboard already uses,
// instead of file-watching a single agent. No browser EventSource needed — reads
// the stream via fetch + a manual SSE parser (works on any Node 18+).

import { apiBase } from './apiBase';

export interface FleetEvent {
  agentId: string;
  status: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Parse accumulated SSE text into complete events plus the unconsumed tail.
 * Pure and synchronous so it is unit-testable. SSE records are separated by a
 * blank line; only `data:` lines are decoded, `:`-comments (keepalives) and
 * other fields are ignored. Malformed JSON is dropped.
 */
export function parseSseBuffer(buffer: string): { events: FleetEvent[]; rest: string } {
  const events: FleetEvent[] = [];
  let rest = buffer.replace(/\r\n/g, '\n');
  let sep = rest.indexOf('\n\n');
  while (sep !== -1) {
    const record = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const data = record
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) {
      try {
        const ev = JSON.parse(data) as FleetEvent;
        if (ev && typeof ev.agentId === 'string' && ev.status && typeof ev.status === 'object') {
          events.push(ev);
        }
      } catch {
        /* malformed event — skip */
      }
    }
    sep = rest.indexOf('\n\n');
  }
  return { events, rest };
}

/**
 * Connect to the fleet stream. Calls onEvent for each status event and
 * auto-reconnects with backoff on drop. Returns a close() that stops the stream.
 */
export function connectFleetStream(
  onEvent: (ev: FleetEvent) => void,
  onError?: (e: unknown) => void,
): () => void {
  const controller = new AbortController();
  let closed = false;

  (async () => {
    while (!closed) {
      try {
        const res = await fetch(`${apiBase()}/api/status/stream?agentId=all`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseBuffer(buffer);
          buffer = rest;
          for (const ev of events) onEvent(ev);
        }
      } catch (e) {
        if (closed) break;
        onError?.(e);
        await new Promise((r) => setTimeout(r, 2000)); // reconnect backoff
      }
    }
  })();

  return () => {
    closed = true;
    controller.abort();
  };
}
