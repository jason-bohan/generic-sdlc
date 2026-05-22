# SDLC Framework Work Tracker

## In Progress

_(nothing active)_

## Backlog

- [ ] Unit tests for `agent-runner/registry.ts` (runner lifecycle, inject, stop — zero coverage)
- [ ] Unit tests for `agent-runner/tools.ts` (path safety, read/write/list)
- [ ] `_computeChatCapability` duplicated in `status-events.ts` and `status.ts` — extract to shared helper
- [ ] `AGENT_IDS` constant duplicated across `status-events.ts`, `status.ts`, others — single source
- [ ] Step mode — more SDLC coverage (design review step-mode guard, build-complete step-mode, currently needs work per user)
- [ ] SSE stream — chat route SSE test coverage at unit level (only Cypress today)

## Recently Done

- PR #57993 — `fix/step-mode-handoff-gates`: Enforce manual step-mode handoff gates
- PR #57992 — `chore/dashboard-code-split`: Vite code-split — 1,681 kB → 225 kB app chunk; vendor-three (lazy, 1,028 kB) + vendor-react (348 kB); Floor3D lazy-loaded via React.lazy
- PR #57989 — `fix/task-dedup-empty-category`: Task dedup with empty category and name-based inherited task matching
- PR #57986 — `fix/agent-runner-unavailable-abort`: Abort agent loop after 3 consecutive unavailable turns, responsive Ctrl-C
- PR #57984 — `fix/agents-use-restmethod`: Add Invoke-RestMethod guidance to SKILL.md files
- PR #57983 — `fix/sdlc-handoffs-test-regressions`: Fix 11 test regressions from SDLC handoffs merge
- PR #57982 — `chore/tasks-md-update`: TASKS.md cleanup (stale In Progress, new backlog items)
- PR #57981 — `fix/step-mode-keepopen-action-bar`: Show "Start Work" when driver kept-open after step-mode handoff (`stepPauseReady` gate, `handoffDispatched` field)
- PR #57967 — `feat/step-mode-task-batch`: Step-mode task batch workflow
- PR #57964 — `chore/cleanup-gitignore`: gitignore stale artifacts, `status-events.ts` unit tests, TASKS.md
- `chore/cleanup-gitignore` — gitignore: `*.log.err`, `*.backup`, `cypress/screenshots/`, `.reviewer-comments.json`, `tools/openrouter-proxy/`, `debug_json.txt`
- SSE real-time status + chat streams (replaced polling)
- In-process AgentRunner with durable `agent_sessions`
- Server `app.ts` monolith split into `src/server/routes/`
- Dashboard component extraction (`src/dashboard/components/`, `src/dashboard/floor3d/`)
- Goose MCP server (`tools/mcp-sdlc-framework/`)
- Voice input (`useVoiceInput.ts`)
