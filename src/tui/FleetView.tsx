import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { connectFleetStream, type FleetEvent } from './fleetStream';
import { link } from './osc8';

// Render order — the SDLC fleet. Only agents that have reported are shown.
const FLEET_ORDER = ['orchestrator', 'backend', 'frontend', 'qa', 'ux', 'reviewer', 'devops', 'aiqa'];

const GREEN_PHASES = new Set(['complete', 'approved', 'build-passed']);
const RED_PHASES = new Set(['error', 'changes-requested', 'build-failed']);

function phaseColor(phase: string): string {
  if (!phase || phase === 'idle') return 'gray';
  if (GREEN_PHASES.has(phase)) return 'green';
  if (RED_PHASES.has(phase)) return 'red';
  return 'cyan'; // actively working
}

interface AgentSnap {
  phase: string;
  story?: string;
  prId?: number;
  prUrl?: string;
}

function snapFromStatus(status: Record<string, unknown>): AgentSnap {
  const prs = Array.isArray(status.prs) ? (status.prs as Array<Record<string, unknown>>) : [];
  const pr = prs[0];
  return {
    phase: String(status.currentPhase ?? 'idle'),
    story: typeof status.storyNumber === 'string' ? status.storyNumber : undefined,
    prId: pr && typeof pr.id === 'number' ? pr.id : undefined,
    prUrl: pr && typeof pr.url === 'string' ? pr.url : undefined,
  };
}

/** Live multi-agent fleet view — a thin client of /api/status/stream. */
export function FleetView() {
  const [fleet, setFleet] = useState<Record<string, AgentSnap>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const close = connectFleetStream(
      (ev: FleetEvent) => {
        setConnected(true);
        setFleet((prev) => ({ ...prev, [ev.agentId]: snapFromStatus(ev.status) }));
      },
      () => setConnected(false),
    );
    return close;
  }, []);

  const ids = FLEET_ORDER.filter((id) => fleet[id]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box gap={2}>
        <Text bold color="yellow">SDLC Fleet</Text>
        <Text color={connected ? 'green' : 'gray'}>{connected ? '● live' : '○ connecting'}</Text>
        {!connected && <Text color="green"><Spinner type="dots" /></Text>}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {ids.length === 0 && <Text dimColor>Waiting for agent activity…</Text>}
        {ids.map((id) => {
          const a = fleet[id];
          return (
            <Box key={id} gap={1}>
              <Box width={13}><Text bold>{id}</Text></Box>
              <Box width={18}><Text color={phaseColor(a.phase)}>{a.phase}</Text></Box>
              <Box width={14}><Text dimColor>{a.story ?? ''}</Text></Box>
              {a.prId !== undefined && <Text color="magenta">{link(a.prUrl, `#${a.prId}`)}</Text>}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Live over /api/status/stream • Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
}
FleetView.displayName = 'FleetView';
