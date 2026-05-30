export type DomainType = 'credit-scoring' | 'fraud-detection' | 'trading' | 'general';

export interface RiskConfig {
  domain: DomainType;
  precisionWeight: number;
  recallWeight: number;
  fpPenalty: number;
  fnPenalty: number;
  confidenceThreshold: number;
  description: string;
}

const RISK_CONFIGS: Record<DomainType, RiskConfig> = {
  'credit-scoring': {
    domain: 'credit-scoring',
    precisionWeight: 0.7,
    recallWeight: 0.3,
    fpPenalty: 3.0,
    fnPenalty: 1.0,
    confidenceThreshold: 0.85,
    description: 'FP (approving a defaulter) costs principal; FN (rejecting creditworthy) costs minor interest. Penalize FP heavily.',
  },
  'fraud-detection': {
    domain: 'fraud-detection',
    precisionWeight: 0.2,
    recallWeight: 0.8,
    fpPenalty: 1.0,
    fnPenalty: 5.0,
    confidenceThreshold: 0.3,
    description: 'FN (missing fraud) risks fines and capital loss. Prioritize recall, trade off higher false alarm rate.',
  },
  'trading': {
    domain: 'trading',
    precisionWeight: 0.5,
    recallWeight: 0.5,
    fpPenalty: 2.0,
    fnPenalty: 2.0,
    confidenceThreshold: 0.7,
    description: 'Balanced. Both FP (bad trade) and FN (missed opportunity) carry material risk.',
  },
  'general': {
    domain: 'general',
    precisionWeight: 0.5,
    recallWeight: 0.5,
    fpPenalty: 1.0,
    fnPenalty: 1.0,
    confidenceThreshold: 0.5,
    description: 'Default balanced configuration.',
  },
};

export function getRiskConfig(domain: DomainType): RiskConfig {
  return RISK_CONFIGS[domain] ?? RISK_CONFIGS.general;
}

export interface AsymmetricScoreInput {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
}

export function computeAsymmetricScore(input: AsymmetricScoreInput, config: RiskConfig): {
  precision: number;
  recall: number;
  f1: number;
  weightedScore: number;
  domain: DomainType;
} {
  const { truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn } = input;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  const riskPenalty = (fp * config.fpPenalty + fn * config.fnPenalty) / Math.max(1, tp + fp + tn + fn);
  const weightedScore = (precision * config.precisionWeight + recall * config.recallWeight) * (1 - riskPenalty);

  return {
    precision: Math.round(precision * 10000) / 10000,
    recall: Math.round(recall * 10000) / 10000,
    f1: Math.round(f1 * 10000) / 10000,
    weightedScore: Math.round(weightedScore * 10000) / 10000,
    domain: config.domain,
  };
}

export function evaluateConfidenceThreshold(
  scores: number[],
  expectedOutcomes: boolean[],
  threshold: number,
): { accuracy: number; fpRate: number; fnRate: number; aboveThresholdPct: number } {
  if (scores.length === 0 || scores.length !== expectedOutcomes.length) {
    return { accuracy: 0, fpRate: 0, fnRate: 0, aboveThresholdPct: 0 };
  }

  let correct = 0;
  let fp = 0;
  let fn = 0;
  let aboveThreshold = 0;

  for (let i = 0; i < scores.length; i++) {
    const predicted = scores[i] >= threshold;
    const actual = expectedOutcomes[i];
    if (predicted === actual) correct++;
    if (predicted && !actual) fp++;
    if (!predicted && actual) fn++;
    if (predicted) aboveThreshold++;
  }

  return {
    accuracy: Math.round((correct / scores.length) * 10000) / 10000,
    fpRate: Math.round((fp / Math.max(1, scores.length)) * 10000) / 10000,
    fnRate: Math.round((fn / Math.max(1, scores.length)) * 10000) / 10000,
    aboveThresholdPct: Math.round((aboveThreshold / scores.length) * 10000) / 10000,
  };
}

export function findOptimalThreshold(
  scores: number[],
  expectedOutcomes: boolean[],
  config: RiskConfig,
): { threshold: number; score: number; metrics: ReturnType<typeof evaluateConfidenceThreshold> } {
  const candidates = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  let best: { threshold: number; score: number; metrics: ReturnType<typeof evaluateConfidenceThreshold> } = {
    threshold: config.confidenceThreshold,
    score: -Infinity,
    metrics: evaluateConfidenceThreshold(scores, expectedOutcomes, config.confidenceThreshold),
  };

  for (const t of candidates) {
    const metrics = evaluateConfidenceThreshold(scores, expectedOutcomes, t);
    const weighted = (1 - metrics.fnRate) * config.recallWeight + (1 - metrics.fpRate) * config.precisionWeight;
    if (weighted > best.score) {
      best = { threshold: t, score: weighted, metrics };
    }
  }

  return best;
}

export function listDomainConfigs(): RiskConfig[] {
  return Object.values(RISK_CONFIGS);
}
