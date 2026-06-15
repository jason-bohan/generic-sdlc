# SDLC Framework

**SDLC Framework** is a multi-agent SDLC automation platform. Six autonomous AI agents collaborate on software projects end-to-end — from work-item intake through coding, review, CI, and release — with zero human intervention or full step-by-step control.

The API is intentionally integration-agnostic. SDLC Framework models generic SDLC primitives — work items, tasks, branches, review requests, builds, notifications, and releases — then maps them to adapters for tools such as Azure DevOps, Digital.ai Agility, GitHub, Jira, Teams, Slack, or local demo state. It works with **Cursor**, **Claude Code**, **OpenCode**, **Aider**, **Goose**, OpenAI-compatible loop providers, or any CLI-driven agent via a configurable driver.

---

## How It Works

```
  Work Item ──→ Code ──→ Review Request ──→ Review ──→ Build ──→ Release
   (ux)   (frontend)  │    (reviewer)  (devops)    │
                       └──── feedback loop ─────────┘
```

1. A **work item** is created or imported from the configured planning adapter and assigned to an agent
2. The agent reads the work item, analyzes the codebase, generates code, and prepares a **change branch**
3. A **review request** is created through the configured source-control adapter — the reviewer agent picks it up automatically
4. On approval, the **DevOps** agent monitors the configured CI/build adapter
5. On build pass, the change is completed and the work-item owner wraps up

The entire pipeline is observable from a real-time dashboard and controllable via step mode, execution modes, and per-agent configuration.

Adapter examples shipped today include Digital.ai Agility/VersionOne for planning, Azure DevOps for review/build automation, Microsoft Teams notifications, local mock state, Ollama, MeshLLM, and OpenRouter-compatible model routing. These are implementations, not the public API shape.

---

## Agents

| ID | Default Name | Role | Status |
|----|-------------|------|--------|
| `frontend` | Lasair | Frontend Engineer | Active |
| `backend` | Cairn | Backend Engineer | Active |
| `qa` | Vigil | QA Engineer | Active |
| `ux` | Prism | UX / Design | Active |
| `reviewer` | Brehon | Code Reviewer | Active |
| `devops` | Cairde | DevOps | Active |
| `aiqa` | — | AI Quality Assurance | Active |

**IDs are role-based and stable** — they appear in config keys, status files (`.frontend-status.json`), API payloads, and skill directories (`skills/frontend/SKILL.md`).

**Display names are customizable.** The defaults above (Lasair, Cairn, Vigil, etc.) can be changed per-user in the dashboard (double-click an agent name) or in config via `scheduler.agents.<id>.displayName`. Custom names persist across sessions and propagate to notifications, the TUI, and all dashboard views.

### What Each Agent Does

- **`frontend`** — Picks up assigned work items, reads codebase context, generates frontend code, and creates review-ready changes. Supports step mode for phase-by-phase control.
- **`reviewer`** — Auto-assigned when a review request is created. Reviews code, posts inline comments, approves or requests changes through the configured review adapter.
- **`devops`** — Monitors CI pipelines after review approval. Reports build pass/fail and triggers configured completion/release behavior on success.
- **`ux`** — Produces design specs (`.ux-design-spec.md`) with Figma references, WCAG AA audits, and component breakdowns. Hands off to the frontend agent for implementation.
- **`qa`** — Runs Cypress tests, triages failures, generates new test specs. Test results visible on the dashboard with per-spec pass/fail breakdowns.
- **`backend`** — Picks up backend work items, analyzes service structure, generates code, runs the configured build/test commands, and creates review-ready changes.
- **`aiqa`** — AI quality assurance overlay that scores agent outputs, detects hallucinations, performs red-team attacks, runs data drift and confidence monitoring, audits financial-control compliance (regulated data, money paths, provider policy), checks semantic similarity and LLM-as-judge eval, computes asymmetric risk metrics, detects bias (80% rule + intersectional), and generates SHAP/XAI explanations.

