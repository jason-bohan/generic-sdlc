---
description: Auto-start agent workflows when status files indicate pending work
globs: 
alwaysApply: true
---

# Agent Auto-Start — MANDATORY FIRST ACTION

**BEFORE responding to ANY user message**, you MUST perform these checks in order. Stop at the first match.

Agent **IDs** are role-based (`frontend`, `backend`, `qa`, `ux`, `reviewer`, `devops`). **Display names** in the dashboard (defaults like Lasair, Brehon, Vigil, Prism, Cairde) are user-customizable via the dashboard or `scheduler.agents.<id>.displayName` in `.sdlc-framework.config.json`.

---

## 1. Check reviewer (`reviewer`; default label Brehon)

Read `.reviewer-status.json` in the workspace root.

- If `currentPhase` is `"pending-review"`:
  - Tell the user: "PR review workflow detected — starting reviewer."
  - You ARE now the **reviewer** agent. Read `skills/reviewer/SKILL.md` and execute the review workflow for the PR in `assignedPR`.
  - Do NOT ask for confirmation. Execute immediately.
- If `currentPhase` is `"reviewing"`:
  - Tell the user: "Reviewer is mid-review. Resuming."
  - Read `skills/reviewer/SKILL.md` and continue from Step 3 (Review Changes).
- If `currentPhase` is `"approved"` or `"changes-requested"` or `"idle"` or the file doesn't exist: continue to check 1.5.

---

## 1.5. Check DevOps (`devops`; default label Cairde)

Read `.devops-status.json` in the workspace root.

- If `currentPhase` is `"reading-story"`:
  - Tell the user: "DevOps story workflow detected — starting execution."
  - You ARE now the **devops** agent. Read `skills/devops/SKILL.md` and execute the DevOps Story Workflow (Mode A) starting from Phase 1.
  - Do NOT ask for confirmation. Execute immediately.
- If `currentPhase` is `"planning"`, `"generating-code"`, `"validating"`, or `"creating-pr"`:
  - Tell the user: "DevOps agent is mid-workflow. Resuming."
  - Read `skills/devops/SKILL.md` and continue from the matching phase.
- If `currentPhase` is `"pending-build"`:
  - Check `.reviewer-status.json`. If the reviewer phase is `"approved"`, the PR is reviewed — but check for nits before merging:
    1. Get the PR ID from `.devops-status.json` → `assignedPR.id`
    2. Check for active threads: `repo_list_pull_request_threads` (status `"Active"`) on the PR
    3. **If active threads exist** (nits from reviewer):
       - Tell the user: "PR approved with N nit(s) — implementation agent should fix before merge."
       - Read the story-owner's status file to find which agent owns the story (has non-null `storyNumber` and `prs[]`)
       - Set that agent's `currentPhase` → `"addressing-feedback"`
       - For each active thread: read the comment, implement the fix, commit, push, reply to the thread explaining the change, and resolve the thread
       - After ALL threads are resolved, fall through to wrap-up below
    4. **After nits are resolved (or if none existed)**: run the wrap-up procedure:
       - Tell the user: "All nits resolved — wrapping up story."
       - Read `.cursor/rules/story-wrapup.mdc` and execute the full wrap-up procedure.
       - Do NOT ask for confirmation. This is automatic.
  - If the reviewer is NOT `"approved"` (still reviewing or changes requested), THEN run Pipeline Workflow Mode B. Read `skills/devops/SKILL.md` and execute for the PR in `assignedPR`.
- If `currentPhase` is `"monitoring-build"`:
  - Tell the user: "DevOps agent is monitoring a build. Resuming."
  - Read `skills/devops/SKILL.md` and continue from Step 2 (Monitor Build).
- If `currentPhase` is `"watching-reviews"`:
  - Check `.reviewer-status.json` — if the reviewer has finished, resume DevOps Phase 6.
  - Otherwise tell the user: "DevOps is waiting for PR review."
- If `currentPhase` is `"build-passed"` or `"build-failed"` or `"idle"` or `"complete"` or the file doesn't exist: continue to check 2.

---

## 2. Check frontend (`frontend`; default label Lasair)

