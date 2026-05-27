# Configuration

## `.sdlc-framework.config.json`

The main configuration file. Copy from `.sdlc-framework.config.example.json` to get started.

```json
{
  "externalMode": "live",
  "cursorAiEnabled": false,
  "activeProject": "sdlc-framework",
  "projects": {
    "sdlc-framework": {
      "organization": "your-azure-devops-org",
      "azureProject": "YourProject",
      "repositoryId": "YourRepo",
      "targetBranch": "main",
      "workspacePath": "",
      "scope": "Your Team",
      "team": "Your Team",
      "owners": ["Your Name"]
    }
  },
  "executionMode": "local",
  "scheduler": {
    "mode": "notify",
    "driver": "loop",
    "loopProvider": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "qwen3:8b",
      "apiKey": ""
    },
    "agents": {
      "frontend": { "autoStart": false, "stepMode": false },
      "reviewer": { "autoStart": false, "stepMode": false },
      "devops": { "autoStart": false, "stepMode": false },
      "ux": { "autoStart": false, "stepMode": false },
      "backend": { "autoStart": false, "stepMode": false },
      "qa": { "autoStart": false, "stepMode": false }
    }
  },
  "notifications": {
    "teams": {
      "webhookUrl": "https://your-org.webhook.office.com/..."
    }
  }
}
```

### Key Options

| Key | Values | Description |
|-----|--------|-------------|
| `executionMode` | `local`, `balanced`, `speed` | Story creation engine |
| `cursorAiEnabled` | `true`, `false` | Server-side kill switch for Cursor AI usage; dashboard header can toggle it |
| `scheduler.mode` | `notify`, `autonomous` | Approval gate vs immediate start |
| `scheduler.driver` | `cursor`, `claude-code`, `opencode`, `aider`, `goose`, `generic`, `loop` | CLI or in-process provider used to spawn agents and run inline queries |
| `scheduler.agents.<id>.autoStart` | `true`/`false` | Skip approval for this agent |
| `scheduler.agents.<id>.stepMode` | `true`/`false` | Pause at phase boundaries |
| `scheduler.agents.<id>.stepModePhases` | `string[]` | Override default pause phases |
| `scheduler.agents.<id>.adoPat` | string | Per-agent Azure DevOps PAT |
| `scheduler.agents.<id>.model` | string | AI model for this agent (e.g. `gpt-5-mini`, `auto`) |
| `scheduler.agents.<id>.displayName` | string | Optional dashboard label override (defaults: Lasair, Brehon, …). `<id>` is always `frontend`, `reviewer`, `devops`, `ux`, `backend`, or `qa`. |

### Agent Driver (`scheduler.driver`)

Controls which CLI is used to spawn agents and run inline AI queries. All drivers use the same SDLC contracts, status files, and hook system — only the process invocation changes.

| Driver | CLI required | Notes |
|--------|-------------|-------|
| `loop` | none | In-process OpenAI-compatible loop provider. Configure `scheduler.loopProvider`. |
| `cursor` | `cursor-agent` CLI | Uses Cursor where available. On Windows it can use `bin/run-agent.ps1`. |
| `claude-code` | `claude` CLI | Uses `bin/run-agent-claude.ps1` on Windows. |
| `opencode` | `opencode` CLI | Alternative coding CLI; can be disabled with `SDLC_FRAMEWORK_OPENCODE=0`. |
| `aider` | `aider` CLI | Headless coding-session driver; inline queries use the loop provider. |
| `goose` | `goose` CLI | Local/Ollama-oriented driver. |
| `generic` | configurable | Specify command + args with `{promptFile}`, `{workspaceDir}`, `{model}`, and `{agentId}` placeholders. |

### Cursor AI Kill Switch

Set `cursorAiEnabled: false` in `.sdlc-framework.config.json`, set `SDLC_FRAMEWORK_CURSOR_AI=0`, or use the dashboard header toggle to block Cursor AI usage. When blocked, SDLC Framework will not query Cursor for models, will not use Cursor for inline help/chat/story enrichment, and will not fall back to Cursor for agent spawning.

If `scheduler.driver` is still `cursor`, SDLC Framework routes agent work through the in-process `loop` driver instead. Configure `scheduler.loopProvider` to point at an OpenAI-compatible provider such as Ollama `/v1`, MeshLLM `/v1`, or OpenRouter. The same values can also come from `LOOP_PROVIDER_BASE_URL`, `LOOP_PROVIDER_MODEL`, `LOOP_PROVIDER_API_KEY`, or `OPENROUTER_API_KEY`.

```json
{
  "cursorAiEnabled": false,
  "scheduler": {
    "driver": "cursor",
    "loopProvider": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "deepseek/deepseek-chat",
      "apiKey": "your-openrouter-key"
    }
  }
}
```

**Claude Code example:**
```json
{
  "scheduler": {
    "driver": "claude-code"
  }
}
```

**Generic example** (any CLI that accepts a prompt file):
```json
{
  "scheduler": {
    "driver": "generic",
    "genericDriver": {
      "command": "my-agent-cli",
      "args": ["-p", "{promptFile}", "--workspace", "{workspaceDir}", "--model", "{model}"]
    }
  }
}
```

Hook triggers work the same regardless of driver. If using **Claude Code**, `.claude/settings.local.json` can be configured with the same `Stop` hooks as `.cursor/hooks.json`. If using another IDE, POST to `/api/hook/agent-stop` with `{ "agentId": "<id>" }` to trigger the watcher logic from any context.

