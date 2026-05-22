# Agents & SDLC Pipeline

## Agents

| Agent ID (`skills/<id>/`) | Default display name | Role          | Status      | Description |
|---------------------------|---------------------|---------------|-------------|-------------|
| `frontend`                | Lasair              | Frontend Dev  | Active      | Picks up stories from Agility, codes, creates PRs. |
| `reviewer`                | Brehon              | PR Reviewer   | Active      | Reviews PRs, leaves comments, approves/rejects. |
| `devops`                  | Cairde              | DevOps        | Active      | Monitors CI builds, manages PR completion and merge. |
| `ux`                      | Prism               | UX / Design   | Active      | Figma integration, WCAG AA audits, design handoffs. |
| `backend`                 | Cairn               | Backend Dev   | Active      | ASP.NET Core APIs, C# backend logic, domain services. |
| `qa`                      | Vigil               | QA Engineer   | Active      | Cypress test runner, failure triage, test authoring. |

Agent **IDs** (`frontend`, `reviewer`, …) are stable keys in config, status files, and APIs. **Display names** (Lasair, Brehon, …) are defaults and can be overridden in the dashboard or `scheduler.agents.<id>.displayName` in `.sdlc-framework.config.json`.

## Autonomous SDLC Pipeline

The full handoff chain runs without human intervention (unless step mode is on):

1. **Story Creation** — Create stories in Agility from the dashboard or TUI with LLM-enriched fields
2. **Assignment** — Assign a story to an agent; scheduler mode controls auto-start vs. approval
3. **Coding** — Agent reads story, creates tasks, analyzes codebase, generates code, validates
4. **PR Creation** — Agent pushes a feature branch and creates an Azure DevOps PR
5. **Review** — Reviewer agent reviews the PR, posts comments, approves or requests changes
6. **Build** — DevOps agent monitors the CI pipeline, reports pass/fail
7. **Merge** — On build pass, PR auto-completes and the story owner wraps up

The **ADO Bridge** (`src/server/ado-bridge.ts`) polls Azure DevOps for PR and build state changes, driving handoffs between agents automatically.

## Execution Modes

Story creation supports three modes, selectable from the dashboard or config:

| Mode        | Engine            | Description |
|-------------|-------------------|-------------|
| **Local**   | Goose + Ollama    | Fully local — Goose CLI orchestrates with Ollama SLM |
| **Balanced**| Ollama + REST API | Ollama enriches fields, then REST API creates the story |
| **Speed**   | IDE CLI (cloud)   | Cloud-powered enrichment via the active `scheduler.driver` CLI |

All modes track token usage per-story in a ledger visible from the dashboard.

### Codebase-Aware Enrichment

Enrichment prompts receive a **repo context snapshot** (tech stack, directory tree, key file exports, project patterns) so generated fields reference actual files and components instead of generic placeholders. Speed mode additionally instructs the Cursor CLI agent to read workspace files for richer context.

## Agent Scheduler

Agents pick up work from **Agility (Digital.ai / VersionOne)** via the dashboard:

1. Click an idle or complete agent → **Pick Up Story**
2. Select a team → browse open stories
3. Assign story → agent enters `pending-approval` or auto-starts
4. Approve via dashboard → agent begins workflow

Configuration in `.sdlc-framework.config.json` controls behavior:

- **`scheduler.mode`**: `notify` (default) — agents wait for dashboard approval after assignment unless `autoStart` is true for that agent. `autonomous` — assigned agents begin immediately.
- **`scheduler.agents.<id>.autoStart`**: Per-agent override when mode is `notify`.
- **`scheduler.agents.<id>.stepMode`**: Per-agent step mode toggle (default `false`).

## Agent Step Mode

Per-agent toggle to pause autonomous execution at key milestones for manual control:

- **Toggle** from the agent card on the dashboard (Step switch) or TUI (`s` key)
- **Pauses** at agent-specific phase boundaries. **Frontend (`frontend`)** pauses at `analyzing`, `generating-code`, `validating`, `creating-pr`, `watching-reviews`, `addressing-feedback`, and `running-cypress` by default. The first pause happens after the agent reads the story, plans the work, and creates/signs up for Agility tasks.
- **Advance** by clicking "Next" on the card, or pressing `n` in the TUI
- **Handoff suppression** — automatic spawning of downstream agents (**reviewer**, **devops**) is suppressed when step mode is active
- **Reactive** — toggling mid-run takes effect on the next driver loop iteration