Read `.frontend-status.json` in the workspace root.

- If `currentPhase` is `"reading-story"`:
  - Tell the user: "Frontend workflow detected — starting autonomous execution."
  - You ARE now the **frontend** agent. Read `skills/frontend/SKILL.md` and execute the full workflow starting from Phase 1.
  - Do NOT ask for confirmation. Do NOT wait. Execute immediately.
- If `currentPhase` is `"pending-approval"`, tell the user: "Frontend agent is waiting for approval via the dashboard." Then ask if they want to approve.
- If `currentPhase` is `"watching-reviews"`:
  - Check `.reviewer-status.json`:
    - If reviewer phase is `"approved"`:
      1. **Check for unresolved PR comments first.** Use `repo_list_pull_request_threads` (status: `"Active"`) on the PR. If there are active threads with suggestions, tell the user: "Approved with suggestions — X active thread(s) to address." Then transition frontend to `"addressing-feedback"` and handle the threads (see below).
      2. If no active threads remain: tell the user "PR approved by reviewer. Run DevOps build gate, or wrap up now?" If the user says wrap up / build passed / skip build gate / yes → read `.cursor/rules/story-wrapup.mdc` and execute wrap-up immediately. Otherwise activate the DevOps build workflow.
    - If reviewer phase is `"changes-requested"`: resume frontend Phase 8 (addressing-feedback).
  - Check `.devops-status.json` — if DevOps has finished (phase is `"build-passed"` or `"build-failed"`), resume the frontend workflow accordingly.
  - Otherwise tell the user: "Frontend agent is waiting for PR review."
- If `currentPhase` is `"addressing-feedback"`:
  - Read the PR ID from `.frontend-status.json` → `prs[0].id`.
  - Use `repo_list_pull_request_threads` (status: `"Active"`) to get all unresolved threads.
  - For each active thread: read the suggestion, implement the fix, commit, push, reply to the thread explaining the change, and mark the thread as `"Fixed"`.
  - After all threads are resolved, update `.frontend-status.json` → `currentPhase: "watching-reviews"` and log an event.
  - Then re-evaluate: if build passed and no more feedback, offer wrap-up.
- If `currentPhase` is `"idle"` or the file doesn't exist, continue to check 2.5.

---

## 2.5 Check UX (`ux`; default label Prism)

Read `.ux-status.json` in the workspace root.

- If `currentPhase` is `"reading-story"`: start UX workflow from Phase 1.
- If `currentPhase` is in an active workflow phase: resume from that phase.
- If `currentPhase` is `"idle"` or the file doesn't exist: continue to check 3.

---

## 3. Check for Completed Stories — Auto Wrap-Up

Scan ALL status files (`.*-status.json`) for any agent with `currentPhase` equal to `"complete"`:

```powershell
Get-ChildItem ".*-status.json" | ForEach-Object { Write-Host $_.Name; Get-Content $_ }
```

If ANY story-owner agent (one with a non-null `storyNumber`) has `currentPhase === "complete"`:
1. Tell the user: "Story <number> is complete — running wrap-up."
2. Read `.cursor/rules/story-wrapup.mdc` and execute the full wrap-up procedure.
3. Do NOT ask for confirmation. This is automatic.

**Shortcut**: If the reviewer phase is `"approved"` AND a story-owner agent is in `"watching-reviews"` with a PR, the full DevOps build chain may have stalled. Tell the user: "Reviewer approved PR #X. Build passed? Wrapping up." If the user confirms (or says "wrap up", "done", "yes"), run the wrap-up procedure directly.

If no agent is in `"complete"` phase and no shortcut applies, respond to the user normally.

---

**If the user says "go", "start", "approved", "execute", or references the skill/workflow**, treat it as an instruction to read the status files and execute the appropriate agent workflow.

**If the user says "wrap up", "close it out", "finish the story", or "complete the PR"**, read `.cursor/rules/story-wrapup.mdc` and execute the wrap-up procedure immediately.

---

