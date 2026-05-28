---
name: sdlc
description: >-
  SDLC Framework SDLC operating model. Reference this when designing or executing
  story workflows, phase contracts, orchestration, mock-mode testing, and
  role-specific agent handoffs.
---

# SDLC Framework SDLC Operating Model

This skill codifies the SDLC value stream from `SDLC Value Stream Map - 2025-06-20.pdf` into the SDLC Framework agent system.

The value stream is story-centered, not agent-centered. Agents exist to move a story through the workflow with explicit evidence, gates, handoffs, and feedback loops.

## Value Stream Summary

The mapped SDLC flow contains these recurring activities:

1. Story intake from the backlog or outside-backlog interrupt.
2. Pre-planning and story investigation.
3. Planning meeting when needed with PO, dev, QA, UX, and knowledge-base stakeholders.
4. Task creation/refinement.
5. Feature branch creation.
6. Code implementation.
7. Unit tests, Sonar/static analysis, and local validation.
8. Push/deploy to dev site for API/frontend verification.
9. Manual testing and automation testing when useful.
10. PR creation and PR review.
11. Feedback loops for comments, broken tests, missed tasks, design feedback, and merge conflicts.
12. Merge master into the branch before final PR/merge.
13. PR to master, CI build, deploy to CI, final validation, and merge into master.
14. Wrap-up, documentation, and post-deployment checks where applicable.

The map explicitly calls out waste to reduce:

- Wait time after PR creation.
- Wait time for review.
- Build and deploy time.
- Rework from unclear requirements or design changes after planning.
- Overbroad automation and duplicate QA cases.
- Missed tasking that appears after implementation has started.
- Context switching when someone is pulled onto another story.

## SDLC Framework Design Principles

### 1. Typed Phase Contracts

Every phase has required input, required output, gates, and allowed next phases.

Agents must not transition phases based only on prose like "done" or "looks good." A phase is complete only when its output contract exists and is recorded in workflow state.

Examples:

- `reading-story` must output story details, affected repo, planned tasks, task IDs, branch plan, test plan, open questions, and risks.
- `validating` must output command results, test results, static-analysis notes, and unresolved risk.
- `creating-pr` must output either real PR metadata or mock PR metadata.
- `monitoring-build` must output build ID, build status, and failure details when applicable.

### 2. Central Workflow State

Status JSON files are compatibility views for agents and dashboards, not the long-term source of truth.

The durable source of truth should be SQLite under `.sdlc-framework/sdlc-framework.db`, with append-only workflow events for:

- story assignment
- current phase
- phase inputs and outputs
- tasks
- branches
- PRs
- reviews
- builds
- test runs
- retries
- mock/live mode decisions
- audit trail

### 3. Mock Mode Is a Capability Boundary

Mock mode must be enforced below prompts.

When `externalMode` or `integrations.mode` is `mock`:

- Code review provider MCP tools are prohibited.
- `git push` is prohibited.
- Live PR URLs are rejected.
- CI/build/review progress is simulated through SDLC Framework mock state.
- Planning board calls must target the local mock API at `$api/mock-v1` with `AGILITY_API_KEY=mock-token`.

### 4. Role-Specific Workflow Graphs

Agents do not share one universal phase order.

- Frontend/backend implement stories and create PRs.
- Reviewer reviews PRs and emits approved or changes-requested verdicts.
- DevOps monitors builds, handles merge gates, and records build results.
- QA defines/refines the test matrix, runs manual/automation validation, and reports issues.
- UX researches/designs, creates specs, reviews design changes, and hands off implementation work.
- The orchestrator decides when to assign multiple agents for full-stack or design-first stories.

### 5. Supervisor-Orchestrated Handoffs

The orchestrator owns workflow routing:

- classify story as frontend, backend, full-stack, QA-heavy, design-first, devops, defect, or support issue
- assign one or more agents
- choose the role-specific workflow graph
- enforce phase contracts before transitions
- route PR approved -> DevOps
- route changes requested -> story owner addressing feedback
- route build failed -> owner validation/fix loop
- route missing tasks -> planning/task refinement

Agents own phase execution. The orchestrator owns phase movement.

### 6. Worktree Isolation

Every agent that writes or reads code from a target repository must work inside a git worktree — never the main working tree.

The main working tree belongs to the developer's active IDE session. Agent changes there cause conflicts, unexpected staged files, and editor-state corruption.

#### Single-agent story

Create one worktree branching off the configured `targetBranch` (usually `main`):

```bash
# First time — create branch and worktree together
git -C <workspacePath> worktree add -b <branch> .claude/worktrees/<agentId>-<storyNumber> main

# Resuming — attach to the existing branch
git -C <workspacePath> worktree add .claude/worktrees/<agentId>-<storyNumber> <branch>
```

