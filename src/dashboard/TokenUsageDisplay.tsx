import React from 'react';

interface TokenCounts {
  input: number;
  output: number;
}

interface TokenUsageDisplayProps {
  cloud: TokenCounts;
  meshllm?: TokenCounts;
  ollama: TokenCounts;
  accentColor?: string;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={styles.barTrack}>
      <div style={{ ...styles.barFill, width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

export function TokenUsageDisplay({ cloud, meshllm = { input: 0, output: 0 }, ollama, accentColor = '#D97706' }: TokenUsageDisplayProps) {
  const cloudTotal = cloud.input + cloud.output;
  const meshllmTotal = meshllm.input + meshllm.output;
  const ollamaTotal = ollama.input + ollama.output;
  const maxTokens = Math.max(cloudTotal, meshllmTotal, ollamaTotal, 1);

  return (
    <div style={styles.container}>
      <div style={styles.header}>Token Usage</div>
      <div style={styles.row}>
        <span style={styles.label}>Cloud</span>
        <Bar value={cloudTotal} max={maxTokens} color={accentColor} />
        <span style={styles.value}>
          {formatTokens(cloud.input)}↓ {formatTokens(cloud.output)}↑
        </span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>MeshLLM</span>
        <Bar value={meshllmTotal} max={maxTokens} color="#A78BFA" />
        <span style={styles.value}>
          {formatTokens(meshllm.input)}↓ {formatTokens(meshllm.output)}↑
        </span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Ollama</span>
        <Bar value={ollamaTotal} max={maxTokens} color="#10B981" />
        <span style={styles.value}>
          {formatTokens(ollama.input)}↓ {formatTokens(ollama.output)}↑
        </span>
      </div>
      <div style={styles.footer}>
        Total: {formatTokens(cloudTotal + meshllmTotal + ollamaTotal)} tokens
      </div>
    </div>
  );
}
TokenUsageDisplay.displayName = 'TokenUsageDisplay';

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '8px 12px',
    borderRadius: 6,
    background: 'rgba(0,0,0,0.3)',
  },
  header: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#999',
    marginBottom: 6,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  label: {
    fontSize: 11,
    color: '#ccc',
    width: 58,
    flexShrink: 0,
  },
  barTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    background: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.5s ease',
  },
  value: {
    fontSize: 10,
    color: '#aaa',
    whiteSpace: 'nowrap',
    minWidth: 70,
    textAlign: 'right',
  },
  footer: {
    fontSize: 10,
    color: '#777',
    marginTop: 4,
    textAlign: 'right',
  },
};
