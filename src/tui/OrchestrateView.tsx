import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { apiBase } from './apiBase';
import { FleetView } from './FleetView';

interface Props {
  goal?: string;
  fromAiqa?: boolean;
}

interface KickoffResult {
  ok?: boolean;
  authored?: Array<{ number: string; name: string }>;
  tick?: { assigned?: Array<{ storyNumber: string; agentId: string }>; ran?: boolean; reason?: string };
  reason?: string;
  limited?: boolean;
  retryScheduled?: { atIso: string | null; inMs: number };
  error?: string;
}

/**
 * Kick off the whole SDLC from the terminal: author stories (from a goal or the
 * AI-QA scorecard), assign them, then drop into the live fleet view to watch the
 * fleet run. Thin client — POSTs the orchestrator endpoint, streams the rest.
 */
export function OrchestrateView({ goal, fromAiqa }: Props) {
  const [status, setStatus] = useState<'working' | 'done' | 'error'>('working');
  const [result, setResult] = useState<KickoffResult | null>(null);

  useEffect(() => {
    const endpoint = fromAiqa ? 'from-aiqa' : 'author';
    const payload = fromAiqa ? { autoAssign: true } : { goal, autoAssign: true };
    fetch(`${apiBase()}/api/orchestrator/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(async (r) => ({ http: r.status, data: (await r.json().catch(() => ({}))) as KickoffResult }))
      .then(({ http, data }) => {
        setResult(http >= 500 ? { ...data, error: data.error || `HTTP ${http}` } : data);
        setStatus(http >= 500 ? 'error' : 'done');
      })
      .catch((e) => { setResult({ error: String(e) }); setStatus('error'); });
  }, [goal, fromAiqa]);

  const source = fromAiqa ? 'AI-QA findings' : `goal: "${goal}"`;
  const retryMins = Math.round((result?.retryScheduled?.inMs ?? 0) / 60_000);

  return (
    <Box flexDirection="column" padding={1}>
      <Box gap={2}>
        <Text bold color="yellow">Orchestrate</Text>
        <Text dimColor>{source}</Text>
        {status === 'working' && <Text color="green"><Spinner type="dots" /> authoring…</Text>}
      </Box>

      {result && (
        <Box flexDirection="column" marginTop={1}>
          {result.error && <Text color="red">Error: {result.error}</Text>}
          {result.limited && (
            <Text color="yellow">
              Paused — Claude usage limit. Retry scheduled{result.retryScheduled?.atIso ? ` for ${result.retryScheduled.atIso}` : ` in ~${retryMins}m`} (waits for refresh).
            </Text>
          )}
          {!result.ok && !result.limited && !result.error && result.reason && <Text dimColor>{result.reason}</Text>}

          {result.authored && result.authored.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Authored {result.authored.length} {result.authored.length === 1 ? 'story' : 'stories'}:</Text>
              {result.authored.map((s) => (
                <Text key={s.number}>  <Text color="cyan">{s.number}</Text> {s.name}</Text>
              ))}
            </Box>
          )}

          {result.tick?.assigned && result.tick.assigned.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Assigned:</Text>
              {result.tick.assigned.map((a) => (
                <Text key={a.storyNumber}>  <Text color="cyan">{a.storyNumber}</Text> → <Text color="magenta">{a.agentId}</Text></Text>
              ))}
            </Box>
          )}
          {result.tick && !result.tick.ran && result.tick.reason && (
            <Text dimColor>Not assigned: {result.tick.reason}</Text>
          )}
        </Box>
      )}

      {status === 'done' && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>── live fleet (Ctrl+C to exit) ──</Text>
          <FleetView />
        </Box>
      )}
    </Box>
  );
}
OrchestrateView.displayName = 'OrchestrateView';
