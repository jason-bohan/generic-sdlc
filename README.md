# SDLC Framework

**SDLC Framework** (Irish: *cooperative workgroup*) is a multi-agent SDLC automation platform. Six autonomous AI agents collaborate on software projects end-to-end — from story creation through coding, PR review, CI, and merge — with zero human intervention or full step-by-step control.

Built on top of Azure DevOps and Agility (Digital.ai), SDLC Framework turns any AI-powered IDE workspace into a fully staffed engineering team. Works with **Cursor**, **Claude Code**, **Goose**, or any CLI-driven agent via a configurable driver.

---

## How It Works

```
  Story ──→ Code ──→ PR ──→ Review ──→ Build ──→ Merge
   (ux)   (frontend)  │    (reviewer)  (devops)    │
                       └──── feedback loop ─────────┘
```

1. A **story** is created in Agility (Digital.ai) and assigned to an agent
2. The agent reads the story, analyzes the codebase, generates code, and pushes a **feature branch**
3. A **PR** is created in Azure DevOps — the reviewer agent picks it up automatically
4. On approval, the **DevOps** agent monitors the CI build pipeline
5. On build pass, the PR **auto-completes** and the story owner wraps up

The entire pipeline is observable from a real-time dashboard (2D card view or 3D isometric office) and controllable via step mode, execution modes, and per-agent configuration.

---

## Agents

| ID | Default Name | Role | Status |
|----|-------------|------|--------|
| `frontend` | Lasair | Frontend Engineer | Active |
| `backend` | Cairn | Backend Engineer | Active |
| `qa` | Vigil | QA Engineer | Active |
| `ux` | Prism | UX / Design | Active |
| `reviewer` | Brehon | PR Reviewer | Active |
| `devops` | Cairde | DevOps | Active |

**IDs are role-based and stable** — they appear in config keys, status files (`.frontend-status.json`), API payloads, and skill directories (`skills/frontend/SKILL.md`).

**Display names are customizable.** The defaults above (Lasair, Cairn, Vigil, etc.) can be changed per-user in the dashboard (double-click an agent name) or in config via `scheduler.agents.<id>.displayName`. Custom names persist across sessions and propagate to Teams notifications, the TUI, and all dashboard views.

### What Each Agent Does

- **`frontend`** — Picks up stories from Agility, reads codebase context, generates Angular/TypeScript code, creates PRs. Supports step mode for phase-by-phase control.
- **`reviewer`** — Auto-assigned when a PR is created. Reviews code, posts inline comments, approves or requests changes. Drives ADO vote API.
- **`devops`** — Monitors Azure DevOps CI pipelines after PR approval. Reports build pass/fail, triggers PR completion on success.
- **`ux`** — Produces design specs (`.ux-design-spec.md`) with Figma references, WCAG AA audits, and component breakdowns. Hands off to the frontend agent for implementation.
- **`qa`** — Runs Cypress tests, triages failures, generates new test specs. Test results visible on the dashboard with per-spec pass/fail breakdowns.
- **`backend`** — Picks up stories involving .NET / ASP.NET Core / C# backend work in the YourProject repo. Analyzes solution structure, generates code, runs `dotnet build` / `dotnet test`, and creates PRs.

---

## Quick Start

### Prerequisites

| Requirement | Version | Notes |
|------------|---------|-------|
| **Node.js** | 22.x (`>=22.0.0 <24.0.0`) | Must match target project (YourProject) |
| **Cursor** | Latest (optional) | Default driver — MCP servers auto-configured via `.cursor/mcp.json` |
| **Claude Code** | Latest (optional) | Alternative driver — set `scheduler.driver: "claude-code"` |
| **Ollama** | Latest (optional) | Local AI — setup script installs if missing |
| **Goose CLI** | Latest (optional) | Local execution mode — setup script installs |
| **MeshLLM** | Latest (optional) | Cloud inference acceleration — server falls back to Ollama if absent |
| **Python 3.11+** | Optional | For Harlequin SQLite TUI (`pip install harlequin`) |
| **Python 3.12 + CUDA GPU** | Optional | For Unsloth fine-tuning (`ml/unsloth/`) |
| **Rust** | Optional | Only needed for Tauri desktop build |

