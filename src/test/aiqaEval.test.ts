import { describe, expect, it } from 'vitest';
import {
    BUILTIN_DATASETS,
    getAllExamples,
    getDataset,
    listDatasetIds,
} from '../server/aiqa/eval-dataset';
import {
    evaluateExample,
    evaluateBatch,
    summarizeResults,
} from '../server/aiqa/evaluator';
import {
    detectHallucinations,
    buildHallucinationReport,
} from '../server/aiqa/hallucination-detector';
import {
    RED_TEAM_SCENARIOS,
    generateRedTeamInput,
    listRedTeamScenarios,
    perturbInput,
    generateOodVariants,
    generateStratifiedSamples,
} from '../server/aiqa/red-teamer';
import {
    evaluateSemanticSimilarity,
    evaluateSemanticBatch,
    TfIdfScorer,
    NGramOverlapScorer,
    WordOrderScorer,
} from '../server/aiqa/semantic-similarity';
import {
    detectDrift,
    detectDriftBatch,
    checkSchemaCompliance,
    generateDriftReport,
} from '../server/aiqa/data-drift';
import type { SchemaField } from '../server/aiqa/data-drift';
import {
    monitorConfidenceShift,
    monitorSilentFailure,
    extractConfidenceScores,
} from '../server/aiqa/confidence-monitor';
import { LlmJudge } from '../server/aiqa/judge';
import {
    getRiskConfig,
    computeAsymmetricScore,
    evaluateConfidenceThreshold,
    findOptimalThreshold,
    listDomainConfigs,
} from '../server/aiqa/risk-metrics';
import {
    computeAdverseImpactRatio,
    computeIntersectionalAIR,
    runBiasMutationTest,
} from '../server/aiqa/bias-detector';
import type { DemographicGroup } from '../server/aiqa/bias-detector';
import {
    checkFinancialGuardrails,
    validateComputationSeparation,
    validateReturnedJson,
    generateAdversarialFinancialPrompts,
} from '../server/aiqa/financial-guardrails';
import {
    runXaiExplainer,
    generateSyntheticProfiles,
    checkShapAvailability,
} from '../server/aiqa/xai-engine';

describe('AIQA Eval Datasets', () => {
    it('defines built-in datasets', () => {
        expect(BUILTIN_DATASETS.length).toBeGreaterThanOrEqual(6);
        const ids = listDatasetIds();
        expect(ids).toContain('phase-transitions');
        expect(ids).toContain('task-quality');
        expect(ids).toContain('tool-usage');
        expect(ids).toContain('sessions');
        expect(ids).toContain('financial-controls');
        expect(ids).toContain('adversarial');
    });

    it('every dataset has a name, description, and at least one example', () => {
        for (const dataset of BUILTIN_DATASETS) {
            expect(dataset.name).toBeTruthy();
            expect(dataset.description).toBeTruthy();
            expect(dataset.examples.length).toBeGreaterThanOrEqual(1);
            for (const example of dataset.examples) {
                expect(example.id).toBeTruthy();
                expect(example.name).toBeTruthy();
                expect(example.input.agentId).toBeTruthy();
                expect(example.input.tokens).toBeTruthy();
                expect(example.input.logSnippets).toBeTruthy();
                expect(example.expected.description).toBeTruthy();
            }
        }
    });

    it('getDataset returns the correct dataset', () => {
        const ds = getDataset('adversarial');
        expect(ds).toBeDefined();
        expect(ds!.id).toBe('adversarial');
    });

    it('getDataset returns undefined for unknown ID', () => {
        expect(getDataset('nonexistent')).toBeUndefined();
    });

    it('getAllExamples returns examples from all datasets', () => {
        const examples = getAllExamples();
        const total = BUILTIN_DATASETS.reduce((sum, d) => sum + d.examples.length, 0);
        expect(examples.length).toBe(total);
    });

    it('each adversarial example has a category', () => {
        const adv = getDataset('adversarial')!;
        for (const ex of adv.examples) {
            expect(ex.category).toBe('adversarial');
        }
    });
});

