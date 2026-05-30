import type { EvalInput, EvalExample } from './eval-dataset';

export type EvalVerdict = 'pass' | 'warn' | 'fail';

export interface EvalCriterionResult {
  id: string;
  name: string;
  verdict: EvalVerdict;
  score: number;
  detail: string;
}

export interface EvalResult {
  exampleId: string;
  overallScore: number;
  verdict: EvalVerdict;
  criteria: EvalCriterionResult[];
  findings: string[];
  passed: boolean;
}

export interface EvalRunConfig {
  tokenHighThreshold: number;
  tokenMediumThreshold: number;
  maxRepeatedPhaseComplete: number;
  staleSessionMinutes: number;
}

const DEFAULT_CONFIG: EvalRunConfig = {
  tokenHighThreshold: 100_000,
  tokenMediumThreshold: 25_000,
  maxRepeatedPhaseComplete: 8,
  staleSessionMinutes: 30,
};

function tokenTotal(input: EvalInput): number {
  let total = 0;
  for (const provider of Object.values(input.tokens)) {
    total += (provider?.input ?? 0) + (provider?.output ?? 0);
  }
  return total;
}

function countPattern(text: string, pattern: RegExp): number {
  return (text.match(pattern)?.length ?? 0);
}

function deduplicate<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function evalPhaseTransition(input: EvalInput, _config: EvalRunConfig): EvalCriterionResult {
  const issues: string[] = [];
  let score = 10;

  if (input.currentPhase === 'error') {
    issues.push('Agent is in error phase');
    score -= 5;
  }
  if (input.currentPhase !== 'idle' && input.currentPhase !== 'complete' && !input.isRunning) {
    issues.push(`Agent stopped mid-workflow at phase ${input.currentPhase}`);
    score -= 3;
  }
  if (input.currentPhase === 'complete' && input.isRunning) {
    issues.push('Agent reports complete phase but is still running');
    score -= 2;
  }

  const phaseEvents = input.events.filter((e) => e.type === 'phase');
  const seenPhases = new Set(phaseEvents.map((e) => {
    const m = e.message.match(/ ([\w-]+)$/);
    return m ? m[1] : null;
  }).filter(Boolean));
  if (seenPhases.size > 0 && seenPhases.size < 3) {
    const phases = [...seenPhases].join(', ');
    issues.push(`Agent cycled through only ${seenPhases.size} phase(s): ${phases}`);
    score -= 1;
  }

  const verdict: EvalVerdict = score >= 8 ? 'pass' : score >= 5 ? 'warn' : 'fail';
  const detail = issues.length > 0 ? issues.join('; ') : 'Phase transitions are healthy';
  return { id: 'phase-transition', name: 'Phase transition health', verdict, score, detail };
}

function evalTaskQuality(input: EvalInput, _config: EvalRunConfig): EvalCriterionResult {
  const issues: string[] = [];
  let score = 10;
  const totalTasks = input.tasks.length;

  if (totalTasks === 0) {
    score -= 0;
  } else {
    const failedTasks = input.tasks.filter((t) => t.status === 'failed').length;
    const openTasks = input.tasks.filter((t) => !['completed', 'complete', 'failed'].includes(t.status ?? '')).length;

    if (failedTasks > 0) {
      issues.push(`${failedTasks}/${totalTasks} task(s) failed`);
      score -= Math.min(failedTasks * 2, 6);
    }
    if (openTasks > 3) {
      issues.push(`${openTasks} task(s) still open`);
      score -= 1;
    }
    const missingCategories = input.tasks.filter((t) => !t.category).length;
    if (missingCategories > 0) {
      issues.push(`${missingCategories} task(s) missing category`);
      score -= 1;
    }
    const underEstimated = input.tasks.filter((t) => (t.hours ?? 0) <= 0).length;
    if (underEstimated > 0) {
      issues.push(`${underEstimated} task(s) without hour estimates`);
      score -= 1;
    }
  }

  if (input.requests.length > 0) {
    const openReqs = input.requests.filter((r) => r.status !== 'resolved').length;
    if (openReqs > 0) {
      issues.push(`${openReqs} unresolved request(s)`);
      score -= 1;
    }
    const highSeverity = input.requests.filter((r) => r.severity === 'high' || r.severity === 'critical').length;
    if (highSeverity > 0) {
      issues.push(`${highSeverity} high-severity open request(s)`);
      score -= 1;
    }
  }

  const verdict: EvalVerdict = score >= 8 ? 'pass' : score >= 5 ? 'warn' : 'fail';
  const detail = issues.length > 0 ? issues.join('; ') : 'Task quality is good';
  return { id: 'task-quality', name: 'Task definition and completion quality', verdict, score, detail };
}