### Setup

```powershell
# Clone and install
git clone <repo-url> && cd SDLC Framework
.\bin\setup.ps1     # installs deps, creates .env, configures PATH, checks Ollama
```

The setup script will prompt for **workspace paths** — where your project repos live on disk. These are critical: agents use them to read coding standards, browse project structure, and run tests.

### Run

```powershell
# API server + dashboard together
npm run dev

# Or separately
npm run server      # API on port 3001
npm run dashboard   # Dashboard on port 3847 (proxies /api → 3001)

# TUI (terminal interface)
sdlc-framework
sdlc-framework --test     # with mock integrations (no real ADO/Teams calls)
```

### Verify

- **Dashboard** — open http://localhost:3847
- **API docs (Scalar)** — open http://localhost:3001
- **SQLite TUI** — `npm run db` (requires Harlequin)
- **Tests** — `npm test` (198 Vitest unit tests)
- **Cypress** — `npm run cypress:open` (dashboard E2E tests)

---

## Dashboard

Two views, switchable from the settings gear:

- **Simple Floor** — 2D card grid with agent status, phase badges, story numbers, model pickers, inline chat, and action buttons. This is the primary working view.
- **3D Office** — Interactive isometric office (React Three Fiber) with agent desks, a server room, design studio, and break room. Click desks to zoom in.

Both views support:
- Real-time agent status polling
- Inline agent renaming (double-click)
- Story assignment from Agility backlog
- Step mode toggle per agent
- Cloud/local token usage tracking
- Test result drill-down (QA agent)
- PR status overview with links

Multiple visual themes are available (Far Out, Lumon, Retro Carpet, Modern, Simple).

---

## Configuration

### `.sdlc-framework.config.json`

Copy from `.sdlc-framework.config.example.json` or let `.\bin\setup.ps1` generate it.

```json
{
  "projects": {
    "YourProject": { "workspacePath": "c:\\repos\\YourProject" },
    "sdlc-framework": { "workspacePath": "c:\\repos\\SDLC Framework" }
  },
  "executionMode": "balanced",
  "scheduler": {
    "mode": "notify",
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
| `executionMode` | `local` / `balanced` / `speed` | How story enrichment runs (Ollama, hybrid, or cloud) |
| `cursorAiEnabled` | `true` / `false` | Server-side kill switch for Cursor AI usage; dashboard header can toggle it |
| `scheduler.mode` | `immediate` / `notify` | Auto-start agents on assignment vs. require approval |
| `scheduler.driver` | `cursor` / `claude-code` / `goose` / `generic` | Which IDE CLI agents are spawned through (default: `cursor`) |
| `scheduler.agents.<id>.stepMode` | `true` / `false` | Pause agent after each phase for manual review |
| `scheduler.agents.<id>.displayName` | any string | Custom name shown in dashboard and Teams |
| `scheduler.agents.<id>.model` | model slug | Override which AI model the agent uses |
| `projects.<name>.workspacePath` | absolute path | Where the project repo lives on your machine |

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
| `ADO_PAT` | Azure DevOps personal access token |
| `AGILITY_TOKEN` | Digital.ai / VersionOne API token |
| `TEAMS_WEBHOOK_URL` | Microsoft Teams incoming webhook |
| `OLLAMA_HOST` | Ollama server URL (default `http://localhost:11434`) |
| `MESHLLM_HOST` | Optional MeshLLM OpenAI-compatible server URL (default `http://localhost:9337`) |
| `HF_HOME` | HuggingFace model cache for fine-tuning (optional, set by `ml/unsloth/setup-env.ps1`) |

---

## Agent Knowledge Sources

Agents read from multiple knowledge layers — not just their own skill files:

