---
name: office
description: >-
  The Office — multi-agent workspace infrastructure. Activates token-saving
  tools (Goose analyze, Ollama delegation), status dashboard updates, and
  cross-agent coordination. Use when the user says "office", "use the office",
  "save tokens", "use goose", "use ollama", "check in", or you want to reduce
  token consumption during a session.
---

# The Office — Agent Workspace

You are working inside "The Office", the OSV Hub's multi-agent workspace. This skill activates token-saving infrastructure that you should use proactively throughout the conversation.

## Quick Start

When this skill activates:
1. Check if Ollama is running: `curl http://localhost:11434/api/tags`
2. Note which Goose tools are available via `user-goose-developer` MCP
3. Update the status dashboard to show you're online
4. Use the token-saving tools below throughout your session

## Architecture

```
The Office
├── Ev (Engineering Lead, Opus 4.6) ← You
│   ├── Frontend (`frontend`, default Lasair) ← IDE-agnostic skill for frontend stories
│   │   └── Ollama (Local SLM Pool) ← Delegates lightweight tasks
│   ├── Backend (`backend`, default Cairn) ← Placeholder
│   ├── QA (`qa`, default Vigil) ← Placeholder
│   └── UX (`ux`, default Prism) ← Placeholder
└── Goose (Contractor) ← Zero-token codebase analysis, available to all
```

## Token-Saving Protocol

### Tier 1: Goose Analyze (Free)

Before reading files to understand a codebase area, use Goose `analyze` via the `user-goose-developer` MCP:

```
# Get directory structure + file stats (replaces reading 5-10 files)
CallMcpTool: user-goose-developer / analyze
  { "path": "src/YourProject.Web/libs/<feature>", "max_depth": 2 }

# Get call graph for a specific symbol (replaces grep + read chain)
CallMcpTool: user-goose-developer / analyze
  { "path": "src/YourProject.Web/libs/<feature>/shared/src", "focus": "ServiceName" }
```

**When to use**: Exploring unfamiliar modules, understanding dependencies, planning multi-file changes.
**Savings**: ~2k tokens per file read avoided. Typical: 10-20k tokens saved per exploration.

### Tier 2: Ollama Delegation (Local)

For lightweight code generation, delegate to the local Ollama SLM instead of generating with cloud tokens:

```powershell
# From YourProject Web tooling path (often `tools/frontend/` in older layouts):
npx tsx scripts/ollama-delegate.ts --prompt-file prompts/lint-fix.md --context "<error output>"
npx tsx scripts/ollama-delegate.ts --prompt-file prompts/boilerplate.md --context "<component spec>"
npx tsx scripts/ollama-delegate.ts --prompt-file prompts/simple-test.md --context "<source code>"
npx tsx scripts/ollama-delegate.ts --prompt-file prompts/review-response.md --context "<review comment>"
```

**Route to Ollama**: Lint fixes, boilerplate scaffolding, simple unit tests, review responses.
**Keep on cloud**: Multi-file refactors, complex logic, architectural decisions, state management.
**Always validate** Ollama output before using it. Fall back to cloud if quality is poor.

### Tier 3: Cloud Agent (You)

Handle everything Goose and Ollama can't:
- Complex multi-file changes
- Architectural decisions
- Business logic requiring codebase-wide context
- Anything touching routing, shared services, state management

## Status Dashboard

The Office has a Tauri desktop app dashboard. Update the status file so the user can see what you're doing:

**Status file**: For YourProject Office experiments, mirror the frontend agent convention: `.frontend-status.json` (historically some workspaces used paths like `src/YourProject.Web/tools/lasair/`).

Update these fields as you work:
- `currentPhase`: What phase you're in (idle, analyzing, generating-code, etc.)
- `events[]`: Append key milestones with timestamps
- `tokens.cloud`: Estimate your cloud token consumption
- `tokens.ollama`: Track Ollama delegation tokens

```json
{
  "storyNumber": "B-XXXXX",
  "currentPhase": "generating-code",
  "currentTask": "TK-XXXXX",
  "startedAt": "2026-04-30T12:00:00Z",
  "tokens": {
    "cloud": { "input": 15000, "output": 8000 },
    "ollama": { "input": 5000, "output": 3000 }
  },
  "events": [
    { "timestamp": "...", "type": "info", "message": "Analyzing billing module via Goose" },
    { "timestamp": "...", "type": "success", "message": "Delegated lint fix to Ollama, saved ~2k tokens" }
  ]
}
```

## Dynamic Agent Discovery

**NEVER hardcode agent IDs** as a frozen list like `@("frontend", "reviewer")` unless you intentionally scope a one-off script. Prefer discovering `.*-status.json` dynamically (below). Dashboard labels (Lasair, Brehon, …) are cosmetic — files use **`frontend`, `backend`, `qa`, `ux`, `reviewer`, `devops`**.

Instead, discover agents dynamically by scanning `.*-status.json` files in the workspace root:

```powershell
# PowerShell — discover all agents by their status files
$statusFiles = Get-ChildItem -Path $workspace -Filter ".*-status.json" -File -ErrorAction SilentlyContinue
foreach ($sf in $statusFiles) {
    $agentId = $sf.Name -replace '^\.|(-status\.json)$', ''
    # $agentId is now "frontend", "reviewer", "devops", etc.
}
```

To find the **currently active** agent (e.g. for attributing token usage):

```powershell
# Keep in sync with: cloud-token-reporter.ps1, cloud-token-estimator.ps1
$activePhases = @("reading-story", "planning", "analyzing", "generating-code", "validating",
    "creating-pr", "watching-reviews", "addressing-feedback", "running-cypress",
    "reviewing", "commenting", "pending-build", "building")
$statusFiles = Get-ChildItem -Path $workspace -Filter ".*-status.json" -File -ErrorAction SilentlyContinue
foreach ($sf in $statusFiles) {
    $s = Get-Content $sf.FullName -Raw | ConvertFrom-Json
    if ($s.currentPhase -in $activePhases) {
        $agentId = $sf.Name -replace '^\.|(-status\.json)$', ''
        break
    }
}
```