function evalTokenEfficiency(input: EvalInput, config: EvalRunConfig): EvalCriterionResult {
  const issues: string[] = [];
  let score = 10;
  const total = tokenTotal(input);

  if (total > config.tokenHighThreshold) {
    issues.push(`Token burn ${total.toLocaleString()} exceeds high threshold of ${config.tokenHighThreshold.toLocaleString()}`);
    score -= 4;
  } else if (total > config.tokenMediumThreshold) {
    issues.push(`Token burn ${total.toLocaleString()} exceeds medium threshold of ${config.tokenMediumThreshold.toLocaleString()}`);
    score -= 2;
  }
  const hasCloud = (input.tokens.cloud?.input ?? 0) > 0 || (input.tokens.cloud?.output ?? 0) > 0;
  const hasLocal = (input.tokens.ollama?.input ?? 0) > 0 || (input.tokens.ollama?.output ?? 0) > 0;
  const hasMlx = (input.tokens.mlx?.input ?? 0) > 0 || (input.tokens.mlx?.output ?? 0) > 0;
  if (hasCloud && !hasLocal && !hasMlx) {
    issues.push('All tokens consumed via cloud model; consider using local models for simpler tasks');
    score -= 1;
  }

  const verdict: EvalVerdict = score >= 8 ? 'pass' : score >= 5 ? 'warn' : 'fail';
  const detail = issues.length > 0 ? issues.join('; ') : 'Token usage is within acceptable ranges';
  return { id: 'token-efficiency', name: 'Token usage efficiency', verdict, score, detail };
}

function evalToolUsage(input: EvalInput, config: EvalRunConfig): EvalCriterionResult {
  const issues: string[] = [];
  let score = 10;
  const allLogs = input.logSnippets.join('\n');

  const parseFailures = countPattern(allLogs, /(tool-call|tool call|json|parse).{0,60}(fail|error|invalid|malformed)/gi);
  const phaseCompletes = countPattern(allLogs, /\[tool\].*complete_phase/g);
  const explicitErrors = countPattern(allLogs, /\[error\]|ERROR:|Failed running/gi);
  const malformedJson = countPattern(allLogs, /(SyntaxError|Unexpected token|JSON\.parse)/gi);

  if (parseFailures > 0) {
    issues.push(`${parseFailures} tool-call parsing failure(s) detected`);
    score -= Math.min(parseFailures, 5);
  }
  if (phaseCompletes > config.maxRepeatedPhaseComplete) {
    issues.push(`${phaseCompletes} repeated complete_phase calls (max: ${config.maxRepeatedPhaseComplete})`);
    score -= 3;
  }
  if (explicitErrors > 0) {
    issues.push(`${explicitErrors} explicit error(s) in logs`);
    score -= Math.min(explicitErrors, 4);
  }
  if (malformedJson > 0) {
    issues.push(`${malformedJson} JSON parse error(s)`);
    score -= 2;
  }

  const verdict: EvalVerdict = score >= 8 ? 'pass' : score >= 5 ? 'warn' : 'fail';
  const detail = issues.length > 0 ? issues.join('; ') : 'Tool usage is clean';
  return { id: 'tool-usage', name: 'Tool call health', verdict, score, detail };
}

function evalLogHealth(input: EvalInput, config: EvalRunConfig): EvalCriterionResult {
  const issues: string[] = [];
  let score = 10;
  const allLogs = input.logSnippets.join('\n');

  const errorSignals = countPattern(allLogs, /error|fail|exception|timeout|crash|unhandled/gi);
  if (errorSignals > 5) {
    issues.push(`High error signal density: ${errorSignals} occurrences`);
    score -= 3;
  } else if (errorSignals > 2) {
    issues.push(`Elevated error signals: ${errorSignals} occurrences`);
    score -= 1;
  }

  const stalledEvents = input.events.filter((e) => {
    if (e.type !== 'info' && e.type !== 'phase') return false;
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) return false;
    return e.message.includes('started') && Date.now() - ts > config.staleSessionMinutes * 60_000;
  });
  if (stalledEvents.length > 0) {
    issues.push(`${stalledEvents.length} stale session signal(s) (no activity > ${config.staleSessionMinutes} min)`);
    score -= 2;
  }

  const completedWithFailures = input.tasks.filter((t) => t.status === 'completed').length > 0
    && input.tasks.filter((t) => t.status === 'failed').length > 0;
  if (completedWithFailures) {
    issues.push('Mix of completed and failed tasks suggests partial completion');
    score -= 1;
  }

  const verdict: EvalVerdict = score >= 8 ? 'pass' : score >= 5 ? 'warn' : 'fail';
  const detail = issues.length > 0 ? issues.join('; ') : 'Logs appear healthy';
  return { id: 'log-health', name: 'Log and session health', verdict, score, detail };
}