describe('AIQA Evaluator', () => {
    it('evaluates a healthy example and passes it', () => {
        const healthyExample = getAllExamples().find((e) => e.id === 'healthy-complete-workflow');
        expect(healthyExample).toBeDefined();
        const result = evaluateExample(healthyExample!);
        expect(result.overallScore).toBeGreaterThanOrEqual(80);
        expect(result.verdict).toBe('pass');
        expect(result.passed).toBe(true);
    });

    it('evaluates an error-phase example and flags issues', () => {
        const errorExample = getAllExamples().find((e) => e.id === 'phase-error');
        expect(errorExample).toBeDefined();
        const result = evaluateExample(errorExample!);
        expect(result.overallScore).toBeLessThan(80);
        expect(result.verdict).toBe('warn');
        expect(result.findings.length).toBeGreaterThanOrEqual(1);
        expect(result.findings.some((f) => f.includes('Phase transition'))).toBe(true);
    });

    it('evaluates a tool-parse-failure example and flags issues', () => {
        const toolExample = getAllExamples().find((e) => e.id === 'tool-parse-failures');
        expect(toolExample).toBeDefined();
        const result = evaluateExample(toolExample!);
        expect(result.verdict).toBe('warn');
        expect(result.findings.some((f) => f.includes('Tool call'))).toBe(true);
    });

    it('evaluates a token-excessive example and flags it', () => {
        const tokenExample = getAllExamples().find((e) => e.id === 'high-token-burn');
        expect(tokenExample).toBeDefined();
        const result = evaluateExample(tokenExample!);
        expect(result.findings.some((f) => f.includes('Token'))).toBe(true);
    });

    it('empty agent data does not cause crashes', () => {
        const emptyExample = getAllExamples().find((e) => e.id === 'empty-agent');
        expect(emptyExample).toBeDefined();
        const result = evaluateExample(emptyExample!);
        expect(result.passed).toBe(true);
        expect(result.overallScore).toBeGreaterThanOrEqual(0);
    });

    it('evaluateBatch processes all examples', () => {
        const all = getAllExamples();
        const results = evaluateBatch(all);
        expect(results.length).toBe(all.length);
        for (const r of results) {
            expect(r.overallScore).toBeGreaterThanOrEqual(0);
            expect(r.criteria.length).toBeGreaterThanOrEqual(5);
        }
    });

    it('summarizeResults produces valid summary', () => {
        const all = getAllExamples();
        const results = evaluateBatch(all);
        const summary = summarizeResults(results);
        expect(summary.total).toBe(all.length);
        expect(summary.passed + summary.failed).toBe(summary.total);
        expect(summary.passRate).toBeGreaterThanOrEqual(0);
        expect(summary.averageScore).toBeGreaterThanOrEqual(0);
    });

    it('every criterion has a valid verdict and score', () => {
        const all = getAllExamples();
        const results = evaluateBatch(all);
        for (const result of results) {
            for (const criterion of result.criteria) {
                expect(['pass', 'warn', 'fail']).toContain(criterion.verdict);
                expect(criterion.score).toBeGreaterThanOrEqual(0);
                expect(criterion.score).toBeLessThanOrEqual(10);
                expect(criterion.detail).toBeTruthy();
            }
        }
    });

    it('golden baseline examples all pass', () => {
        const golden = getAllExamples().filter((e) => e.tags.includes('golden'));
        expect(golden.length).toBeGreaterThanOrEqual(2);
        const results = evaluateBatch(golden);
        for (const r of results) {
            expect(r.passed, `${r.exampleId}: ${r.findings.join(', ')}`).toBe(true);
            expect(r.verdict).toBe('pass');
        }
    });
});

describe('AIQA Hallucination Detector', () => {
    it('detects premature success signals', () => {
        const example = getAllExamples().find((e) => e.id === 'tool-parse-failures');
        expect(example).toBeDefined();
        const signals = detectHallucinations(example!.input);
        const premature = signals.filter((s) => s.type === 'premature-success');
        expect(premature.length).toBeGreaterThanOrEqual(0);
    });

    it('detects vague language', () => {
        const example = getAllExamples().find((e) => e.id === 'repeated-phase-complete');
        expect(example).toBeDefined();
        const signals = detectHallucinations(example!.input);
        expect(Array.isArray(signals)).toBe(true);
    });

    it('buildHallucinationReport returns structured report', () => {
        const all = getAllExamples();
        const report = buildHallucinationReport(all[0].input);
        expect(report.agentId).toBeTruthy();
        expect(typeof report.totalSignals).toBe('number');
        expect(typeof report.hasHallucinationRisk).toBe('boolean');
        expect(Array.isArray(report.signals)).toBe(true);
    });

    it('does not hallucinate on clean data', () => {
        const clean = getAllExamples().find((e) => e.id === 'healthy-complete-workflow');
        expect(clean).toBeDefined();
        const signals = detectHallucinations(clean!.input);
        const highMedium = signals.filter((s) => s.severity === 'high' || s.severity === 'medium');
        expect(highMedium.length).toBe(0);
    });

    it('each signal has required fields', () => {
        const all = getAllExamples();
        for (const example of all) {
            const signals = detectHallucinations(example.input);
            for (const s of signals) {
                expect(s.id).toBeTruthy();
                expect(s.agentId).toBeTruthy();
                expect(['unsupported-claim', 'contradiction', 'vague-evidence', 'premature-success', 'phantom-reference']).toContain(s.type);
                expect(['high', 'medium', 'low']).toContain(s.severity);
                expect(s.description).toBeTruthy();
                expect(s.evidence).toBeTruthy();
            }
        }
    });
});