---

## AIQA Evaluation Suite

The **AIQA** (AI Quality Assurance) subsystem is a built-in evaluation engine that continuously monitors agent outputs, detects regressions, enforces financial-services compliance controls, and generates actionable findings. It lives at `src/server/aiqa/` and exposes 16 REST endpoints plus a dashboard panel.

### Capabilities

| Module | What It Does |
|--------|-------------|
| **Eval Runner** (`evaluator.ts`) | Executes agent outputs against built-in datasets with pass/fail criteria and scoring |
| **Hallucination Detector** (`hallucination-detector.ts`) | Pattern-matches agent logs, tasks, and outputs for hallucination-like signals (overclaim, contradiction, non-reproducible assertions) |
| **Red Team** (`red-teamer.ts`) | Runs 12 adversarial scenarios (prompt injection, data extraction, role-playing, refusal bypass). Also generates OOD perturbation variants and stratified eval samples |
| **Semantic Similarity** (`semantic-similarity.ts`) | TF-IDF cosine, n-gram overlap, and word-order scorers for expected-vs-actual output comparison |
| **LLM-as-Judge** (`judge.ts`) | Calls Ollama/MLX REST API to score agent outputs on correctness, completeness, clarity, and conciseness; keyword-based fallback when LLM is unavailable |
| **Data Drift** (`data-drift.ts`) | Two-sample Kolmogorov-Smirnov test with exact p-value, PSI with 10 bins, schema compliance validation |
| **Confidence Monitoring** (`confidence-monitor.ts`) | Score distribution statistics (mean, percentiles, skew, kurtosis), shift detection (>15%), silent-failure detection (>30% low-confidence or ≥5 consecutive low samples) |
| **Asymmetric Risk Metrics** (`risk-metrics.ts`) | Domain-specific risk weighting (credit-scoring: FP 3×, fraud-detection: FN 5×, trading, general); optimal threshold scan 0.1–0.9 |
| **Bias / Fair Lending** (`bias-detector.ts`) | Adverse Impact Ratio (80% rule), intersectional AIR across protected groups, mutation testing on synthetic profiles |
| **Financial Guardrails** (`financial-guardrails.ts`) | Regex detection of speculative advice, unlicensed advice, and regulated-activity patterns; computation separation validation; adversarial prompt generation |
| **XAI / SHAP** (`xai-engine.ts` + `scripts/xai-explainer.py`) | Python SHAP KernelExplainer for per-profile feature importance, waterfall explanations, and compliance-ready reason codes |

### Quick Reference

```powershell
# Scorecard (summary of all agents + findings)
GET  /api/aiqa/scorecard
POST /api/aiqa/sweep                    # File findings as task pills

# Core eval
GET  /api/aiqa/eval                     # Run all eval datasets
GET  /api/aiqa/eval/datasets
GET  /api/aiqa/hallucinations
GET  /api/aiqa/redteam
POST /api/aiqa/redteam/run

# Semantic + LLM-as-Judge
POST /api/aiqa/eval/semantic            # expected vs actual similarity
POST /api/aiqa/eval/judge               # LLM-scored quality criteria

# Drift + Confidence
POST /api/aiqa/drift                    # KS test + PSI
POST /api/aiqa/drift/schema             # Schema compliance
POST /api/aiqa/confidence               # Distribution shift
POST /api/aiqa/confidence/silent-failure

# OOD + Stratified
POST /api/aiqa/ood                      # Out-of-distribution variants
POST /api/aiqa/stratified               # Stratified sampling

# Financial
GET  /api/aiqa/risk-metrics             # Domain configs
POST /api/aiqa/risk-metrics/evaluate
POST /api/aiqa/bias                     # Adverse Impact Ratio
POST /api/aiqa/bias/intersectional      # Intersectional AIR
POST /api/aiqa/guardrails               # Check output for prohibited patterns
GET  /api/aiqa/guardrails/prompts       # Adversarial test prompts
POST /api/aiqa/guardrails/schema        # JSON schema validation

# XAI
POST /api/aiqa/xai                      # SHAP explanation for profiles
GET  /api/aiqa/xai/status               # SHAP dependency availability
```

