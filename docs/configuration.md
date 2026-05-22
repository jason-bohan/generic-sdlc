# Configuration

## `.sdlc-framework.config.json`

The main configuration file. Copy from `.sdlc-framework.config.example.json` to get started.

```json
{
  "project": {
    "organization": "your-azure-devops-org",
    "azureProject": "YourProject",
    "repositoryId": "YourRepo",
    "scope": "Your Team",
    "team": "Your Team",
    "owners": ["Your Name"]
  },
  "executionMode": "balanced",
  "scheduler": {
    "mode": "notify",
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
| `scheduler.mode` | `notify`, `autonomous` | Auto-start vs approval gate |
| `scheduler.driver` | `cursor`, `claude-code`, `goose`, `generic` | IDE / CLI used to spawn agents and run inline queries (default: `cursor`) |
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
| `cursor` | `cursor-agent` CLI | Default. Requires Cursor installation. Uses `bin/run-agent.ps1`. |
| `claude-code` | `claude` CLI | `npm install -g @anthropic-ai/claude-code`. Uses `bin/run-agent-claude.ps1`. |
| `goose` | `goose` CLI | Local/Ollama model. Requires Goose at `~/.local/bin/goose.exe`. |
| `generic` | configurable | Specify command + args with `{promptFile}`, `{workspaceDir}`, `{model}` placeholders. |

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

Hook triggers work the same regardless of driver. If using **Claude Code**, `.claude/settings.json` is pre-configured with the same `Stop` hooks as `.cursor/hooks.json`. If using another IDE, POST to `POST /api/hook/agent-stop` with `{ "agentId": "<id>" }` to trigger the watcher logic from any context.

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

**This must be set correctly.** The setup script (`.\bin\setup.ps1`) prompts for it, or set it manually. Agents use workspace paths to:

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
```

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

No manual MCP configuration needed — run `.\bin\setup.ps1` and fill in `.env`.

---

## Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| Node.js 22+ | Yes | `>=22.0.0 <24.0.0` — must match YourProject |
| Cursor | Yes | MCP servers auto-configured |
| Ollama | Optional | Local AI inference |
| Goose CLI | Optional | Local execution mode |
| Python 3.11+ | Optional | Harlequin TUI (`pip install harlequin`) |
| Cypress 15.x | Optional | QA testing — installed via `npm install` |
| Rust | Optional | Tauri desktop build only |

---

## Setup Script

```powershell
.\bin\setup.ps1
```

Handles:
1. Verifying Node.js 22+
2. Checking for / installing Goose CLI
3. Checking for / installing Ollama + pulling `qwen3:14b`
4. Checking for / installing Cursor CLI (`agent`)
5. Checking for / installing Harlequin (SQLite TUI)
6. `npm install` (installs MCP server deps via `postinstall`)
7. Installing MCP server dependencies
8. Creating `.env` from `.env.example` (prompts for Agility + ADO credentials)
9. Creating `.sdlc-framework.config.json` from example template
10. **Configuring project workspace paths** — validates each project's `workspacePath`, prompts for corrections, auto-discovers YourProject coding standards and Cypress specs
11. Adding `bin/` to PowerShell `$PROFILE`

### Updating

```powershell
.\bin\update.ps1          # Update everything
.\bin\update.ps1 -DryRun  # See what's outdated
```