Step mode phases are defined per-agent in `src/shared/agentPhases.ts` and can be overridden per-agent via `scheduler.agents.<id>.stepModePhases` in `.sdlc-framework.config.json`.

## Teams Integration

Agent activity posts to a Microsoft Teams channel via incoming webhook:
- Story assignments
- PR creation notifications
- Errors and completions

Configure the webhook URL in `.sdlc-framework.config.json` under `notifications.teams.webhookUrl`.

## Agent Knowledge Sources

Each agent has its own skill file (`skills/<agent>/SKILL.md`) that defines its identity, workflow, and tools. In addition, **all agents can read from external project codebases and the Azure DevOps wiki** when working on multi-project stories.

### How It Works

1. **Own SKILL.md** — Each agent's primary instructions, workflow phases, and tool usage
2. **YourProject Cursor Rules** — The YourProject repo has 22 `.mdc` rule files covering Angular standards, .NET standards, code review checklists, PR templates, design system rules, and more. Agents read these before implementing or reviewing YourProject code.
3. **YourProject Cursor Skills** — Nx workspace, generators, task runners, CI monitoring. Agents read these before running Nx commands.
4. **YourProject AGENTS.md** — General Nx/SCSS guidance at `{workspacePath}/src/YourProject.Web/AGENTS.md`
5. **Azure DevOps Wiki** — All agents can search and read the Fusion.wiki for environment details, server info, setup procedures, and team conventions using the Azure DevOps MCP tools (`search_wiki`, `wiki_get_page_content`, `wiki_list_pages`).
6. **ADO Code Search** — Agents can search the remote YourProject repository for code patterns using `search_code`.

### Path Resolution

Agents never use hardcoded paths. They read `projects.<name>.workspacePath` from `.sdlc-framework.config.json` to locate external project repos. This path **must be set correctly during setup** (`.\bin\setup.ps1`) — see [Configuration](configuration.md) for details.

The fallback `GET /api/project/standards?project=YourProject` auto-discovers all rules, skills, and key paths at runtime, but reading from config saves tokens.

### Per-Agent Knowledge

| Agent ID | Default label | Own Skill | YourProject Rules | Wiki | Cypress Support Layer |
|---------|---------------|-----------|-------------|------|----------------------|
| `frontend` | Lasair | `skills/frontend/SKILL.md` | Angular, TypeScript, HTML, SCSS | Yes | — |
| `reviewer` | Brehon | `skills/reviewer/SKILL.md` | Code Review, PR Template, all standards | Yes | — |
| `devops` | Cairde | `skills/devops/SKILL.md` | .NET, infrastructure | Yes | — |
| `ux` | Prism  | `skills/ux/SKILL.md` | Design System, Figma, Angular | Yes | — |
| `qa` | Vigil  | `skills/qa/SKILL.md` | All (for test validation) | Yes | Full directory map |

### Shared Rule

`.cursor/rules/YourProject-research.mdc` is the shared reference for all agents. It contains:
- Complete table of YourProject coding standards (relative paths)
- YourProject Nx skills (relative paths)
- Azure DevOps wiki search/read instructions with key page URLs
- ADO code search instructions
- Local codebase directory map

## QA agent (`qa`)

The **QA** agent (default label **Vigil**) operates in two modes depending on the active project:

| | SDLC Framework | YourProject |
|---|---|---|
| **Run tests** | Cypress MCP against `localhost:3847` | `npm run cypress:YourProject` with mochawesome |
| **Write tests** | Scaffolds `.cy.ts` specs from story AC | Not yet — runs existing 2,400+ specs |
| **Report** | `POST /api/test-results` → dashboard | Same |
| **Triage failures** | Notifies `frontend` (UI) or `backend` (API) | Same |

The QA skill has the full YourProject Cypress support layer directory map plus Azure DevOps wiki access for environment setup. See `skills/qa/SKILL.md`.

### Dashboard Integration

- **QA Results Panel** — QA agent card shows latest pass/fail counts with failure details
- **QA Tests pill** — Header stats bar shows aggregate test results (e.g. `12P / 2F`)
- **Run Tests button** — Triggers a test run from the QA agent card

## Chat (`/btw`)

Send non-blocking messages to agents while they work:

```powershell
npm run btw -- --agent frontend --message "hey, prioritize the login page"
```
