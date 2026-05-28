# MCP: SDLC Framework SDLC Orchestration

The `mcp-sdlc-framework` server exposes the SDLC Framework API as a Model Context Protocol (MCP) tool set, letting any MCP-capable AI assistant — Goose, Claude Code, Cursor, or others — directly orchestrate the SDLC pipeline without opening the dashboard.

Located at `tools/mcp-sdlc-framework/index.js`.

---

## Setup

### Goose

The legacy Windows setup script (`bin/setup.ps1`) configures this automatically. On macOS/Linux, run `npm run setup` for the project files, then add this manually to your Goose `config.yaml` extensions block if Goose does not already have it:

```yaml
sdlc-framework:
  enabled: true
  type: stdio
  name: SDLC Framework
  description: SDLC Framework SDLC orchestration — assign stories, monitor agents, manage workflows, search backlog
  cmd: /path/to/node
  args:
    - /path/to/sdlc-framework/tools/mcp-sdlc-framework/index.js
  envs:
    SDLC_FRAMEWORK_BASE_URL: http://localhost:3001
  env_keys: []
  timeout: 30
```

> **Note:** Use the full path to Node — Goose may not inherit your shell's PATH. Find it with `which node` on macOS/Linux or `(Get-Command node).Source` in PowerShell.

### Cursor / Claude Code

Add to `.cursor/mcp.json` or your Claude Code MCP config:

```json
{
  "mcpServers": {
    "sdlc-framework": {
      "command": "node",
      "args": ["/path/to/sdlc-framework/tools/mcp-sdlc-framework/index.js"],
      "env": {
        "SDLC_FRAMEWORK_BASE_URL": "http://localhost:3001"
      }
    }
  }
}
```

### Install dependencies

Dependencies are installed automatically by `npm install` (via `postinstall`) and by `npm run setup`. To install manually:

```bash
cd tools/mcp-sdlc-framework
npm install --production
```

The SDLC Framework API must be running (`npm run server` or `npm run dev`) for any tool calls to succeed.

---

## Tools

### `get_agent_status`

Get current status of one or all agents. Returns phase, story number, running state, recent events, and task list.

```
get_agent_status()                        # all 6 agents
get_agent_status({ agentId: "frontend" }) # one agent
```

### `list_workflows`

List all active workflows tracked in the SDLC Framework SQLite DB. Returns story number, assigned agent, current phase, and workflow ID.

### `get_workflow`

Full detail for a single workflow: phase history, all artifacts (code, PR, test results, design spec).

```
get_workflow({ workflowItemId: 42 })
```

### `assign_story`

Assign a story to an agent to kick off the SDLC workflow.

```
assign_story({
  agentId: "frontend",
  storyNumber: "B-12345",
  storyName: "Add export button to reports page"
})
```

### `approve_story`

Approve a story that's in `pending-approval` phase. Spawns the agent to begin work.

```
approve_story({ agentId: "frontend" })
```

### `continue_agent`

Resume an agent paused in step mode, or re-spawn it to continue the current phase.

```
continue_agent({ agentId: "backend" })
continue_agent({ agentId: "frontend", phaseHint: "creating-pr" })
```

### `run_workflow_phase`

Build the phase runner prompt and optionally spawn the agent. Useful when an agent hasn't auto-started.

```
run_workflow_phase({ storyNumber: "B-12345", agentId: "backend" })
run_workflow_phase({ storyNumber: "B-12345", spawn: false }) # prompt only
```

### `dismiss_item`

Remove a completed task or change-request from an agent's desk.

```
dismiss_item({ agentId: "frontend", itemId: "TK-00456" })
dismiss_item({ agentId: "reviewer", itemId: "CR-001", itemType: "request" })
```

### `search_stories`

Search stories available for assignment. Returns open, unreleased stories.

```
search_stories({ team: "Istari", status: "Future" })
search_stories({ text: "export", maxResults: 10 })
```

### `get_story`

Full story detail: description, acceptance criteria, frontend/backend/QA fields, and a link to the story UI.

```
get_story({ number: "B-12345" })
```

### `get_execution_mode` / `set_execution_mode`

Read or change the active execution mode.

```
get_execution_mode()
set_execution_mode({ mode: "local" })   # local | balanced | speed
```

### `get_reviewer_prs`

List pull requests eligible for the reviewer agent to pick up.

### `reset_agents`

Reset all agents to idle. Requires explicit confirmation. Use to recover from a stuck state.

```
reset_agents({ confirm: true })
```

---

## What You Can Do With It

### Morning standup replacement
```
"What are all agents working on right now?"
```
→ `get_agent_status()` gives a full pipeline snapshot in one call.

### Hands-free story kickoff
```
"Find a Future story for the Istari team about the export feature and assign it to frontend"
```
→ `search_stories` → `get_story` → `assign_story` → `approve_story`

### Step-mode review loop
```
"Show me what frontend produced in the analyzing phase, then push it toward creating a PR"
```
→ `get_workflow` → `continue_agent({ phaseHint: "creating-pr" })`

### Pipeline health check
```
"Are there any agents stuck? Show me workflows that haven't moved recently"
```
→ `list_workflows` + `get_agent_status`

### Post-review cleanup
```
"Dismiss all completed tasks from the backend agent's desk"
```
→ `get_agent_status` → `dismiss_item` for each completed task

### Switch to fully local before a long run
```
"Switch to local mode and assign B-99999 to backend"
```
→ `set_execution_mode({ mode: "local" })` → `assign_story`

---

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `SDLC_FRAMEWORK_BASE_URL` | `http://localhost:3001` | SDLC Framework API base URL |

No authentication token required — connects directly to the local SDLC Framework API.