function evalFinancialCompliance(input: EvalInput): EvalCriterionResult {
  const issues: string[] = [];
  let score = 10;
  const allLogs = input.logSnippets.join('\n');
  const allText = [
    ...input.tasks.map((t) => t.name ?? ''),
    ...input.prs.map((p) => p.title),
    ...input.events.map((e) => e.message),
    allLogs,
  ].join(' ');

  const MONEY_RE = /\b(payment|payments|billing|invoice|ledger|balance|transaction|settlement|reconcile|refund|fee|tax|interest|currency|payout|ach|wire)\b/i;
  const CONTROL_EVIDENCE_RE = /\b(test|tests|tested|vitest|cypress|playwright|reconciliation|audit|evidence|trace|compliance)\b/i;
  const PII_RE = /\b(ssn|social security|tax id|ein|pan|card number|cvv|cvc|iban|routing|account number|dob|passport|driver'?s license|pii|kyc|aml)\b/i;
  const UNKNOWN_PROVIDER_RE = /\b(openrouter|external model|unapproved provider|unauthorized model)\b/i;

  if (MONEY_RE.test(allText) && !CONTROL_EVIDENCE_RE.test(allText)) {
    issues.push('Money-path language detected without test/audit evidence');
    score -= 3;
  }
  if (PII_RE.test(allText)) {
    issues.push('Regulated data terms detected in agent output');
    score -= 4;
  }
  if (UNKNOWN_PROVIDER_RE.test(allText)) {
    issues.push('Unapproved AI provider referenced');
    score -= 2;
  }

  const verdict: EvalVerdict = score >= 8 ? 'pass' : score >= 5 ? 'warn' : 'fail';
  const detail = issues.length > 0 ? issues.join('; ') : 'Financial controls appear compliant';
  return { id: 'financial-compliance', name: 'Financial control compliance', verdict, score, detail };
}

export function evaluateExample(example: EvalExample, config: EvalRunConfig = DEFAULT_CONFIG): EvalResult {
  const criteria: EvalCriterionResult[] = [
    evalPhaseTransition(example.input, config),
    evalTaskQuality(example.input, config),
    evalTokenEfficiency(example.input, config),
    evalToolUsage(example.input, config),
    evalLogHealth(example.input, config),
    evalFinancialCompliance(example.input),
  ];

  const totalScore = criteria.reduce((sum, c) => sum + c.score, 0);
  const maxScore = criteria.length * 10;
  const overallScore = Math.round((totalScore / maxScore) * 100);

  const findings = criteria
    .filter((c) => c.verdict !== 'pass')
    .map((c) => `${c.verdict.toUpperCase()}: ${c.name} — ${c.detail}`);

  const verdict: EvalVerdict = overallScore >= 80 ? 'pass' : overallScore >= 50 ? 'warn' : 'fail';

  const expected = example.expected;
  let passed = true;
  if (expected.qualityScoreMin !== undefined && overallScore < expected.qualityScoreMin) {
    passed = false;
  }
  if (expected.mustFindFindings !== undefined) {
    if (findings.length < expected.mustFindFindings) passed = false;
  }
  if (expected.mustNotFindFindings && findings.length > 0) {
    passed = false;
  }

  return {
    exampleId: example.id,
    overallScore,
    verdict,
    criteria,
    findings,
    passed,
  };
}

export function evaluateBatch(examples: EvalExample[], config: EvalRunConfig = DEFAULT_CONFIG): EvalResult[] {
  return examples.map((ex) => evaluateExample(ex, config));
}

export function summarizeResults(results: EvalResult[]): {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  averageScore: number;
} {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
  const averageScore = total > 0 ? Math.round(results.reduce((s, r) => s + r.overallScore, 0) / total) : 0;
  return { total, passed, failed, passRate, averageScore };
}