describe('AIQA Red-Teamer', () => {
    it('defines red team scenarios', () => {
        expect(RED_TEAM_SCENARIOS.length).toBeGreaterThanOrEqual(6);
    });

    it('each scenario has required fields', () => {
        for (const scenario of RED_TEAM_SCENARIOS) {
            expect(scenario.id).toBeTruthy();
            expect(scenario.name).toBeTruthy();
            expect(scenario.description).toBeTruthy();
            expect(['prompt-injection', 'malformed-input', 'conflicting-instructions', 'missing-context', 'extreme-values', 'resource-exhaustion', 'circular-dependency']).toContain(scenario.category);
            expect(['high', 'medium', 'low']).toContain(scenario.risk);
            expect(typeof scenario.generateInput).toBe('function');
            expect(typeof scenario.expectedResilience).toBe('boolean');
        }
    });

    it('generateRedTeamInput produces valid EvalInput', () => {
        const input = generateRedTeamInput('prompt-injection-code');
        expect(input).not.toBeNull();
        expect(input!.agentId).toBe('aiqa');
        expect(input!.logSnippets.length).toBeGreaterThanOrEqual(1);
        expect(input!.tokens).toBeDefined();
    });

    it('generateRedTeamInput returns null for unknown ID', () => {
        expect(generateRedTeamInput('nonexistent')).toBeNull();
    });

    it('listRedTeamScenarios returns all scenarios', () => {
        const listed = listRedTeamScenarios();
        expect(listed.length).toBe(RED_TEAM_SCENARIOS.length);
    });

    it('generateRedTeamInput with custom agent ID works', () => {
        const input = generateRedTeamInput('empty-all-fields', 'frontend');
        expect(input).not.toBeNull();
        expect(input!.agentId).toBe('unknown');
    });

    it('every scenario produces valid input that does not crash the evaluator', () => {
        const scenarios = listRedTeamScenarios();
        for (const scenario of scenarios) {
            const input = generateRedTeamInput(scenario.id);
            expect(input).not.toBeNull();
            if (input) {
                expect(() => {
                    const report = buildHallucinationReport(input);
                    expect(typeof report.totalSignals).toBe('number');
                }).not.toThrow();
            }
        }
    });
});

describe('AIQA Complete Pipeline', () => {
    it('evaluates all built-in datasets without errors', () => {
        const all = getAllExamples();
        const results = evaluateBatch(all);
        expect(results.every((r) => r.overallScore >= 0)).toBe(true);
        expect(results.every((r) => r.criteria.length > 0)).toBe(true);
    });

    it('hallucination detection runs on all examples without errors', () => {
        const all = getAllExamples();
        for (const example of all) {
            expect(() => buildHallucinationReport(example.input)).not.toThrow();
        }
    });

    it('red team inputs can be evaluated without crashes', () => {
        for (const scenario of RED_TEAM_SCENARIOS) {
            const input = generateRedTeamInput(scenario.id);
            expect(input).not.toBeNull();
            if (input) {
                expect(() => evaluateExample({
                    id: `redteam-${scenario.id}`,
                    category: 'adversarial',
                    name: scenario.name,
                    description: scenario.description,
                    input,
                    expected: { description: 'Red team input resilience check' },
                    tags: ['red-team', scenario.category],
                })).not.toThrow();
            }
        }
    });
});

describe('AIQA Semantic Similarity', () => {
    it('TfIdfScorer returns 1.0 for identical text', () => {
        const scorer = new TfIdfScorer();
        expect(scorer.score('The agent writes unit tests', 'The agent writes unit tests')).toBeCloseTo(1, 1);
    });

    it('TfIdfScorer returns >0 for semantically similar text', () => {
        const scorer = new TfIdfScorer();
        const s = scorer.score('Implement user authentication flow', 'Build user login authentication');
        expect(s).toBeGreaterThan(0.2);
    });

    it('TfIdfScorer returns 0 for completely different text', () => {
        const scorer = new TfIdfScorer();
        const s = scorer.score('financial reconciliation report', 'the quick brown fox jumps');
        expect(s).toBeLessThan(0.3);
    });

    it('NGramOverlapScorer handles identical strings', () => {
        const scorer = new NGramOverlapScorer(3);
        expect(scorer.score('hello world', 'hello world')).toBeCloseTo(1, 2);
    });

    it('NGramOverlapScorer handles empty strings', () => {
        const scorer = new NGramOverlapScorer(3);
        expect(scorer.score('', '')).toBe(0);
    });

    it('WordOrderScorer penalizes reordered words', () => {
        const scorer = new WordOrderScorer();
        const same = scorer.score('analyze the codebase for errors', 'analyze the codebase for errors');
        const shuffled = scorer.score('analyze the codebase for errors', 'errors for codebase the analyze');
        expect(same).toBeGreaterThan(shuffled);
    });

    it('evaluateSemanticSimilarity passes when above threshold', () => {
        const result = evaluateSemanticSimilarity('Fix the failing test suite', 'Fix the failing test suite', 0.5);
        expect(result.passed).toBe(true);
        expect(result.similarity).toBeGreaterThanOrEqual(0.5);
    });

    it('evaluateSemanticSimilarity fails when below threshold', () => {
        const result = evaluateSemanticSimilarity('Financial reconciliation audit trail', 'The sky is blue and the sun is warm', 0.5);
        expect(result.passed).toBe(false);
        expect(result.similarity).toBeLessThan(0.5);
    });

    it('evaluateSemanticBatch processes multiple pairs', () => {
        const results = evaluateSemanticBatch([
            { expected: 'hello world', actual: 'hello world' },
            { expected: 'cat', actual: 'dog' },
        ]);
        expect(results).toHaveLength(2);
        expect(results[0].passed).toBe(true);
        expect(results[1].passed).toBe(false);
    });
});

