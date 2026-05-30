import type { EvalInput } from './eval-dataset';

export interface HallucinationSignal {
  id: string;
  agentId: string;
  type: 'unsupported-claim' | 'contradiction' | 'vague-evidence' | 'premature-success' | 'phantom-reference';
  severity: 'high' | 'medium' | 'low';
  description: string;
  evidence: string;
}

function countPattern(text: string, re: RegExp): number {
  return (text.match(re)?.length ?? 0);
}

function detectPhantomReferences(input: EvalInput): HallucinationSignal[] {
  const signals: HallucinationSignal[] = [];
  const allLogs = input.logSnippets.join('\n');

  const fileRefs = allLogs.match(/(?:create_file|edit_file|read_file|delete_file)\s+(\S+)/g) ?? [];
  const referencedFiles = fileRefs.map((r) => r.split(/\s+/).pop() ?? '');
  const existingFiles = new Set(referencedFiles);

  const claimedButNotModified = input.tasks
    .filter((t) => {
      const name = t.name ?? '';
      return existingFiles.size > 0 && name.length > 0 && referencedFiles.length > 0
        && referencedFiles.every((f) => !name.includes(f.replace(/^.*[/\\]/, '')));
    });

  if (claimedButNotModified.length > 0 && referencedFiles.length === 0) {
    signals.push({
      id: `phantom-${input.agentId}-${Date.now()}`,
      agentId: input.agentId,
      type: 'phantom-reference',
      severity: 'medium',
      description: 'Tasks claim work but no file modification evidence in logs',
      evidence: `Tasks: ${claimedButNotModified.map((t) => t.name).join(', ')}. No create_file/edit_file calls found.`,
    });
  }

  return signals;
}

function detectPrematureSuccess(input: EvalInput): HallucinationSignal[] {
  const signals: HallucinationSignal[] = [];
  const allLogs = input.logSnippets.join('\n');

  const phaseCompletes = countPattern(allLogs, /\[tool\].*complete_phase/g);
  const explicitErrors = countPattern(allLogs, /\[error\]|ERROR:|Failed running/gi);

  if (phaseCompletes > 3 && explicitErrors > 0) {
    signals.push({
      id: `premature-${input.agentId}-${Date.now()}`,
      agentId: input.agentId,
      type: 'premature-success',
      severity: 'high',
      description: 'Agent called complete_phase despite errors in the same session',
      evidence: `${phaseCompletes} complete_phase calls with ${explicitErrors} error signal(s) in logs.`,
    });
  }

  const completedFailedTasks = input.tasks.filter((t) => t.status === 'completed').length > 0
    && input.tasks.filter((t) => t.status === 'failed').length > 0;
  if (completedFailedTasks && input.currentPhase === 'complete') {
    signals.push({
      id: `contradict-${input.agentId}-${Date.now()}`,
      agentId: input.agentId,
      type: 'contradiction',
      severity: 'high',
      description: 'Agent completed phase but has failed tasks',
      evidence: `Phase is ${input.currentPhase} but ${input.tasks.filter((t) => t.status === 'failed').length} task(s) are failed.`,
    });
  }

  return signals;
}

function detectVagueClaims(input: EvalInput): HallucinationSignal[] {
  const signals: HallucinationSignal[] = [];
  const allLogs = input.logSnippets.join('\n');

  const vaguePhrases = [
    /\b(should work|seems correct|looks good|probably fine|I think|maybe|perhaps)\b/gi,
    /\b(will be handled|to be implemented|later|TODO|FIXME)\b/gi,
    /\b(no issues|everything works|all good|no problems)\b/gi,
  ];

  let vagueCount = 0;
  const vagueMatches: string[] = [];
  for (const pattern of vaguePhrases) {
    const matches = allLogs.match(pattern);
    if (matches) {
      vagueCount += matches.length;
      vagueMatches.push(...matches.slice(0, 5));
    }
  }

  if (vagueCount > 3) {
    signals.push({
      id: `vague-${input.agentId}-${Date.now()}`,
      agentId: input.agentId,
      type: 'vague-evidence',
      severity: 'low',
      description: 'Agent output contains vague or hedged language suggesting uncertainty',
      evidence: `${vagueCount} instances of vague language: ${[...new Set(vagueMatches)].slice(0, 3).join(', ')}.`,
    });
  }

  return signals;
}

function detectUnsupportedClaims(input: EvalInput): HallucinationSignal[] {
  const signals: HallucinationSignal[] = [];
  const allText = [
    ...input.prs.map((p) => p.title),
    ...input.events.map((e) => e.message),
    ...input.tasks.map((t) => t.name ?? ''),
    ...input.logSnippets,
  ].join(' ');

  const concreteNouns = allText.match(/\b(service|api|class|module|function|component|page|widget)\s+(\w+)\b/gi);
  if (!concreteNouns || concreteNouns.length < 2) {
    const hasContent = input.tasks.length > 0 || input.prs.length > 0 || input.logSnippets.some((s) => s.length > 50);
    if (hasContent) {
      signals.push({
        id: `unsupported-${input.agentId}-${Date.now()}`,
        agentId: input.agentId,
        type: 'unsupported-claim',
        severity: 'medium',
        description: 'Agent output lacks concrete references to specific components or services',
        evidence: 'No specific module/component/service references found in tasks, PRs, or logs.',
      });
    }
  }

  return signals;
}

export function detectHallucinations(input: EvalInput): HallucinationSignal[] {
  return [
    ...detectPhantomReferences(input),
    ...detectPrematureSuccess(input),
    ...detectVagueClaims(input),
    ...detectUnsupportedClaims(input),
  ];
}

export interface HallucinationReport {
  agentId: string;
  totalSignals: number;
  highSeverity: number;
  mediumSeverity: number;
  lowSeverity: number;
  signals: HallucinationSignal[];
  hasHallucinationRisk: boolean;
}

export function buildHallucinationReport(input: EvalInput): HallucinationReport {
  const signals = detectHallucinations(input);
  return {
    agentId: input.agentId,
    totalSignals: signals.length,
    highSeverity: signals.filter((s) => s.severity === 'high').length,
    mediumSeverity: signals.filter((s) => s.severity === 'medium').length,
    lowSeverity: signals.filter((s) => s.severity === 'low').length,
    signals,
    hasHallucinationRisk: signals.some((s) => s.severity === 'high' || s.severity === 'medium'),
  };
}
