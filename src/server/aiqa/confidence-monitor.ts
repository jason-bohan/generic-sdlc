export interface ConfidenceSample {
  timestamp: string;
  score: number;
  label: string;
}

export interface ConfidenceDistribution {
  mean: number;
  median: number;
  stdDev: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  skewness: number;
  kurtosis: number;
}

export interface ConfidenceShiftResult {
  metric: string;
  baselineMean: number;
  currentMean: number;
  shiftPct: number;
  shiftSignificant: boolean;
  distribution: ConfidenceDistribution;
  lowConfidenceRatio: number;
  detail: string;
}

export interface AgentOutputEntry {
  timestamp?: string;
  confidence?: number;
  score?: number;
  label?: string;
  [key: string]: unknown;
}

const LOW_CONFIDENCE_THRESHOLD = 0.4;
const SHIFT_SIGNIFICANCE_PCT = 15;

function computeDistribution(values: number[]): ConfidenceDistribution {
  if (values.length === 0) {
    return { mean: 0, median: 0, stdDev: 0, p5: 0, p25: 0, p75: 0, p95: 0, skewness: 0, kurtosis: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];

  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const p5 = sorted[Math.max(0, Math.floor(n * 0.05))];
  const p25 = sorted[Math.max(0, Math.floor(n * 0.25))];
  const p75 = sorted[Math.min(n - 1, Math.floor(n * 0.75))];
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];

  const skewness = variance > 0
    ? sorted.reduce((s, v) => s + ((v - mean) / stdDev) ** 3, 0) / n
    : 0;
  const kurtosis = variance > 0
    ? sorted.reduce((s, v) => s + ((v - mean) / stdDev) ** 4, 0) / n - 3
    : 0;

  return { mean, median, stdDev, p5, p25, p75, p95, skewness, kurtosis };
}

export function extractConfidenceScores(
  entries: AgentOutputEntry[],
  field: 'confidence' | 'score' = 'confidence',
): number[] {
  return entries
    .map((e) => {
      const val = e[field];
      if (typeof val === 'number') return val;
      return undefined;
    })
    .filter((v): v is number => v !== undefined);
}

export function monitorConfidenceShift(
  baselineEntries: AgentOutputEntry[],
  currentEntries: AgentOutputEntry[],
  metric: string = 'agent_confidence',
  field: 'confidence' | 'score' = 'confidence',
): ConfidenceShiftResult {
  const baselineValues = extractConfidenceScores(baselineEntries, field);
  const currentValues = extractConfidenceScores(currentEntries, field);

  const baselineMean = baselineValues.length > 0
    ? baselineValues.reduce((s, v) => s + v, 0) / baselineValues.length
    : 0;
  const currentMean = currentValues.length > 0
    ? currentValues.reduce((s, v) => s + v, 0) / currentValues.length
    : 0;

  const shiftPct = baselineMean > 0
    ? ((currentMean - baselineMean) / baselineMean) * 100
    : 0;
  const shiftSignificant = Math.abs(shiftPct) > SHIFT_SIGNIFICANCE_PCT;

  const distribution = computeDistribution(currentValues.length > 0 ? currentValues : baselineValues);

  const lowConfidenceCount = currentValues.filter((v) => v < LOW_CONFIDENCE_THRESHOLD).length;
  const lowConfidenceRatio = currentValues.length > 0 ? lowConfidenceCount / currentValues.length : 0;

  const detail = `Confidence shift on "${metric}": baseline mean=${(baselineMean * 100).toFixed(1)}%, current mean=${(currentMean * 100).toFixed(1)}% (${shiftPct >= 0 ? '+' : ''}${shiftPct.toFixed(1)}%). `
    + `Low-confidence samples: ${(lowConfidenceRatio * 100).toFixed(1)}%. `
    + (shiftSignificant ? `SIGNIFICANT SHIFT detected (threshold: ${SHIFT_SIGNIFICANCE_PCT}%).` : 'No significant shift.')
    + ` Distribution: μ=${(distribution.mean * 100).toFixed(1)}%, σ=${(distribution.stdDev * 100).toFixed(1)}%.`;

  return {
    metric,
    baselineMean: Math.round(baselineMean * 10000) / 10000,
    currentMean: Math.round(currentMean * 10000) / 10000,
    shiftPct: Math.round(shiftPct * 100) / 100,
    shiftSignificant,
    distribution,
    lowConfidenceRatio: Math.round(lowConfidenceRatio * 10000) / 10000,
    detail,
  };
}

export function monitorSilentFailure(
  entries: AgentOutputEntry[],
  metric: string = 'agent_confidence',
  field: 'confidence' | 'score' = 'confidence',
): { silentFailureDetected: boolean; detail: string } {
  const values = extractConfidenceScores(entries, field);
  if (values.length === 0) {
    return { silentFailureDetected: true, detail: 'No confidence data available — possible silent failure.' };
  }

  const abruptDrops = values.filter((v) => v < 0.1).length;
  const consecutiveLow = (() => {
    let maxStreak = 0;
    let currentStreak = 0;
    for (const v of values) {
      if (v < 0.2) currentStreak++;
      else { maxStreak = Math.max(maxStreak, currentStreak); currentStreak = 0; }
    }
    return Math.max(maxStreak, currentStreak);
  })();

  const veryLowRatio = values.length > 0 ? abruptDrops / values.length : 0;
  const silentFailureDetected = veryLowRatio > 0.3 || consecutiveLow >= 5;

  const detail = silentFailureDetected
    ? `SILENT FAILURE suspected: ${abruptDrops}/${values.length} samples below 0.1 (${(veryLowRatio * 100).toFixed(1)}%), consecutive low: ${consecutiveLow}.`
    : `No silent failure signals: ${abruptDrops}/${values.length} low-confidence samples, max consecutive low: ${consecutiveLow}.`;

  return { silentFailureDetected, detail };
}