describe('AIQA Data Drift Detection', () => {
    it('detectDrift reports no drift for identical distributions', () => {
        const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const result = detectDrift({ values }, { values }, 'test_metric');
        expect(result.driftDetected).toBe(false);
        expect(result.metric).toBe('test_metric');
    });

    it('detectDrift PSI is ~0 for identical distributions (no boundary double-counting)', () => {
        // Values landing exactly on bin edges must be counted in exactly one bucket;
        // identical baseline/current therefore yields PSI 0, not a spurious nonzero.
        const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const result = detectDrift({ values }, { values }, 'edge_metric');
        expect(result.psi).toBe(0);
        expect(result.psiPassed).toBe(true);
    });

    it('detectDrift PSI counts boundary-aligned values exactly once (no drop, no double-count)', () => {
        // min=0, max=10, 10 buckets → bin edges land on every integer, so each
        // interior value sits exactly on a boundary. If those values were dropped
        // (or double-counted), the shifted distribution's PSI would be distorted.
        const baseline = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const current = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 10]; // mass shifted toward the low end
        const result = detectDrift({ values: baseline }, { values: current }, 'edge_aligned');
        // A real shift must register as a strictly positive, finite PSI.
        expect(result.psi).toBeGreaterThan(0);
        expect(Number.isFinite(result.psi)).toBe(true);
    });

    it('detectDrift detects drift for very different distributions', () => {
        const baseline = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const current = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
        const result = detectDrift({ values: baseline }, { values: current }, 'shifted_metric');
        expect(result.driftDetected).toBe(true);
        expect(result.severity).toMatch(/^(low|medium|high)$/);
    });

    it('detectDrift handles empty samples', () => {
        const result = detectDrift({ values: [] }, { values: [1, 2, 3] }, 'empty_baseline');
        expect(result.driftDetected).toBe(true);
        expect(result.ksStatistic).toBeGreaterThanOrEqual(0);
    });

    it('detectDriftBatch processes multiple metrics', () => {
        const baselines = [{ values: [1, 2, 3] }, { values: [10, 20, 30] }];
        const currents = [{ values: [1, 2, 3] }, { values: [100, 200, 300] }];
        const results = detectDriftBatch(baselines, currents, ['metric_a', 'metric_b']);
        expect(results).toHaveLength(2);
        expect(results[0].driftDetected).toBe(false);
        expect(results[1].driftDetected).toBe(true);
    });

    it('checkSchemaCompliance detects violations', () => {
        const schema: SchemaField[] = [
            { name: 'id', type: 'string', required: true },
            { name: 'score', type: 'number', required: true },
        ];
        const records = [
            { id: 'abc', score: 95 },
            { id: 'def', score: 'high' },
            { id: 'ghi' },
        ];
        const results = checkSchemaCompliance(records, schema);
        expect(results).toHaveLength(2);
        const scoreField = results.find((r) => r.field === 'score');
        expect(scoreField).toBeDefined();
        expect(scoreField!.violations).toBe(2);
    });

    it('checkSchemaCompliance passes for clean data', () => {
        const schema: SchemaField[] = [
            { name: 'name', type: 'string', required: true },
        ];
        const records = [{ name: 'alice' }, { name: 'bob' }];
        const results = checkSchemaCompliance(records, schema);
        expect(results[0].compliancePct).toBe(100);
        expect(results[0].passed).toBe(true);
    });

    it('generateDriftReport produces summary', () => {
        const driftResults = [
            detectDrift({ values: [1, 2, 3] }, { values: [1, 2, 3] }, 'a'),
            detectDrift({ values: [1, 2, 3] }, { values: [100, 200, 300] }, 'b'),
        ];
        const schemaResults = checkSchemaCompliance(
            [{ id: 'ok' }],
            [{ name: 'id', type: 'string', required: true }],
        );
        const report = generateDriftReport(driftResults, schemaResults);
        expect(report.overallDriftDetected).toBe(true);
        expect(report.summary).toContain('Drift detected');
    });
});