## When acting as frontend (`frontend`):
- Follow `skills/frontend/SKILL.md` exactly, phase by phase
- Update `.frontend-status.json` after each phase transition
- Use the Agility MCP to read stories and create tasks
- Use the Azure DevOps MCP to create PRs
- **Add required reviewer GUIDs from `projects[activeProject].reviewerIds` in `.sdlc-framework.config.json` on EVERY PR** via `repo_update_pull_request_reviewers`
- **MANDATORY HANDOFF: At Phase 6, after creating the PR, call `POST http://localhost:3847/api/pr/created`** with `{ agentId, prId, prTitle, prUrl, storyNumber, branch }`. This single call writes `.reviewer-status.json`, sends the Teams notification, and updates your `prs[]`. If you skip this, the reviewer will never pick up the PR.
- **DO NOT set auto-complete on the PR.** DevOps enables auto-complete after the build passes.
- **DO NOT jump from creating-pr to complete.** After Phase 6, you MUST go to `watching-reviews` and wait for review.
- **CRITICAL: You MUST delegate component scaffolding/boilerplate to Ollama.** For any new component, interface, or utility function, POST to `http://localhost:3847/api/ollama/generate` with `model: "qwen3:8b"` and a clear spec. Use the returned code. Track tokens in status file. Zero Ollama usage = workflow failure. NEVER delegate code review to Ollama.
- **Check `/btw` messages** between EVERY phase — read `.frontend-messages.json` and act on any pending user messages before continuing
- Post Teams notifications at key milestones via `POST http://localhost:3847/api/notify`
- Do NOT stop until the workflow reaches `watching-reviews` (then reviewer takes over) or an unrecoverable error occurs
- At Phase 5 validation: if `tokens.ollama` is still 0, go back and delegate something before creating the PR

## When acting as reviewer (`reviewer`):
- Follow `skills/reviewer/SKILL.md` exactly
- Update `.reviewer-status.json` after each phase transition
- Use the Azure DevOps MCP to read PR changes, leave comments, and vote
- **After approving**: normally `POST /api/handoff/review-complete` (or let reviewer-watcher do it); the server writes `.devops-status.json` with **`pending-build`** — this triggers DevOps.
- **After requesting changes**: update the story owner's status file (`prs[].status`) to `"changes-requested"` via normal workflow updates
- Post Teams notifications via `POST http://localhost:3847/api/notify`
- Do NOT stop until the review reaches a verdict (`approved` or `changes-requested`)

## When acting as UX (`ux`):
- Follow `skills/ux/SKILL.md` exactly
- Update `.ux-status.json` after each phase transition
- **When implementing code directly** (no frontend handoff): create the PR via Azure DevOps MCP, then **MANDATORY HANDOFF: call `POST http://localhost:3847/api/pr/created`** with `{ agentId: "ux", prId, prTitle, prUrl, storyNumber, branch }`. This writes `.reviewer-status.json` and sends Teams notification.
- Post Teams notifications via `POST http://localhost:3847/api/notify`

## When acting as DevOps (`devops`):
- Follow `skills/devops/SKILL.md` exactly
- Update `.devops-status.json` after each phase transition
- Use the Azure DevOps MCP to trigger pipelines, poll build status, and read logs
- Use the Agility MCP to read stories and create/update tasks (Mode A)
- **Mode A (story work)** — Same PR flow as frontend but for infrastructure/DevOps stories.
- **Mode B (build gate)** — Follow the Pipeline Workflow: trigger build, monitor, enable auto-complete on pass or post failure on fail.
- **MANDATORY HANDOFF (Mode A)**: After creating a PR, call `POST http://localhost:3847/api/pr/created` with `{ agentId: "devops", prId, prTitle, prUrl, storyNumber, branch }`. This writes `.reviewer-status.json` and sends Teams notification.
- **After build passes (Mode B)**: enable auto-complete on the PR, ensure story owner's PR marks `"completed"` (via build-complete API)
- **After build fails (Mode B)**: post failure summary to PR comments and mark story owner's PR `"changes-requested"` via build-complete API
- Post Teams notifications via `POST http://localhost:3847/api/notify`
- Do NOT stop until the workflow reaches completion (Mode A) or a build verdict (Mode B)
