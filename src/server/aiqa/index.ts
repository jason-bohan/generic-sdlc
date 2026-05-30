export {
  BUILTIN_DATASETS,
  getDataset,
  listDatasetIds,
  getAllExamples,
  loadExternalDataset,
} from './eval-dataset';
export type {
  EvalCategory,
  EvalInput,
  EvalExpectation,
  EvalExample,
  EvalDataset,
} from './eval-dataset';

export {
  evaluateExample,
  evaluateBatch,
  summarizeResults,
} from './evaluator';
export type {
  EvalVerdict,
  EvalCriterionResult,
  EvalResult,
  EvalRunConfig,
} from './evaluator';

export {
  detectHallucinations,
  buildHallucinationReport,
} from './hallucination-detector';
export type {
  HallucinationSignal,
  HallucinationReport,
} from './hallucination-detector';

export {
  RED_TEAM_SCENARIOS,
  generateRedTeamInput,
  runRedTeam,
  listRedTeamScenarios,
  perturbInput,
  generateOodVariants,
  describeOodVariant,
  generateStratifiedSamples,
} from './red-teamer';
export type {
  RedTeamCategory,
  RedTeamScenario,
  RedTeamResult,
} from './red-teamer';

export {
  evaluateSemanticSimilarity,
  evaluateSemanticBatch,
  TfIdfScorer,
  NGramOverlapScorer,
  WordOrderScorer,
} from './semantic-similarity';
export type { SemanticEvalResult } from './semantic-similarity';

export {
  LlmJudge,
  evaluateWithJudge,
} from './judge';
export type {
  JudgeConfig,
  JudgeCriterion,
  JudgeEvaluation,
} from './judge';

export {
  detectDrift,
  detectDriftBatch,
  checkSchemaCompliance,
  generateDriftReport,
} from './data-drift';
export type {
  DriftDetectionResult,
  SchemaComplianceResult,
  DriftReport,
  MetricSample,
  SchemaField,
} from './data-drift';

export {
  monitorConfidenceShift,
  monitorSilentFailure,
  extractConfidenceScores,
} from './confidence-monitor';
export type {
  ConfidenceSample,
  ConfidenceDistribution,
  ConfidenceShiftResult,
  AgentOutputEntry,
} from './confidence-monitor';

export {
  getRiskConfig,
  computeAsymmetricScore,
  evaluateConfidenceThreshold,
  findOptimalThreshold,
  listDomainConfigs,
} from './risk-metrics';
export type {
  DomainType,
  RiskConfig,
  AsymmetricScoreInput,
} from './risk-metrics';

export {
  computeAdverseImpactRatio,
  computeIntersectionalAIR,
  runBiasMutationTest,
} from './bias-detector';
export type {
  DemographicGroup,
  DisparateImpactResult,
  ProtectedClassMutation,
  BiasAuditConfig,
} from './bias-detector';

export {
  checkFinancialGuardrails,
  validateComputationSeparation,
  validateReturnedJson,
  generateAdversarialFinancialPrompts,
} from './financial-guardrails';
export type {
  FinancialGuardrailResult,
  JsonSchemaValidationResult,
} from './financial-guardrails';

export {
  runXaiExplainer,
  generateSyntheticProfiles,
  checkShapAvailability,
} from './xai-engine';
export type {
  XaiProfile,
  XaiConfig,
  XaiExplanation,
  XaiResult,
  ReasonCode,
} from './xai-engine';