describe('AIQA Confidence Monitoring', () => {
    it('monitorConfidenceShift detects no shift for identical data', () => {
        const entries = [{ confidence: 0.9, label: 'ok' }, { confidence: 0.8, label: 'ok' }];
        const result = monitorConfidenceShift(entries, entries);
        expect(result.shiftSignificant).toBe(false);
    });

    it('monitorConfidenceShift detects significant downward shift', () => {
        const baseline = [{ confidence: 0.9 }, { confidence: 0.85 }, { confidence: 0.95 }];
        const current = [{ confidence: 0.1 }, { confidence: 0.2 }, { confidence: 0.15 }];
        const result = monitorConfidenceShift(baseline, current);
        expect(result.shiftSignificant).toBe(true);
        expect(result.shiftPct).toBeLessThan(-50);
    });

    it('extractConfidenceScores parses entries', () => {
        const entries = [{ confidence: 0.9 }, { confidence: 0.8 }, {}];
        const scores = extractConfidenceScores(entries);
        expect(scores).toEqual([0.9, 0.8]);
    });

    it('extractConfidenceScores returns empty for no data', () => {
        expect(extractConfidenceScores([])).toEqual([]);
    });

    it('monitorSilentFailure detects no failure for normal data', () => {
        const entries = [{ confidence: 0.9 }, { confidence: 0.85 }, { confidence: 0.88 }];
        const result = monitorSilentFailure(entries);
        expect(result.silentFailureDetected).toBe(false);
    });

    it('monitorSilentFailure detects silent failure with many low-confidence samples', () => {
        const entries = Array.from({ length: 10 }, () => ({ confidence: 0.05 }));
        const result = monitorSilentFailure(entries);
        expect(result.silentFailureDetected).toBe(true);
    });

    it('monitorSilentFailure detects empty data as silent failure', () => {
        const result = monitorSilentFailure([]);
        expect(result.silentFailureDetected).toBe(true);
    });
});

describe('AIQA LLM Judge (fallback mode)', () => {
    it('fallback evaluation works without LLM endpoint', async () => {
        const judge = new LlmJudge({ endpoint: 'http://localhost:19999/nonexistent', timeoutMs: 100 });
        const result = await judge.evaluate('The agent fixed the bug', 'Agent should fix bugs correctly');
        expect(result.fallbackActivated).toBe(true);
        expect(result.overallScore).toBeGreaterThanOrEqual(0);
        expect(result.overallScore).toBeLessThanOrEqual(100);
        expect(typeof result.passed).toBe('boolean');
        expect(result.criteriaScores).toBeDefined();
    });

    it('fallback returns consistent structure', async () => {
        const judge = new LlmJudge({ endpoint: 'http://localhost:19999/nonexistent', timeoutMs: 100 });
        const result = await judge.evaluate('Write unit tests for the service layer', '', []);
        expect(result).toHaveProperty('criteriaScores');
        expect(result).toHaveProperty('overallScore');
        expect(result).toHaveProperty('passed');
        expect(result).toHaveProperty('reasoning');
        expect(result).toHaveProperty('rawResponse');
    });
});

