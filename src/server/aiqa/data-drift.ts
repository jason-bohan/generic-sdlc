export interface DriftDetectionResult {
  metric: string;
  ksStatistic: number;
  ksPValue: number;
  psi: number;
  psiPassed: boolean;
  driftDetected: boolean;
  severity: 'none' | 'low' | 'medium' | 'high';
  detail: string;
}

export interface SchemaComplianceResult {
  field: string;
  expectedType: string;
  violations: number;
  total: number;
  compliancePct: number;
  passed: boolean;
  detail: string;
}

export interface DriftReport {
  results: DriftDetectionResult[];
  schemaResults: SchemaComplianceResult[];
  overallDriftDetected: boolean;
  summary: string;
}

export interface MetricSample {
  label?: string;
  values: number[];
}

export interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'nullable';
  required: boolean;
}

function ksTwoSample(sample1: number[], sample2: number[]): { statistic: number; pValue: number } {
  const n1 = sample1.length;
  const n2 = sample2.length;
  if (n1 === 0 || n2 === 0) return { statistic: 1, pValue: 0 };

  const all = [...new Set([...sample1, ...sample2])].sort((a, b) => a - b);
  let maxDiff = 0;
  for (const x of all) {
    const cdf1 = sample1.filter((v) => v <= x).length / n1;
    const cdf2 = sample2.filter((v) => v <= x).length / n2;
    maxDiff = Math.max(maxDiff, Math.abs(cdf1 - cdf2));
  }

  if (maxDiff === 0) return { statistic: 0, pValue: 1 };

  const ne = (n1 * n2) / (n1 + n2);
  const lambda = Math.max((Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * maxDiff, 0);
  let pValue = 0;
  for (let k = 1; k <= 100; k++) {
    pValue += (k % 2 === 1 ? 1 : -1) * 2 * Math.exp(-2 * k * k * lambda * lambda);
  }
  pValue = Math.max(0, Math.min(1, pValue));

  return { statistic: maxDiff, pValue };
}

function calcPsi(expected: number[], actual: number[], buckets = 10): number {
  if (expected.length === 0 || actual.length === 0) return Infinity;

  const min = Math.min(...expected, ...actual);
  const max = Math.max(...expected, ...actual);
  const range = max - min || 1;
  const binSize = range / buckets;

  let psi = 0;
  for (let i = 0; i < buckets; i++) {
    const lo = min + i * binSize;
    const hi = lo + binSize;
    const expCount = expected.filter((v) => v >= lo && v <= hi).length;
    const actCount = actual.filter((v) => v >= lo && v <= hi).length;
    const expPct = (expCount + 0.5) / (expected.length + 0.5 * buckets);
    const actPct = (actCount + 0.5) / (actual.length + 0.5 * buckets);
    psi += (actPct - expPct) * Math.log(actPct / expPct);
  }

  return psi;
}

const PSI_THRESHOLD_LOW = 0.1;
const PSI_THRESHOLD_MEDIUM = 0.25;

export function detectDrift(
  baseline: MetricSample,
  current: MetricSample,
  metric: string = 'unknown',
  ksAlpha: number = 0.05,
): DriftDetectionResult {
  const { statistic: ksStatistic, pValue: ksPValue } = ksTwoSample(baseline.values, current.values);
  const psi = calcPsi(baseline.values, current.values);

  const ksDrift = ksPValue < ksAlpha;
  const psiDrift = psi > PSI_THRESHOLD_LOW;

  const driftDetected = ksDrift || psiDrift;

  let severity: 'none' | 'low' | 'medium' | 'high' = 'none';
  if (ksDrift && psi > PSI_THRESHOLD_MEDIUM) severity = 'high';
  else if (ksDrift && psiDrift) severity = 'medium';
  else if (ksDrift || psiDrift) severity = 'low';

  return {
    metric,
    ksStatistic: Math.round(ksStatistic * 10000) / 10000,
    ksPValue: Math.round(ksPValue * 10000) / 10000,
    psi: Math.round(psi * 10000) / 10000,
    psiPassed: psi <= PSI_THRESHOLD_LOW,
    driftDetected,
    severity,
    detail: `Drift on "${metric}": KS=${ksStatistic.toFixed(4)} (p=${ksPValue.toFixed(4)}${ksDrift ? ' ***' : ''}), PSI=${psi.toFixed(4)} (threshold=${PSI_THRESHOLD_LOW}). `
      + (driftDetected ? `Drift detected (${severity} severity).` : 'No significant drift.'),
  };
}

export function detectDriftBatch(
  baselines: MetricSample[],
  currents: MetricSample[],
  metricLabels?: string[],
  ksAlpha?: number,
): DriftDetectionResult[] {
  const count = Math.max(baselines.length, currents.length);
  const results: DriftDetectionResult[] = [];
  for (let i = 0; i < count; i++) {
    const baseline = baselines[i] ?? { values: [] };
    const current = currents[i] ?? { values: [] };
    const label = metricLabels?.[i] ?? `metric_${i}`;
    results.push(detectDrift(baseline, current, label, ksAlpha));
  }
  return results;
}

export function checkSchemaCompliance(
  records: Record<string, unknown>[],
  schema: SchemaField[],
): SchemaComplianceResult[] {
  return schema.map((field) => {
    let violations = 0;
    for (const record of records) {
      const value = record[field.name];
      const isPresent = value !== undefined && value !== null;
      if (!isPresent && field.required) {
        violations++;
        continue;
      }
      if (isPresent) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (field.type !== 'nullable' && actualType !== field.type) {
          violations++;
        }
      }
    }
    const total = records.length;
    const compliancePct = total > 0 ? ((total - violations) / total) * 100 : 100;
    return {
      field: field.name,
      expectedType: field.type,
      violations,
      total,
      compliancePct: Math.round(compliancePct * 100) / 100,
      passed: compliancePct >= 95,
      detail: `Field "${field.name}": ${compliancePct.toFixed(1)}% compliance (${total - violations}/${total} valid, expected ${field.type}${field.required ? ', required' : ', optional'})`,
    };
  });
}

export function generateDriftReport(
  driftResults: DriftDetectionResult[],
  schemaResults: SchemaComplianceResult[],
): DriftReport {
  const overallDriftDetected = driftResults.some((r) => r.driftDetected);
  const summary = overallDriftDetected
    ? `Drift detected in ${driftResults.filter((r) => r.driftDetected).length}/${driftResults.length} metrics. `
      + `${schemaResults.filter((r) => !r.passed).length}/${schemaResults.length} schema violations found.`
    : `No significant drift detected across ${driftResults.length} metrics. Schema compliance: ${schemaResults.filter((r) => r.passed).length}/${schemaResults.length} passing.`;
  return { results: driftResults, schemaResults, overallDriftDetected, summary };
}