| Source | What It Provides |
|--------|-----------------|
| **Own Skill** (`skills/<id>/SKILL.md`) | Agent identity, phases, workflow, tools, handoff rules |
| **YourProject Cursor Rules** | 22+ `.mdc` files: Angular, .NET, code review, PR templates, design system |
| **YourProject Cursor Skills** | Nx workspace conventions, generators, task runners, CI monitoring |
| **Azure DevOps Wiki** | Environment details, server info, Cypress setup, team conventions (via MCP) |
| **ADO Code Search** | Search the remote YourProject repository for code patterns (via MCP) |

All paths resolve dynamically from `projects.<name>.workspacePath`. See [Agents & SDLC Pipeline](docs/agents.md#agent-knowledge-sources) for the full breakdown.

---

## Execution Modes

Story creation supports three modes, selectable from the dashboard or config:

| Mode | Engine | Description |
|------|--------|-------------|
| **Local** | Goose + Ollama | Fully local — Goose CLI orchestrates with Ollama SLM |
| **Balanced** | Ollama + REST API | Ollama enriches story fields, REST API creates in Agility |
| **Speed** | Cursor Cloud AI | Cloud-powered enrichment via `cursor agent` CLI |

All modes track token usage per-story in a SQLite ledger visible from the dashboard.

---

## Scripts & Tools

```powershell
.\bin\setup.ps1                # First-run setup
.\bin\run-agent.ps1 -AgentId frontend   # Run an agent autonomously
.\bin\audit-story.ps1          # Audit story status across agents
.\bin\migrate-agent-files.ps1  # Rename legacy status files to role-based names
.\bin\update.ps1               # Check for Node/Ollama/Goose updates
.\bin\test-sdlc-pipeline.ps1   # End-to-end SDLC pipeline integration test
```

```powershell
npm run btw                    # /btw inter-agent messaging CLI
npm run ollama                 # Ollama delegator (generate, embedding, RAG)
npm run pr:watch               # Watch Azure DevOps PRs for changes
npm run plan                   # Generate implementation plans
npm run cypress:YourProject         # Run Cypress against YourProject project
```

---

## Goose Integration

SDLC Framework ships a first-class [MCP server](docs/mcp-sdlc-framework.md) (`tools/mcp-sdlc-framework`) that exposes the full orchestration API as tools. When wired into Goose, it turns Goose into a hands-free operator of the entire SDLC pipeline.

**What you can do from a Goose chat:**

- `"What are all agents working on?"` → snapshot of all six agents in one call
- `"Find a Future story for Istari about the export feature and kick it off"` → searches Agility, fetches detail, assigns to the right agent, and approves
- `"Frontend is paused in step mode — push it to PR"` → `continue_agent` with a phase hint
- `"Switch to local mode before this long run"` → `set_execution_mode`
- `"Are there any stuck workflows?"` → `list_workflows` + `get_agent_status`

The setup script (`bin/setup.ps1`) configures the Goose extension and local Ollama provider automatically.

See [MCP: SDLC Framework SDLC Orchestration](docs/mcp-sdlc-framework.md) for the full tool reference.

---

## Docs

| Document | Contents |
|----------|----------|
| [Agents & SDLC Pipeline](docs/agents.md) | Pipeline, execution modes, scheduler, step mode, Teams, knowledge sources |
| [Local AI, Ollama & MeshLLM](docs/local-ai.md) | Model selection, Modelfile, MeshLLM, RAG indexer, fine-tuning, boot sequence |
| [Dashboard](docs/dashboard.md) | 3D office, Simple Floor, themes, stats bar |
| [API Reference](docs/api.md) | All endpoints with example payloads |
| [MCP: SDLC Framework Orchestration](docs/mcp-sdlc-framework.md) | Goose/Claude Code MCP setup, all tools, usage examples |
| [Developer Tools](docs/developer-tools.md) | Scalar API docs, Bruno, Harlequin, TUI, scripts |
| [Configuration](docs/configuration.md) | `.sdlc-framework.config.json`, `.env`, MCP servers, workspace paths |
| [Project Structure](docs/structure.md) | Directory layout and key files |

---

## Testing

```powershell
npm test              # 212 Vitest unit tests
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