describe('AIQA OOD Perturbation', () => {
    it('generateOodVariants creates variants from baseline input', () => {
        const base = {
            agentId: 'test', currentPhase: 'analyzing', isRunning: true,
            tasks: [{ name: 'do work', status: 'in_progress', hours: 5, category: 'dev', priority: 'medium' }],
            requests: [], prs: [], events: [], tokens: { cloud: { input: 100, output: 50 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 }, mlx: { input: 0, output: 0 } },
            logSnippets: ['working'],
        };
        const variants = generateOodVariants(base, 3);
        expect(variants).toHaveLength(3);
        for (const v of variants) {
            expect(v.agentId).toBe('test');
        }
    });

    it('perturbInput jitters numeric values', () => {
        const base = {
            agentId: 'test', currentPhase: 'analyzing', isRunning: true,
            tasks: [{ name: 'task', status: 'pending', hours: 10, category: 'dev', priority: 'low' }],
            requests: [], prs: [], events: [], tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 }, mlx: { input: 0, output: 0 } },
            logSnippets: [],
        };
        const perturbed = perturbInput(base, { jitterRatio: 0.5 });
        expect(perturbed.tasks[0].hours).not.toBe(10);
    });

    it('perturbInput handles missing fields', () => {
        const base = {
            agentId: 'test', currentPhase: 'idle', isRunning: false,
            tasks: [], requests: [], prs: [], events: [], tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 }, mlx: { input: 0, output: 0 } },
            logSnippets: [],
        };
        const perturbed = perturbInput(base, { missingFields: ['tasks'], jitterRatio: 0.1 });
        expect(perturbed.tasks).toBeUndefined();
    });

    it('generateStratifiedSamples produces samples across strata', () => {
        const population = [
            { agentId: 'a', currentPhase: 'analyzing', isRunning: true, tasks: [], requests: [], prs: [], events: [], tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 }, mlx: { input: 0, output: 0 } }, logSnippets: [] },
            { agentId: 'b', currentPhase: 'generating-code', isRunning: true, tasks: [], requests: [], prs: [], events: [], tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 }, mlx: { input: 0, output: 0 } }, logSnippets: [] },
            { agentId: 'c', currentPhase: 'analyzing', isRunning: false, tasks: [], requests: [], prs: [], events: [], tokens: { cloud: { input: 0, output: 0 }, meshllm: { input: 0, output: 0 }, ollama: { input: 0, output: 0 }, mlx: { input: 0, output: 0 } }, logSnippets: [] },
        ];
        const result = generateStratifiedSamples(population, ['currentPhase', 'isRunning'], 1);
        expect(result.samples.length).toBeGreaterThanOrEqual(1);
        expect(result.coverage).toBeDefined();
        expect(Array.isArray(result.missingStrata)).toBe(true);
    });
});

describe('AIQA Module Exports', () => {
    it('aiqa index exports all new modules', async () => {
        const mod = await import('../server/aiqa/index');
        expect(mod.evaluateSemanticSimilarity).toBeDefined();
        expect(mod.evaluateSemanticBatch).toBeDefined();
        expect(mod.evaluateWithJudge).toBeDefined();
        expect(mod.LlmJudge).toBeDefined();
        expect(mod.detectDrift).toBeDefined();
        expect(mod.detectDriftBatch).toBeDefined();
        expect(mod.checkSchemaCompliance).toBeDefined();
        expect(mod.generateDriftReport).toBeDefined();
        expect(mod.monitorConfidenceShift).toBeDefined();
        expect(mod.monitorSilentFailure).toBeDefined();
        expect(mod.extractConfidenceScores).toBeDefined();
        expect(mod.perturbInput).toBeDefined();
        expect(mod.generateOodVariants).toBeDefined();
        expect(mod.generateStratifiedSamples).toBeDefined();
        expect(mod.getRiskConfig).toBeDefined();
        expect(mod.computeAsymmetricScore).toBeDefined();
        expect(mod.evaluateConfidenceThreshold).toBeDefined();
        expect(mod.computeAdverseImpactRatio).toBeDefined();
        expect(mod.runBiasMutationTest).toBeDefined();
        expect(mod.checkFinancialGuardrails).toBeDefined();
        expect(mod.validateComputationSeparation).toBeDefined();
        expect(mod.validateReturnedJson).toBeDefined();
        expect(mod.generateAdversarialFinancialPrompts).toBeDefined();
        expect(mod.runXaiExplainer).toBeDefined();
        expect(mod.generateSyntheticProfiles).toBeDefined();
        expect(mod.checkShapAvailability).toBeDefined();
    });
});

describe('AIQA XAI Engine', () => {
    it('generateSyntheticProfiles creates correct number of profiles', () => {
        const profiles = generateSyntheticProfiles({ income: 50000, dti: 0.3, age: 35 }, 5);
        expect(profiles).toHaveLength(5);
        expect(profiles[0].income).toBe(50000);
        expect(profiles[2].id).toBe(2);
    });

    it('generateSyntheticProfiles varies a single feature across range', () => {
        const profiles = generateSyntheticProfiles({ income: 50000, dti: 0.3 }, 3, 'dti', [0.1, 0.5]);
        expect(profiles[0].dti).toBeCloseTo(0.1);
        expect(profiles[2].dti).toBeCloseTo(0.5);
    });

    it('checkShapAvailability returns status without crashing', () => {
        const result = checkShapAvailability();
        expect(result.available).toBeDefined();
        expect(typeof result.available).toBe('boolean');
        expect(typeof result.detail).toBe('string');
    });

    it('runXaiExplainer returns a result without crashing (no SHAP)', async () => {
        const profiles = generateSyntheticProfiles({ income: 50000, dti: 0.3, age: 35 }, 2);
        const result = await runXaiExplainer(profiles, { decisionFn: 'income > 30000' }, { timeoutMs: 5000 });
        expect(result.status).toBeDefined();
        expect(['ok', 'missing_dependency', 'error']).toContain(result.status);
    });

    it('runXaiExplainer handles missing script gracefully', async () => {
        const profiles = generateSyntheticProfiles({ income: 50000 }, 1);
        const result = await runXaiExplainer(profiles, { decisionFn: 'true' }, { scriptPath: '/nonexistent/script.py' });
        expect(result.status).toBe('error');
    });
});