See [API Reference](docs/api.md#aiqa-evaluation) for request/response schemas.

---

## Quick Start

### Prerequisites

| Requirement | Version | Notes |
|------------|---------|-------|
| **Node.js** | 22.x (`>=22.0.0 <24.0.0`) | Must match the target workspace runtime |
| **Cursor** | Latest (optional) | Agent driver option — MCP servers auto-configured via `.cursor/mcp.json` |
| **Claude Code** | Latest (optional) | Alternative driver — set `scheduler.driver: "claude-code"` |
| **OpenCode** | Latest (optional) | Alternative driver — set `scheduler.driver: "opencode"` |
| **Aider** | Latest (optional) | Headless/local coding driver — set `scheduler.driver: "aider"` |
| **Ollama** | Latest (optional) | Local AI — setup script installs if missing |
| **Goose CLI** | Latest (optional) | Local execution mode — setup script installs |
| **MeshLLM** | Latest (optional) | Cloud inference acceleration — server falls back to Ollama if absent |
| **Python 3.11+** | Optional | For Harlequin SQLite TUI (`pip install harlequin`) |
| **Python 3.12 + CUDA GPU** | Optional | For Unsloth fine-tuning (`ml/unsloth/`) |
| **Rust** | Optional | Only needed for Tauri desktop build |

### Setup

```bash
# Clone and install
git clone <repo-url> && cd sdlc-framework
nvs use 22
npm run setup       # installs deps, creates .env/config, checks optional tools
```

The setup script is **interactive** and configures the framework for *your* stack:

- **Pick your stack** — choose a project tracker (GitHub · Linear · Azure DevOps · Agility · Mock), a code host for PRs (GitHub · Azure DevOps), and chat notifications (None · Slack · Teams). Setup composes `.mcp.json` with the right MCP servers, sets the `PM_PROVIDER`/`NOTIFY_PROVIDER` selectors in `.env`, installs any package an MCP needs (e.g. `linear-mcp`), and lists the credentials you still need to fill in. No custom code — it just wires the existing MCPs/APIs/CLIs for what you chose. Adding a new product later is a single entry in the `STACK_CATALOG` in `scripts/setup.cjs`.
- **Workspace paths** — where your project repos live on disk. These are critical: agents use them to read coding standards, browse project structure, and run tests.

### Run

```powershell
# API server + dashboard together
npm run dev

# Or separately
npm run server      # API on port 3001
npm run dashboard   # Dashboard on port 3847 (proxies /api → 3001)

# TUI (terminal interface)
sdlc-framework
sdlc-framework --test     # with mock integrations (no live planning/review/notification calls)
```

### Verify

- **Dashboard** — open http://localhost:3847
- **API docs (Scalar)** — open http://localhost:3001
- **SQLite TUI** — `npm run db` (requires Harlequin)
- **Tests** — `npm test` (Vitest unit and integration tests)
- **Cypress** — `npm run cypress:open` (dashboard E2E tests)

---

## Dashboard

The **Simple Floor** is a 2D card grid with agent status, phase badges, work-item keys, model pickers, inline chat, and action buttons.

It supports:
- Real-time agent status polling
- Inline agent renaming (double-click)
- Work-item assignment from the configured planning adapter
- Step mode toggle per agent
- Cloud/local token usage tracking
- Test result drill-down (QA agent)
- Review-request status overview with links

Multiple visual themes are available (Far Out, Lumon, Retro Carpet, Modern, Simple).

---

## Configuration

### `.sdlc-framework.config.json`

Copy from `.sdlc-framework.config.example.json`, or let `npm run setup` generate it.

```json
{
  "projects": {
    "YourProject": { "workspacePath": "c:\\repos\\YourProject" },
    "sdlc-framework": { "workspacePath": "c:\\repos\\SDLC Framework" }
  },
  "executionMode": "balanced",
  "cursorAiEnabled": false,
  "scheduler": {
    "mode": "notify",
    "driver": "loop",
    "loopProvider": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "qwen3:8b",
      "apiKey": ""
    },
    "agents": {
      "frontend": { "autoStart": false, "stepMode": false, "displayName": "Lasair" },
      "reviewer": { "autoStart": false, "stepMode": false },
      "devops":   { "autoStart": false, "stepMode": false },
      "ux":       { "autoStart": false, "stepMode": false },
      "backend":  { "autoStart": false, "stepMode": false },
      "qa":       { "autoStart": false, "stepMode": false }
    }
  },
  "notifications": {
    "teams": { "webhookUrl": "https://your-org.webhook.office.com/..." }
  }
}
```

### Key Settings

| Setting | Values | Description |
|---------|--------|-------------|
| `executionMode` | `local` / `balanced` / `speed` | How work-item enrichment runs (Ollama, hybrid, or cloud) |
| `cursorAiEnabled` | `true` / `false` | Server-side kill switch for Cursor AI usage; dashboard header can toggle it |
| `scheduler.mode` | `notify` / `autonomous` | Require approval after assignment vs. start immediately |
| `scheduler.driver` | `cursor` / `claude-code` / `opencode` / `aider` / `goose` / `generic` / `loop` | Which CLI or loop provider agents are spawned through; setup detects the best available option |
| `scheduler.loopProvider.baseUrl` | OpenAI-compatible `/v1` URL | Routes the in-process `loop` driver and inline queries to Ollama, MeshLLM, OpenRouter, or another compatible provider |
| `scheduler.loopProvider.model` | model slug | Default model for `loop`, Aider inline queries, and OpenAI-compatible routing |
| `scheduler.agents.<id>.stepMode` | `true` / `false` | Pause agent after each phase for manual review |
| `scheduler.agents.<id>.driver` | driver name | Optional per-agent driver override, such as routing `reviewer` through `opencode` |
| `scheduler.agents.<id>.displayName` | any string | Custom name shown in dashboard and notifications |
| `scheduler.agents.<id>.model` | model slug | Override which AI model the agent uses |
| `projects.<name>.workspacePath` | absolute path | Where the project repo lives on your machine |

### OpenCode Driver

OpenCode is a supported scheduler driver for agent coding sessions. Use it globally:

```json
{
  "scheduler": {
    "driver": "opencode"
  }
}
```

Or route one agent to OpenCode while the rest use the global driver:

```json
{
  "scheduler": {
    "driver": "loop",
    "agents": {
      "reviewer": { "driver": "opencode", "model": "auto" }
    }
  }
}
```

OpenCode can be disabled with `opencodeEnabled: false` in config or `SDLC_FRAMEWORK_OPENCODE=0`. If Cursor, Claude Code, or OpenCode are disabled or unavailable, the scheduler falls back toward Aider, Goose, then the in-process `loop` driver.

### MeshLLM Routing

MeshLLM is supported as an OpenAI-compatible model endpoint. Point `MESHLLM_HOST` at a MeshLLM server, or configure the loop provider directly:

```json
{
  "scheduler": {
    "driver": "loop",
    "loopProvider": {
      "baseUrl": "http://localhost:9337/v1",
      "model": "auto",
      "apiKey": "meshllm",
      "maxTokens": 4096,
      "temperature": 0.2
    }
  }
}
```

The API exposes `GET /api/meshllm/health`, `GET /api/meshllm/models`, `GET /api/meshllm/nodes`, `POST /api/meshllm/nodes/select`, and `POST /api/meshllm/generate`. MeshLLM token usage is tracked separately from cloud and Ollama usage in the dashboard.

### Workspace Paths

**`workspacePath` must be set correctly for each project.** Agents use it to:
- Read coding standards (`.cursor/rules/*.mdc`) from the target repo
- Browse Nx skills, generators, and `AGENTS.md`
- Run and analyze Cypress tests in the target project
- Search code patterns in the local codebase

If your YourProject repo is at `d:\projects\YourProject` instead of `c:\repos\YourProject`, update the path accordingly. The fallback `GET /api/project/standards?project=YourProject` auto-discovers standards at runtime but costs extra tokens.

### Environment Variables (`.env`)

Created by setup. Key vars:

| Variable | Purpose |
|----------|---------|
| `ADO_PAT` | Optional Azure DevOps adapter token |
| `AGILITY_TOKEN` | Optional Digital.ai / VersionOne planning adapter token |
| `TEAMS_WEBHOOK_URL` | Optional Microsoft Teams notification webhook |
| `OLLAMA_HOST` | Ollama server URL (default `http://localhost:11434`) |
| `MESHLLM_HOST` | Optional MeshLLM OpenAI-compatible server URL (default `http://localhost:9337`) |
| `MESHLLM_START_COMMAND` | Optional command used by the dashboard to start a local MeshLLM service |
| `SDLC_FRAMEWORK_OPENCODE` | Set to `0` to block OpenCode usage even when configured |
| `HF_HOME` | HuggingFace model cache for fine-tuning (optional, set by `ml/unsloth/setup-env.ps1`) |

---

## Agent Knowledge Sources

Agents read from multiple knowledge layers — not just their own skill files:

| Source | What It Provides |
|--------|-----------------|
| **Own Skill** (`skills/<id>/SKILL.md`) | Agent identity, phases, workflow, tools, handoff rules |
| **Target Repo Rules** | `.mdc`, `AGENTS.md`, or project-local standards files: framework, review, change-management, and design-system conventions |
| **Target Repo Skills** | Workspace conventions, generators, task runners, and CI monitoring notes |
| **Knowledge/Wiki Adapters** | Environment details, server info, test setup, and team conventions from whichever knowledge source is configured |
| **Code Search Adapters** | Local or remote code-search providers for reusable patterns |

All paths resolve dynamically from `projects.<name>.workspacePath`. See [Agents & SDLC Pipeline](docs/agents.md#agent-knowledge-sources) for the full breakdown.

---

## Demo Presets

Professional demos should be repeatable without hardcoding one customer's tools into the API. Use seed profiles for demo data instead of building a bespoke configuration UI for every scenario.

Recommended structure:

```text
data/
  presets/
    golden-agile-backlog.json
```

Run a demo by selecting a preset at startup:

```powershell
$env:PM_PROVIDER = "mock"
$env:DEMO_PRESET = "golden-agile-backlog"
npm run dev
```

A preset should map external concepts into the generic SDLC model: work items, tasks, people/teams, review requests, builds, notifications, and release states. Tool names belong in the adapter/preset layer; route handlers and dashboard copy should stay generic wherever possible.

---

## Execution Modes

Work-item creation supports three modes, selectable from the dashboard or config:

| Mode | Engine | Description |
|------|--------|-------------|
| **Local** | Goose + Ollama | Fully local — Goose CLI orchestrates with Ollama SLM |
| **Balanced** | Ollama/MeshLLM + REST API | Local or MeshLLM-compatible inference enriches work-item fields, REST API writes through the configured planning adapter |
| **Speed** | Active agent driver | Cloud or CLI-powered enrichment via the configured `scheduler.driver`, including OpenCode when selected |

All modes track token usage per work item in a SQLite ledger visible from the dashboard.

---

## Scripts & Tools

```bash
npm run setup                  # First-run setup on macOS, Linux, or Windows
./bin/setup.sh                 # Same setup flow for POSIX shells
.\bin\setup.ps1                # Legacy Windows PowerShell setup
.\bin\run-agent.ps1 -AgentId frontend   # Run an agent autonomously
.\bin\audit-story.ps1          # Audit work-item status across agents
.\bin\migrate-agent-files.ps1  # Rename legacy status files to role-based names
.\bin\update.ps1               # Check for Node/Ollama/Goose updates
.\bin\test-sdlc-pipeline.ps1   # End-to-end SDLC pipeline integration test
```

```powershell
npm run btw                    # /btw inter-agent messaging CLI
npm run ollama                 # Ollama delegator (generate, embedding, RAG)
npm run docker:up:meshllm      # Start the optional local MeshLLM Compose service
npm run pr:watch               # Watch configured review requests for changes
npm run plan                   # Generate implementation plans
npm run cypress:YourProject    # Run Cypress against YourProject project
npx tsx src/server/aiqa/scripts/run-eval.ts   # CLI eval runner
npx tsx src/server/aiqa/scripts/run-judge.ts  # CLI LLM-as-judge evaluation
npx tsx src/server/aiqa/scripts/run-drift.ts  # CLI data drift scan
pip install -r scripts/requirements-xai.txt   # Python deps for SHAP explainer
```

---

## Goose Integration

SDLC Framework ships a first-class [MCP server](docs/mcp-sdlc-framework.md) (`tools/mcp-sdlc-framework`) that exposes the full orchestration API as tools. When wired into Goose, it turns Goose into a hands-free operator of the entire SDLC pipeline.

**What you can do from a Goose chat:**

- `"What are all agents working on?"` → snapshot of all six agents in one call
- `"Find a future work item about the export feature and kick it off"` → searches the planning adapter, fetches detail, assigns to the right agent, and approves
- `"Frontend is paused in step mode — push it to review"` → `continue_agent` with a phase hint
- `"Switch to local mode before this long run"` → `set_execution_mode`
- `"Are there any stuck workflows?"` → `list_workflows` + `get_agent_status`

The legacy Windows setup script (`bin/setup.ps1`) configures the Goose extension and local Ollama provider automatically. The cross-platform setup (`npm run setup`) checks for those tools and creates the project files, but leaves tool-specific provider configuration to the tool CLIs.

See [MCP: SDLC Framework SDLC Orchestration](docs/mcp-sdlc-framework.md) for the full tool reference.

---

## Docs

| Document | Contents |
|----------|----------|
| [Agents & SDLC Pipeline](docs/agents.md) | Pipeline, execution modes, scheduler, step mode, notification adapters, knowledge sources |
| [Local AI, Ollama & MeshLLM](docs/local-ai.md) | Model selection, Modelfile, MeshLLM, RAG indexer, fine-tuning, boot sequence |
| [Dashboard](docs/dashboard.md) | Simple Floor, themes, stats bar |
| [API Reference](docs/api.md) | All endpoints with example payloads |
| [MCP: SDLC Framework Orchestration](docs/mcp-sdlc-framework.md) | Goose/Claude Code MCP setup, all tools, usage examples |
| [Developer Tools](docs/developer-tools.md) | Scalar API docs, Bruno, Harlequin, TUI, scripts |
| [Configuration](docs/configuration.md) | `.sdlc-framework.config.json`, `.env`, MCP servers, workspace paths |
| [AIQA Evaluation](docs/aiqa.md) | Eval methodology, drift thresholds, bias audit procedures, XAI setup |
| [Project Structure](docs/structure.md) | Directory layout and key files |

---

## Testing

```powershell
npm test              # Vitest unit and integration tests
npm run test:watch    # Watch mode
npm run cypress:run   # Headless Cypress (dashboard E2E)
npm run cypress:open  # Interactive Cypress runner
```

---

## Migration from Codename IDs

If upgrading from an earlier version that used codename-based agent IDs (`lasair`, `vigil`, `brehon`, etc.), run the migration script to rename your status and message files:

```powershell
.\bin\migrate-agent-files.ps1
```

This renames `.lasair-status.json` → `.frontend-status.json`, `.brehon-messages.json` → `.reviewer-messages.json`, etc. Only renames files when the new-name file doesn't already exist.

---

## License

Private — OSV internal use.