### Project Workspace Paths

Each project profile must have a `workspacePath` pointing to the local repo checkout:

```json
{
  "projects": {
    "YourProject": {
      "workspacePath": "c:\\repos\\YourProject",
      ...
    },
    "sdlc-framework": {
      "workspacePath": "c:\\repos\\SDLC Framework",
      ...
    }
  }
}
```

**This must be set correctly.** The setup script (`npm run setup`) prompts for it, or set it manually. Agents use workspace paths to:

- Read coding standards (`.cursor/rules/*.mdc`) from the target project
- Read Cursor skills (`.cursor/skills/*/SKILL.md`) for Nx and tooling guidance
- Read `AGENTS.md` for project-level agent instructions
- Run and analyze Cypress tests in the correct directory
- Search code patterns in the local codebase

If `workspacePath` is missing or wrong, agents fall back to `GET /api/project/standards?project=<name>` which auto-discovers standards at runtime but uses more tokens.

### Project Standards Discovery API

```
GET /api/project/standards?project=YourProject
```

Returns all discovered rules, skills, and key paths for the given project:

```json
{
  "project": "YourProject",
  "workspacePath": "c:\\repos\\YourProject",
  "rules": [
    { "name": "angular-standards.mdc", "path": "c:\\repos\\YourProject\\src\\YourProject.Web\\.cursor\\rules\\angular-standards.mdc" },
    { "name": ".net-standards.mdc", "path": "c:\\repos\\YourProject\\src\\.cursor\\rules\\.net-standards.mdc" }
  ],
  "skills": [
    { "name": "nx-workspace", "path": "c:\\repos\\YourProject\\src\\YourProject.Web\\.cursor\\skills\\nx-workspace\\SKILL.md" }
  ],
  "keyPaths": {
    "workspace": "c:\\repos\\YourProject",
    "angular_frontend": "c:\\repos\\YourProject\\src\\YourProject.Web",
    "cypress_tests": "c:\\repos\\YourProject\\integration_test"
  }
}
```

---

## `.env`

Copy from `.env.example`. Required variables:

```env
# Agility (VersionOne)
V1_BASE_URL=https://your-org.digitalai.com
V1_ACCESS_TOKEN=your-agility-token

# Azure DevOps
AZURE_DEVOPS_PAT=your-ado-pat

# Optional
OLLAMA_HOST=http://localhost:11434
LOCAL_LLM_MODEL=qwen3:8b
SDLC_API_PORT=3001
SDLC_EXTERNAL_MODE=   # set to "mock" for local testing
PM_PROVIDER=          # set to "mock" to use the generic mock project tracker
DEMO_PRESET=          # optional preset name from data/presets, e.g. golden-agile-backlog
```

### Demo Presets

Use demo presets when you need a repeatable backlog for demos without building a configuration UI. Presets live in `data/presets/*.json` and map to the generic `WorkItem` provider model.

```bash
PM_PROVIDER=mock DEMO_PRESET=golden-agile-backlog npm run server
```

`DEMO_PRESET` accepts either a bare preset name, resolved as `data/presets/<name>.json`, or a JSON path. The committed `golden-agile-backlog` preset seeds a VerbatimDev-style agile backlog with stories, bug work, teams, acceptance criteria, and frontend/backend/QA lanes.

### Azure DevOps PAT Scopes

Generate at `https://<org>.visualstudio.com/_usersSettings/tokens`:
- **Code** — Read & Write
- **Build** — Read & Execute

---

## MCP Servers

MCP servers are configured in `.cursor/mcp.json` (Cursor) and `.claude/mcp.json` (Claude Code) — both committed. After cloning:

- **Agility MCP** — bundled at `tools/mcp-agility/`. Installed automatically by `npm install` via `postinstall`. Reads credentials from `.env`.
- **Azure DevOps MCP** — installed on-demand via `npx @azure-devops/mcp`.
- **Goose Developer MCP** — requires Goose CLI on PATH.

No manual MCP configuration needed on Windows when using the legacy PowerShell setup — run `.\bin\setup.ps1` and fill in `.env`. On macOS/Linux, run `npm run setup`; it creates the same project files and reports any optional tool configuration you still need to complete.

---

## Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| Node.js 22+ | Yes | `>=22.0.0 <24.0.0` — must match YourProject |
| Cursor | Optional | Agent driver option; MCP servers auto-configured |
| Ollama | Optional | Local AI inference |
| Goose CLI | Optional | Local execution mode |
| Aider/OpenCode/Claude Code | Optional | Alternative agent drivers |
| Python 3.11+ | Optional | Harlequin TUI (`pip install harlequin`) |
| Cypress 15.x | Optional | QA testing — installed via `npm install` |
| Rust | Optional | Tauri desktop build only |

---

## Setup Script

```bash
npm run setup
```

Handles:
1. Verifying Node.js 22+
2. Checking for optional Goose, Ollama, Claude Code, and Harlequin CLIs
3. Detecting an agent driver
4. `npm install` (installs MCP server deps via `postinstall`)
5. Creating `.env` from `.env.example`
6. Creating `.sdlc-framework.config.json` from the example template
7. **Configuring project workspace paths** — validates each project's `workspacePath` and prompts for corrections
8. Optionally adding `bin/` to your shell profile

For noninteractive setup, use:

```bash
npm run setup -- --yes
```

### Updating

```powershell
.\bin\update.ps1          # Update everything
.\bin\update.ps1 -DryRun  # See what's outdated
```