This convention applies to:
- All PowerShell hook scripts (`.cursor/hooks/*.ps1`) — triggered by Cursor stop hooks or Claude Code Stop hooks (`.claude/settings.json`) depending on `scheduler.driver`
- Any utility that iterates over agents (workflow validator, token tracking, etc.)
- TypeScript code should use `AGENT_ROSTER` from `src/dashboard/types.ts` or glob `.*-status.json`

## /btw Chat

Users can message you via the chat panel in the dashboard. Messages land in `.<agentId>-messages.json` (e.g. `.frontend-messages.json`). Between phases, check for new messages and respond.

## Invoking Lasair (Autonomous Mode)

For full autonomous story execution (read story → plan → code → PR → review), invoke the Lasair skill directly. This skill (The Office) is for the infrastructure layer that any conversation can use.

## Decision Flowchart

```
User asks you to do something in the Hub codebase
│
├── Need to understand a module? → Goose analyze (free)
│   └── Still need specific file details? → Read just those files
│
├── Lightweight code task? → Ollama delegate (local)
│   └── Output quality poor? → Fall back to cloud
│
├── Complex task? → Handle it yourself (cloud)
│
└── Update the active agent `.frontend-status.json` (or the relevant `.${agentId}-status.json`) so the dashboard shows progress
```

## Creating Agility Stories

When the user asks to create a new story, use this workflow to produce a well-formed Agility backlog item.

### Required Defaults

Read these from `.sdlc-framework.config.json` under `project`:

| Field | Config Key |
|-------|------------|
| `scope` | `config.project.scope` |
| `parent` | `config.project.parent` |
| `category` | `config.project.category` |
| `team` | `config.project.team` |
| `owners` | `config.project.owners` |

### Step 1: Create the story

```
CallMcpTool: user-Agility (Digital.ai) [formerly VersionOne] / create_story
{
  "name": "<title>",
  "scope": "<config.project.scope>",
  "parent": "<config.project.parent>",
  "category": "<config.project.category>",
  "team": "<config.project.team>",
  "owners": <config.project.owners>,
  "estimate": <points>,
  "description": "<html — see template below>",
  "acceptanceCriteria": "<html — see template below>",
  "frontend": "<html or null>",
  "backend": "<html or null>",
  "qa": "<html or null>"
}
```

### Step 2: Populate fields using update_story_field (if needed after creation)

```
CallMcpTool: user-Agility (Digital.ai) [formerly VersionOne] / update_story_field
{ "number": "B-XXXXX", "field": "frontend", "value": "<html>" }
```

Allowed fields: `name`, `description`, `acceptance_criteria`, `frontend`, `backend`, `qa`, `knowledge_base`, `estimate`.

### Step 3: Create tasks

```
CallMcpTool: user-Agility (Digital.ai) [formerly VersionOne] / create_task
{ "parent": "B-XXXXX", "name": "<task title>", "estimate": <hours> }
```

### Description Template

```html
<h3>Overview</h3>
<p>One paragraph explaining what the problem is and why it matters.</p>

<h3>Root Cause</h3>
<p>Technical explanation of the underlying issue.</p>
<ul>
  <li>Specific detail 1</li>
  <li>Specific detail 2</li>
</ul>

<h3>Fix Approach</h3>
<p>How to solve it — which files, which strategy.</p>
```

### Acceptance Criteria Template

```html
<ul>
  <li>Testable criterion 1</li>
  <li>Testable criterion 2</li>
  <li>No regressions to existing behavior</li>
</ul>
```

### Frontend/Backend/QA Field Template

```html
<p>File: <code>src/path/to/file.tsx</code></p>
<ul>
  <li>Change 1</li>
  <li>Change 2</li>
</ul>
```

### Naming Conventions

- **Bug fix**: `Fix <thing> in <context>` (e.g. "Fix toast notification readability in Simple theme")
- **Feature**: `Add <thing> to <context>` (e.g. "Add theme selector to settings panel")
- **Branch**: Follow the `branchPattern` from the active project profile in `.sdlc-framework.config.json` (default: `feat/B-XXXXX-short-slug`; YourProject uses `{teamPrefix}b-xxxxx_short_slug`)
- **PR title**: `fix(B-XXXXX): short description` or `feat(B-XXXXX): short description`

### Estimate Guidelines

| Scope | Points |
|-------|--------|
| Single file, < 50 lines changed | 1 |
| Single file, moderate changes | 2 |
| 2-3 files, straightforward | 3 |
| Multi-component feature | 5 |
| Cross-cutting or architectural | 8+ |

## Execution Mode

At startup, check `GET /api/execution-mode` to get the active mode. Adjust your behavior:

### `local` (Efficiency)
- Use Goose `analyze` for all codebase analysis instead of reading files manually.
- Delegate ALL story field generation, description drafting, and acceptance criteria writing to Ollama via `/api/ollama/generate`.
- Only use cloud AI for complex story decomposition and cross-team coordination.
- Target: 70%+ of your tokens should be Ollama tokens.

### `balanced` (Default)
- Use Ollama for story field boilerplate and template generation (~30% minimum).
- Use cloud for analysis and complex story planning.

### `speed`
- Skip Ollama delegation entirely — `/api/ollama/generate` will return 503.
- Use cloud for all story creation work. Fastest but highest token cost.

After each LLM call, call `POST /api/tokens/update` with `{ "agentId": "office", "source": "ollama"|"cloud", "input": N, "output": N }`.