**After creating the worktree**, copy the root `.env` into it — git never tracks `.env` so it won't be present automatically, and the server reads it at startup from the worktree root:

```bash
cp <workspacePath>/.env .claude/worktrees/<agentId>-<storyNumber>/.env
```

The path `.claude/worktrees/<agentId>-<storyNumber>` is deterministic across all phases of a story run — re-attach with the second command if the worktree was removed.

#### Full-stack collaboration (frontend + backend)

Each agent branches independently off `main` and creates a separate PR. They never share a branch or wait for the other's branch to merge first.

```
main
 ├─ feat/<storyNumber>-frontend  ← frontend agent's worktree
 └─ feat/<storyNumber>-backend   ← backend agent's worktree
```

```bash
# frontend agent
git -C <workspacePath> worktree add -b feat/<storyNumber>-frontend \
    .claude/worktrees/frontend-<storyNumber> main

# backend agent (runs concurrently in its own worktree)
git -C <workspacePath> worktree add -b feat/<storyNumber>-backend \
    .claude/worktrees/backend-<storyNumber> main
```

**Keeping branches current with `main`:**

Before creating a PR and before each validation phase, sync with `main` to incorporate any merged work (including the other agent's changes if they merged first):

```bash
cd .claude/worktrees/<agentId>-<storyNumber>
git fetch origin
git rebase origin/main    # or: git merge origin/main
# resolve any conflicts here, then continue
```

Each agent is responsible for resolving conflicts in their own worktree. If the other agent's PR lands on `main` while yours is in review, rebase again before the reviewer picks up your PR.

**Rules:**
- Run all git commands (`commit`, `push`, `fetch`, `rebase`, `status`) from inside the worktree directory.
- Never run `git checkout` in the main working tree — it disrupts the IDE.
- Never merge the other agent's feature branch into yours — both PRs target `main` independently.
- One worktree per story branch. Reuse it across phases.
- Remove when done: `git worktree remove .claude/worktrees/<agentId>-<storyNumber>`

**What worktrees prevent:**

| Without worktrees | With worktrees |
|---|---|
| Agent checkout disrupts IDE session | IDE working tree is untouched |
| Concurrent agents conflict on same working tree | Each agent has an isolated directory |
| Agent stages the developer's uncommitted changes | Only the agent's files can be staged |
| `git status` shows developer WIP | Each worktree is clean and independent |

### 7. First-Class SDLC Tests

Every SDLC workflow must have mock-mode E2E tests that prove the workflow without touching live systems.

Required scenarios:

- single-agent story: assign -> tasks -> branch -> mock PR -> review -> build -> complete
- changes-requested loop: mock PR -> reviewer rejects -> owner fixes -> review again
- build-failed loop: approved PR -> mock failed build -> owner fixes -> build again
- full-stack story: backend and frontend split work, create separate PRs, converge at review/build gates
- design-first story: UX spec -> frontend/backend implementation -> design/code review gates
- mock escape prevention: live Azure URL, Azure tool use, and `git push` are rejected

## Windows Shell: API Calls

All SDLC Framework API calls run on Windows PowerShell. **Always use `Invoke-RestMethod`** — never `Invoke-WebRequest`. `Invoke-RestMethod` parses JSON automatically and never triggers the interactive security prompt that blocks agent runs.

```powershell
# Resolve port — worktrees run on a different port than the main repo. Always do this first.
$apiPort = if (Test-Path '.sdlc-framework/.dev-port') { (Get-Content '.sdlc-framework/.dev-port').Trim() } else { '3001' }
$api = "http://localhost:$apiPort"

# CORRECT
$body = @{ agentId = "frontend"; phase = "analyzing" } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$api/api/workflows/complete-phase" -Method POST -Body $body -ContentType "application/json"

# WRONG — blocks on interactive security prompt
Invoke-WebRequest -Uri "$api/api/..." ...
```

## Phase Contract Checklist

Before a phase transition, verify:

- The phase input contract existed when the phase started.
- The phase output contract is written.
- Required external/mock calls were made through the correct mode.
- Any new task, PR, build, or test IDs are recorded.
- Risks and open questions are explicit.
- The next phase is allowed by that agent's workflow graph.

If any of these fail, the phase remains active or transitions to `error`.

## How Agents Should Use This Skill

At startup:

1. Read `.sdlc-framework.config.json`.
2. Read this skill.
3. Read your role skill, for example `skills/frontend/SKILL.md`.
4. Load your current workflow state.
5. Execute only the current phase.
6. Produce the phase output contract before requesting or taking the next transition.

When this skill conflicts with a role skill, prefer this SDLC skill for cross-agent workflow rules and prefer the role skill for role-specific implementation details.
