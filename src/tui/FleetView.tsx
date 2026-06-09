import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { connectFleetStream, type FleetEvent } from './fleetStream';
import { link } from './osc8';

const API_BASE = 'http://localhost:3847';

// Render order — the SDLC fleet. Only agents that have reported are shown.
const FLEET_ORDER = ['orchestrator', 'backend', 'frontend', 'qa', 'ux', 'reviewer', 'devops', 'aiqa'];

const GREEN_PHASES = new Set(['complete', 'approved', 'build-passed']);
const RED_PHASES = new Set(['error', 'changes-requested', 'build-failed']);

function phaseColor(phase: string): string {
  if (!phase || phase === 'idle') return 'gray';
  if (GREEN_PHASES.has(phase)) return 'green';
  if (RED_PHASES.has(phase)) return 'red';
  return 'cyan';
}

interface AgentSnap {
  phase: string;
  story?: string;
  prId?: number;
  prUrl?: string;
  isRunning?: boolean;
  handoffDispatched?: boolean;
  paused?: boolean;
}

function snapFromStatus(status: Record<string, unknown>): AgentSnap {
  const prs = Array.isArray(status.prs) ? (status.prs as Array<Record<string, unknown>>) : [];
  const pr = prs[0];
  return {
    phase: String(status.currentPhase ?? 'idle'),
    story: typeof status.storyNumber === 'string' ? status.storyNumber : undefined,
    prId: pr && typeof pr.id === 'number' ? pr.id : undefined,
    prUrl: pr && typeof pr.url === 'string' ? pr.url : undefined,
    isRunning: status.isRunning as boolean | undefined,
    handoffDispatched: status.handoffDispatched as boolean | undefined,
    paused: status.paused as boolean | undefined,
  };
}

interface FleetViewProps {
  onBack?: () => void;
}

/** Live multi-agent fleet view with select-inspect and Ctrl/C/S/P controls. */
export function FleetView({ onBack }: FleetViewProps = {}) {
  const [fleet, setFleet] = useState<Record<string, AgentSnap>>({});
  const [connected, setConnected] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [actionResult, setActionResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);

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

  const doAct = useCallback(async (id: string, action: string) => {
    setActionResult(null);
    try {
      const ep = action === 'pause' ? '/api/agent/pause' : `/api/agent/${action}`;
      const res = await fetch(`${API_BASE}${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: id }),
      });
      const data = await res.json();
      setActionResult({ id, ok: res.ok, message: data.error || data.followup_message || data.message || `${action} ok` });
    } catch (e: unknown) {
      setActionResult({ id, ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useInput((input, key) => {
    if (key.escape) { onBack?.(); return; }
    if (input === '\x1b[A') { setActionResult(null); setCursor(i => Math.max(0, i - 1)); return; }
    if (input === '\x1b[B') { setActionResult(null); setCursor(i => Math.min(ids.length - 1, i + 1)); return; }
    if (ids.length === 0) return;

    if (input === 'c' || input === 'C') { void doAct(ids[cursor], 'continue'); return; }
    if (input === 's' || input === 'S') { void doAct(ids[cursor], 'stop'); return; }
    if (input === 'p' || input === 'P') { void doAct(ids[cursor], 'pause'); return; }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box gap={2}>
        <Text bold color="yellow">SDLC Fleet</Text>
        <Text color={connected ? 'green' : 'gray'}>{connected ? '● live' : '○ connecting'}</Text>
        {!connected && <Text color="green"><Spinner type="dots" /></Text>}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {ids.length === 0 && <Text dimColor>Waiting for agent activity…</Text>}
        {ids.map((id, i) => {
          const a = fleet[id];
          const active = a.isRunning !== false && a.phase !== 'idle' && a.phase !== 'complete';
          const paused = a.paused || (!a.isRunning && a.handoffDispatched === false && a.phase !== 'idle' && a.phase !== 'complete');
          const selected = i === cursor;
          const color = active ? 'green' : paused ? 'magenta' : 'gray';
          return (
            <Box key={id} gap={1}>
              <Text color={selected ? 'white' : color} bold={selected}>{selected ? '❯' : ' '}</Text>
              <Text bold color={color}>{id.padEnd(13)}</Text>
              <Box width={20}><Text color={phaseColor(a.phase)}>{a.phase}</Text></Box>
              <Box width={14}><Text dimColor>{a.story ?? ''}</Text></Box>
              {a.prId !== undefined && <Text color="magenta">{link(a.prUrl, `#${a.prId}`)}</Text>}
              {paused && <Text color="magenta" bold>[paused]</Text>}
            </Box>
          );
        })}
      </Box>

      {actionResult && (
        <Box marginTop={1}>
          <Text color={actionResult.ok ? 'green' : 'red'}>
            {actionResult.ok ? '✓' : '✖'} {actionResult.id}: {actionResult.message.slice(0, 120)}
          </Text>
        </Box>
      )}

      <Box marginTop={1} gap={2}>
        <Text dimColor>↑↓ select</Text>
        <Text bold color="cyan">C</Text><Text dimColor>ontinue</Text>
        <Text bold color="red">S</Text><Text dimColor>top</Text>
        <Text bold color="magenta">P</Text><Text dimColor>ause</Text>
        <Text dimColor>• Ctrl+C exit</Text>
      </Box>
    </Box>
  );
}
FleetView.displayName = 'FleetView';
