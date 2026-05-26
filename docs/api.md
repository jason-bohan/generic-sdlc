# API Reference

The SDLC Framework API server runs on port 3001 (`npm run server`). The Vite dashboard proxies all `/api/*` requests there automatically.

The API is integration-agnostic: route handlers work with generic SDLC concepts such as work items, tasks, review requests, builds, notifications, and model calls. Callers should treat `/api/planning/*` payloads as generic planning operations that can be backed by GitHub, Jira, Digital.ai Agility, local mock state, or another adapter.

Use the **Bruno collection** at `bruno/sdlc-framework/` to explore endpoints interactively — open it in Bruno with the `local` environment selected.

## Base URL

```
http://localhost:3001
```

---

## Health

### `GET /health`

Returns a small JSON payload describing service health for liveness/readiness probes and monitoring.

Example response (healthy):

```json
{ "status": "ok", "uptimeSeconds": 123, "services": { "db": { "ok": true }, "ollama": { "online": false } } }
```

If critical dependencies (database) are unhealthy the endpoint returns a non-200 status (500) suitable for Kubernetes liveness/readiness checks.

Notes:
- Use `/health` for Kubernetes probes (readiness/liveness). Keep probes light and fast.
- The endpoint reports dependency checks (DB, Ollama) and overall status. Ollama is informational — DB failures are treated as unhealthy.
- Add monitoring/metrics (Prometheus) by scraping a metrics endpoint or via exporter; `/health` is intended for probes and simple monitoring integrations.

Migration notes:
- If deploying to Kubernetes, point liveness/readiness to `http://<pod>:3001/health` and expect a 200 when healthy.

---

## Status

### `GET /api/status`

Returns the current status for an agent.

| Param | Type | Default |
|-------|------|---------|
| `agentId` | query string | `frontend` |

---

## Planning / Work Items

These endpoints read and write work-item data through the configured planning adapter. Their response shapes should stay generic enough to map to different planning systems.

Legacy payload keys such as `storyNumber`, `storyName`, and `storyDescription` currently represent the generic work-item key, title, and description. New adapters should translate those names at the boundary instead of leaking a tool-specific model through the rest of the system.

### `GET /api/planning/teams`
Returns active teams from the configured planning adapter.

### `GET /api/planning/class-of-service`
Returns available class-of-service or priority values from the configured planning adapter.

### `GET /api/planning/stories`
Returns work items for a team, optionally filtered by status.

```json
{ "teamId": "Team:1234", "statusFilter": ["In Progress", "Backlog"] }
```

### `POST /api/planning/create-story`
Creates a work item through the planning adapter with optional LLM-enriched fields.

```json
{
  "name": "As a user, I want to reset my password",
  "description": "Add a forgot password flow",
  "estimate": 3,
  "team": "Team:1234",
  "owner": "Member:5678",
  "classOfService": "Standard",
  "workspaceDir": "C:/repos/YourProject"
}
```

### `POST /api/planning/story-status`
Updates a work item's status, such as `Released` or `Done`.

```json
{ "number": "B-12345", "status": "Released" }
```

---

## Scheduler

### `POST /api/scheduler/assign`
Assigns a work item to an agent. Writes the agent status file and optionally auto-starts.

```json
{
  "agentId": "frontend",
  "storyNumber": "B-12345",
  "storyName": "Add password reset flow",
  "storyDescription": "<p>...</p>",
  "teamId": "Team:1234"
}
```

### `POST /api/scheduler/approve`
Approves a pending-approval agent to begin its workflow.

```json
{ "agentId": "frontend" }
```

### `POST /api/scheduler/step-advance`
Advances an agent paused in step mode to its next phase.

```json
{ "agentId": "frontend" }
```

### `POST /api/scheduler/create-task`
Creates a task through the planning adapter and appends it to the agent's status file.

```json
{ "agentId": "frontend", "storyNumber": "B-12345", "name": "Implement component", "estimate": 2 }
```

### `POST /api/scheduler/update-task`
Updates a task's status.

```json
{ "agentId": "frontend", "taskId": "Task:9999", "status": "completed" }
```

---

## Tokens

### `GET /api/tokens/ledger`
Returns the full token ledger for all work items. Add `?story=B-12345` to filter by the current legacy story/work-item key.

### `POST /api/tokens/update`
Records token usage for an agent and phase.

```json
{ "agentId": "frontend", "source": "cloud", "input": 1500, "output": 400, "phase": "development" }
```

### `POST /api/tokens/cloud`
Shorthand for cloud token update.

```json
{ "agentId": "frontend", "input": 800, "output": 200 }
```

---

## Handoff

### `POST /api/handoff/review-complete`
Signals that Brehon has finished reviewing a review request.

```json
{ "prId": 42, "verdict": "approved", "storyNumber": "B-12345", "branch": "feat/B-12345" }
```

### `POST /api/handoff/build-complete`
Signals that a CI build finished, either from the DevOps agent or a configured build-adapter webhook.

```json
{ "prId": 42, "result": "passed", "buildId": 1001 }
```

### `POST /api/handoff/design-ready`
Signals that Prism's design spec is ready for implementation.

```json
{ "storyNumber": "B-12345", "storyName": "...", "designSpec": "## ...", "targetAgent": "frontend" }
```

---

## Ollama

### `GET /api/ollama/health`
Returns Ollama online status, active model, digest, last pulled, and RAG readiness.

### `POST /api/ollama/reindex`
Triggers a RAG index rebuild for a workspace.

```json
{ "workspaceDir": "C:/repos/YourProject" }
```

### `POST /api/ollama/generate`
Runs a prompt through the local Ollama model.

```json
{ "agentId": "frontend", "model": "qwen3:8b", "prompt": "...", "system": "..." }
```

## MeshLLM

### `GET /api/meshllm/health`
Returns whether the configured MeshLLM host is reachable, the host URL, and visible model IDs.

### `GET /api/meshllm/models`
Lists models reported by the MeshLLM OpenAI-compatible `/v1/models` endpoint.

### `POST /api/meshllm/generate`
Runs a prompt through MeshLLM's OpenAI-compatible chat completions endpoint. If MeshLLM is unavailable, the server falls back to Ollama and reports `provider: "ollama"` in the response.

```json
{ "agentId": "devops", "model": "Qwen3-8B", "prompt": "...", "system": "...", "maxTokens": 2048, "temperature": 0.2 }
```

MeshLLM usage is recorded in the `meshllm` token bucket. Fallback usage is recorded in the `ollama` bucket.

---

## Chat

### `GET /api/chat/messages?agentId=frontend`
Returns all chat messages for an agent.

### `POST /api/chat/messages?agentId=frontend`
Posts a user message to an agent's chat.

```json
{ "message": "hey, prioritize the login page fix" }
```

### `POST /api/chat`
Posts a full chat message with trigger matching (used by agent CLI scripts).

```json
{ "agentId": "frontend", "message": { "id": "...", "from": "user", "message": "pause after next step" } }
```

---

## Config

### `GET /api/config`
Returns the current `.sdlc-framework.config.json`.

### `GET /api/projects`
Returns available project profiles.

### `POST /api/notify`
Sends a notification through the configured notification adapter.

```json
{ "title": "Test", "message": "Hello from Bruno", "color": "6366f1" }
```

### `POST /api/ado/vote-pr`
Casts a vote on a review request through the configured review adapter compatibility route.
