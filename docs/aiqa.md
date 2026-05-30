# AIQA Evaluation Reference

The AIQA (AI Quality Assurance) subsystem evaluates agent outputs, detects regressions, monitors drift, and enforces financial-services compliance controls. All source lives under `src/server/aiqa/`.

## Architecture

```
Evaluator ──→ built-in datasets ──→ pass/fail per criterion
   │
   ├── Semantic Similarity  ─── TF-IDF cosine + n-gram + word-order
   ├── LLM-as-Judge         ─── Ollama/MLX scoring (keyword fallback)
   ├── Hallucination        ─── Overclaim/contradiction pattern matching
   ├── Red Team             ─── 12 adversarial + 7 OOD strategies
   ├── Data Drift           ─── KS test + PSI + schema compliance
   ├── Confidence Monitor   ─── Distribution stats + shift + silent failure
   ├── Asymmetric Risk      ─── Domain-weighted precision/recall
   ├── Bias Detector        ─── 80% rule AIR + intersectional + mutation
   ├── Financial Guardrails ─── Prohibited-pattern regex + computation separation
   └── XAI / SHAP           ─── Python KernelExplainer (waterfall + reason codes)
```

All modules are re-exported from `src/server/aiqa/index.ts`.

## Modules

### Semantic Similarity (`semantic-similarity.ts`)

Three scorers for comparing expected vs actual agent output:

| Scorer | Method | Range |
|--------|--------|-------|
| `TF-IDF Cosine` | Token frequency vectors → cosine distance | 0–1 (1 = identical) |
| `N-Gram Overlap` | 3-gram Jaccard similarity | 0–1 |
| `Word Order` | Rank correlation of shared token positions | 0–1 |

`evaluateSemanticSimilarity()` returns a composite score (average of three scorers) plus per-scorer breakdown. Default threshold 0.5. Batch evaluation via `evaluateSemanticBatch()`.

### LLM-as-Judge (`judge.ts`)

`LlmJudge` class that sends agent output to an LLM endpoint for structured evaluation:

- **Provider**: configurable via `LLM_JUDGE_BASE_URL` (default `http://localhost:11434`) and `LLM_JUDGE_MODEL` (default `qwen3:8b`). Also supports MLX via `MLX_HOST`.
- **Criteria**: correctness, completeness, clarity, conciseness — each with configurable weight.
- **Fallback**: when LLM is unreachable, keyword-based heuristic scoring based on presence of expected terms, length, and structural proxies.

`evaluateWithJudge()` convenience function returns `{ scores, summary, verdict, raw }`.

### Data Drift (`data-drift.ts`)

| Method | Description | Interpretation |
|--------|-------------|----------------|
| **KS Test** | Two-sample Kolmogorov-Smirnov with exact p-value | Drift if p < α (default 0.05). Returns p=1 when statistic=0 (identical distributions) |
| **PSI** | Population Stability Index (10 bins) | PSI < 0.1 = no change, 0.1–0.25 = moderate, > 0.25 = significant |
| **Schema Compliance** | Field-type & required-field validation per record | Returns pass/fail per field with type mismatches |

`detectDriftBatch()` processes multiple metrics in one call. `generateDriftReport()` returns structured report with recommendations.

### Confidence Monitoring (`confidence-monitor.ts`)

`ConfidenceDistribution` computes: mean, median, std, min, max, percentiles (5, 25, 75, 95), skew, kurtosis.

- `monitorConfidenceShift()`: flags drift when mean confidence changes >15% or KS test shows significant distribution change.
- `monitorSilentFailure()`: flags when >30% of entries are low-confidence (<0.6) or ≥5 consecutive entries are low-confidence.

### Asymmetric Risk Metrics (`risk-metrics.ts`)

Four domain presets with asymmetric cost weighting:

| Domain | FP Penalty | FN Penalty | Precision Weight | Recall Weight |
|--------|-----------|-----------|-----------------|--------------|
| `credit-scoring` | 3× | 1× | 0.7 | 0.3 |
| `fraud-detection` | 1× | 5× | 0.3 | 0.7 |
| `trading` | 2× | 2× | 0.5 | 0.5 |
| `general` | 1× | 1× | 0.5 | 0.5 |

- `computeAsymmetricScore()`: returns `{ weightedAccuracy, weightedPrecision, weightedRecall, costOfErrors }`.
- `findOptimalThreshold()`: scans 0.1–0.9 (step 0.05) for best weighted accuracy.

### Bias / Fair Lending (`bias-detector.ts`)

- **Adverse Impact Ratio (AIR)**: `group approval rate ÷ highest group approval rate`. Pass if ≥ 0.80 (EEOC 80% rule).
- **Intersectional AIR**: Computes AIR for each subgroup and identifies the worst-performing combination with demographic breakdowns.
- **Bias Mutation Test**: Creates synthetic profiles from protected attributes (race, gender, age, disability, veteran status), mutates one attribute per profile, re-runs the decision function, and counts flips.