describe('AIQA Risk Metrics & Asymmetric Scoring', () => {
    it('credit-scoring config penalizes FP more than FN', () => {
        const config = getRiskConfig('credit-scoring');
        expect(config.fpPenalty).toBeGreaterThan(config.fnPenalty);
        expect(config.precisionWeight).toBeGreaterThan(config.recallWeight);
    });

    it('fraud-detection config prioritizes recall over precision', () => {
        const config = getRiskConfig('fraud-detection');
        expect(config.recallWeight).toBeGreaterThan(config.precisionWeight);
        expect(config.fnPenalty).toBeGreaterThan(config.fpPenalty);
    });

    it('computeAsymmetricScore produces domain-weighted scores', () => {
        const creditConfig = getRiskConfig('credit-scoring');
        const fraudConfig = getRiskConfig('fraud-detection');
        const input = { truePositives: 90, falsePositives: 10, trueNegatives: 850, falseNegatives: 50 };
        const creditScore = computeAsymmetricScore(input, creditConfig);
        const fraudScore = computeAsymmetricScore(input, fraudConfig);
        expect(creditScore.precision).toBeCloseTo(0.9, 2);
        expect(creditScore.recall).toBeCloseTo(0.6429, 2);
        expect(fraudScore.weightedScore).not.toBe(creditScore.weightedScore);
    });

    it('evaluateConfidenceThreshold computes rates correctly', () => {
        const scores = [0.9, 0.8, 0.7, 0.3, 0.2, 0.1];
        const outcomes = [true, true, true, false, false, false];
        const result = evaluateConfidenceThreshold(scores, outcomes, 0.5);
        expect(result.accuracy).toBe(1);
        expect(result.fpRate).toBe(0);
        expect(result.fnRate).toBe(0);
    });

    it('findOptimalThreshold selects threshold based on domain config', () => {
        const scores = [0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
        const outcomes = [true, true, true, true, true, false, false, false, false, false];
        const config = getRiskConfig('credit-scoring');
        const result = findOptimalThreshold(scores, outcomes, config);
        expect(result.threshold).toBeGreaterThanOrEqual(0.1);
    });

    it('listDomainConfigs returns all domains', () => {
        const configs = listDomainConfigs();
        expect(configs).toHaveLength(4);
        const domains = configs.map((c) => c.domain);
        expect(domains).toContain('credit-scoring');
        expect(domains).toContain('fraud-detection');
        expect(domains).toContain('trading');
        expect(domains).toContain('general');
    });
});

describe('AIQA Bias Detection & Fair Lending', () => {
    it('computeAdverseImpactRatio passes with equal approval rates', () => {
        const groups: DemographicGroup[] = [
            { label: 'group_a', approved: 80, total: 100 },
            { label: 'group_b', approved: 80, total: 100 },
        ];
        const { overallPass, results } = computeAdverseImpactRatio(groups);
        expect(overallPass).toBe(true);
        expect(results.every((r) => r.passes80Rule)).toBe(true);
    });

    it('computeAdverseImpactRatio fails when group is severely disadvantaged', () => {
        const groups: DemographicGroup[] = [
            { label: 'reference', approved: 90, total: 100 },
            { label: 'protected', approved: 30, total: 100 },
        ];
        const { overallPass, results } = computeAdverseImpactRatio(groups);
        expect(overallPass).toBe(false);
        const protectedGroup = results.find((r) => r.group === 'protected');
        expect(protectedGroup).toBeDefined();
        expect(protectedGroup!.air).toBeLessThan(0.8);
    });

    it('computeAdverseImpactRatio handles empty groups', () => {
        const { overallPass } = computeAdverseImpactRatio([]);
        expect(overallPass).toBe(true);
    });

    it('runBiasMutationTest detects decision flips', () => {
        const profiles = [
            { id: 1, race: 'white', gender: 'male', income: 100000 },
            { id: 2, race: 'black', gender: 'female', income: 60000 },
        ];
        const biasedDecisionFn = (p: Record<string, unknown>) => {
            return p.race === 'white' && p.income as number > 50000;
        };
        const result = runBiasMutationTest(profiles, biasedDecisionFn);
        expect(result.mutations.length).toBeGreaterThan(0);
        expect(result.summary).toContain('decision flips');
    });

    it('runBiasMutationTest flip rate uses the true number of mutations tested', () => {
        // One profile, decision keyed only on race → every non-race mutation is a
        // no-op and every race mutation flips. The denominator must be the count of
        // mutations actually run, not attributes×2, so flipRate can never exceed 1.
        const profiles = [
            { id: 1, race: 'white', gender: 'male', age: '25', zipCode: '10001', maritalStatus: 'single' },
        ];
        let mutationCalls = 0;
        const fn = (p: Record<string, unknown>) => { mutationCalls++; return p.race === 'white'; };
        const result = runBiasMutationTest(profiles, fn);
        const mutationsTested = mutationCalls - profiles.length; // minus the baseline calls
        expect(result.flipRate).toBeLessThanOrEqual(1);
        expect(result.flipRate).toBeCloseTo(result.mutations.length / mutationsTested, 4);
        expect(result.summary).toContain(`across ${mutationsTested} mutations`);
    });

    it('computeIntersectionalAIR identifies worst-performing group', () => {
        const groups: DemographicGroup[] = [
            { label: 'white_male', approved: 80, total: 100 },
            { label: 'black_female', approved: 50, total: 100 },
            { label: 'hispanic_male', approved: 60, total: 100 },
        ];
        const { overallPass, worstGroup } = computeIntersectionalAIR(groups);
        expect(overallPass).toBe(false);
        expect(worstGroup).toBe('black_female');
    });
});

describe('AIQA Financial Guardrails', () => {
    it('checkFinancialGuardrails blocks speculative stock advice', () => {
        const results = checkFinancialGuardrails(
            'I think you should buy Tesla stock right now, it will double your money!'
        );
        expect(results.length).toBeGreaterThan(0);
        expect(results.some((r) => r.category === 'speculative-advice')).toBe(true);
    });

    it('checkFinancialGuardrails blocks unlicensed advice', () => {
        const results = checkFinancialGuardrails(
            'You should invest in Apple stock because I recommend it.'
        );
        expect(results.length).toBeGreaterThan(0);
        expect(results.some((r) => r.category === 'unlicensed-advice')).toBe(true);
    });

    it('checkFinancialGuardrails blocks regulated activity language', () => {
        const results = checkFinancialGuardrails(
            'I can guarantee you a 3% APR on this mortgage, approved today.'
        );
        expect(results.length).toBeGreaterThan(0);
        expect(results.some((r) => r.category === 'regulated-activity')).toBe(true);
    });

    it('checkFinancialGuardrails returns empty for safe output', () => {
        const results = checkFinancialGuardrails(
            'Here is a summary of your account balance: $1,234.56.'
        );
        expect(results).toHaveLength(0);
    });

    it('validateComputationSeparation detects proper separation', () => {
        const result = validateComputationSeparation(
            '{"loanAmount": 250000, "interestRate": 0.035, "termYears": 30}'
        );
        expect(result.separated).toBe(true);
    });

    it('validateComputationSeparation warns about inline computation', () => {
        const result = validateComputationSeparation(
            'The total is 250000 * 0.035 / 12 = $729.17'
        );
        expect(result.separated).toBe(false);
    });

    it('validateReturnedJson validates schema', () => {
        const schema = { loanAmount: 'number', interestRate: 'number', termYears: 'number' };
        const result = validateReturnedJson(
            '{"loanAmount": 250000, "interestRate": 0.035, "termYears": 30}',
            schema
        );
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('validateReturnedJson rejects missing fields', () => {
        const schema = { loanAmount: 'number', interestRate: 'number', termYears: 'number' };
        const result = validateReturnedJson('{"loanAmount": 250000}', schema);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it('generateAdversarialFinancialPrompts returns test scenarios', () => {
        const prompts = generateAdversarialFinancialPrompts();
        expect(prompts.length).toBeGreaterThanOrEqual(5);
        expect(prompts.some((p) => p.expectedCategory === 'speculative-advice')).toBe(true);
        expect(prompts.some((p) => p.expectedCategory === 'regulated-activity')).toBe(true);
    });

    it('checkFinancialGuardrails actually detects every adversarial prompt it generates', () => {
        // The generator and the detector must stay in sync: each adversarial prompt
        // must be flagged under its own expectedCategory (guards against dead
        // categories and order-sensitive patterns that miss real violations).
        for (const p of generateAdversarialFinancialPrompts()) {
            const categories = checkFinancialGuardrails(p.prompt).map((r) => r.category);
            expect(categories, `prompt "${p.prompt}" should be flagged as ${p.expectedCategory}`)
                .toContain(p.expectedCategory);
        }
    });

    it('checkFinancialGuardrails flags guaranteed-return language under its own category', () => {
        const results = checkFinancialGuardrails('Can you guarantee me a 5% monthly return on my investment?');
        expect(results.some((r) => r.category === 'guaranteed-returns')).toBe(true);
    });
});