### Financial Guardrails (`financial-guardrails.ts`)

Three prohibited-pattern sets:

| Pattern Set | Examples |
|-------------|----------|
| `speculative-advice` | Buy/sell recommendations, price targets, "guaranteed returns", "market timing" |
| `unlicensed-advice` | Tax advice, legal advice, accounting advice, investment advice unqualified |
| `regulated-activity` | Loan origination, insurance underwriting, credit decisions without disclaimer |

- `checkFinancialGuardrails()`: regex scan returning matched patterns.
- `validateComputationSeparation()`: checks that JSON entities are extracted rather than inline math.
- `validateReturnedJson()`: schema validation against a type map.
- `generateAdversarialFinancialPrompts()`: returns 5 adversarial prompts for testing guardrails.

### XAI / SHAP (`xai-engine.ts`, `scripts/xai-explainer.py`)

Python SHAP explainer invoked via `child_process.spawn()` with 60-second timeout.

**Setup:**
```bash
pip install -r scripts/requirements-xai.txt
```

**Input/Output:**
- Profiles (JSON array of feature vectors)
- Decision function string (e.g. `income > 60000 and dti < 0.43`)
- SHAP KernelExplainer computes per-feature importance, per-profile waterfall breakdown, global bar, and compliance-ready reason codes

**Availability check:** `checkShapAvailability()` returns `{ available: true/false, missing: [...] }`.

### Red Team (`red-teamer.ts`)

12 built-in adversarial scenarios (injection, extraction, role-playing, refusal bypass). Extended with OOD perturbation:

| Strategy | Description |
|----------|-------------|
| `jitter` | Add Gaussian noise to numeric values |
| `noise_tokens` | Inject random tokens into text |
| `shuffle_fields` | Reorder fields in structured output |
| `duplicate_task` | Repeat the same task with varied phrasing |
| `truncated` | Cut output at 60% length |
| `joined` | Concatenate outputs from two agents |
| `all_above` | Apply all strategies to the same input |

`generateStratifiedSamples()` samples agent inputs by categorical strata (e.g. `currentPhase`, `isRunning`) with coverage tracking and missing-strata reporting.

## Configuration

LLM-as-Judge provider settings via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_JUDGE_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `LLM_JUDGE_MODEL` | `qwen3:8b` | Model for judging |
| `MLX_HOST` | — | Override for MLX endpoint |

Python SHAP deps are not auto-installed. Run `pip install -r scripts/requirements-xai.txt` when XAI explanations are needed.

## API

See [API Reference](api.md#aiqa-evaluation) for all 16 AIQA endpoints with request/response schemas.

## Dashboard

The **AIQA Quality Panel** is accessible from any agent detail view. It shows:

- Quality score (0–100) calculated from open findings severity
- Per-agent scorecards (phase, findings, tasks, tokens)
- Eval check status (tool-call format, evidence, handoff health, hallucination risk, token efficiency, eval coverage)
- Eval suite results (pass/fail with per-example breakdowns)
- Registered datasets
- Hallucination risk signals
- Financial controls dashboard (money-path tests, regulated data redaction, approval integrity, provider policy, audit evidence)
- Top-open findings with severity, owner, and evidence

The **Run Eval Sweep** button files new AIQA findings as task pills in `.aiqa-status.json`.

## Telemetry integrity & known gaps

AIQA's scorecard is only as trustworthy as the signals feeding it. The most important
trait to remember when reading it: **a metric reading zero is not the same as healthy.**

### Token ledger ≠ all token spend

- The scorecard's per-agent `tokenTotal`, the summary total, and the high-burn findings
  all read the **DB token ledger** via `dbGetLedgerRows()` (`routes/aiqa.ts`).
- A ledger row is only written when an agent has a `storyNumber` set
  (`tokens.ts` guards `recordStoryTokens` behind `if (storyNumber && …)`).
- **Consequence:** tokens burned in self-directed / story-less work — including AIQA's own
  loop — are written to `.{agent}-status.json` (`tokens` field) but **never reach the
  ledger**. The ledger can therefore read as `0` while real spend is happening, and the
  high-burn findings (`>25k` / `>100k`) never fire.

This is a **silent-failure blind spot**: the suite ships `monitorSilentFailure`
(`confidence-monitor.ts`) for confidence distributions, but nothing yet applies that idea
to token telemetry. Until it does, treat a flat/zero ledger on active agents as a
*broken-tracking* finding, not as "low usage." See `skills/aiqa/SKILL.md` → "Verify your
own telemetry is alive."

**Fix direction (owner: `backend`):** record story-less usage to the ledger too, or have
the scorecard fall back to the per-agent status-file `tokens` when no ledger rows exist.
