# Project Structure

```
sdlc-framework/
├── bin/                        # PowerShell scripts
│   ├── setup.ps1               # First-run setup (deps, .env, PATH)
│   ├── update.ps1              # Update checker (Node, Goose, Ollama, Rust)
│   └── run-agent.ps1           # Autonomous agent driver
│
├── src/
│   ├── dashboard/              # React UI
│   │   ├── SimpleFloor.tsx     # 2D card-based dashboard
│   │   ├── Floor3D.tsx         # 3D office view (React Three Fiber)
│   │   ├── AgentDetail.tsx     # Agent desk detail panel
│   │   ├── OrgChart.tsx        # Org chart with Ollama health badges
│   │   └── themes.ts           # Theme definitions (Far Out, Lumon, etc.)
│   │
│   ├── server/                 # API server
│   │   ├── index.ts            # Entry point (http.createServer, chalk logging)
│   │   ├── app.ts              # All 33 API routes (createApp factory)
│   │   ├── db.ts               # SQLite module (token_ledger, ollama_state, chat_messages)
│   │   ├── modes.ts            # Execution modes + story creation logic
│   │   ├── repo-context.ts     # Codebase-aware enrichment context builder
│   │   ├── ollamaManager.ts    # Boot sequence, digest tracking, update detection
│   │   ├── ragIndex.ts         # Semantic codebase indexer (nomic-embed-text)
│   │   ├── ado-bridge.ts       # Azure DevOps polling + handoff automation
│   │   ├── handoff.ts          # Agent-to-agent handoff logic
│   │   ├── stepMode.ts         # Step mode phase utilities
│   │   ├── schedulerMode.ts    # Scheduler workflow mode helpers
│   │   ├── tokens.ts           # Token tracking (accumulator)
│   │   ├── ledger.ts           # Per-story token ledger (SQLite-backed)
│   │   ├── spawn-agent.ts      # Agent process spawner
│   │   ├── project-config.ts   # Multi-project config reader
│   │   ├── external-mode.ts    # Live vs mock mode detection
│   │   └── mock-external.ts    # Mock Agility/ADO/Teams + mock-v1 API
│   │
│   ├── shared/
│   │   └── agentPhases.ts      # Per-agent step mode phase definitions
│   │
│   ├── messages/
│   │   └── triggers.ts         # Chat trigger matching
│   │
│   ├── tui/                    # Terminal UI (Ink/React)
│   └── test/                   # Vitest test suite (193 tests)
│
├── src-tauri/                  # Tauri Rust backend (tray, file watcher)
│
├── scripts/                    # Node.js tooling
│   ├── btw.ts                  # /btw chat sender
│   ├── ollama-delegate.ts      # Ollama delegation script
│   ├── pr-watcher.ts           # PR watch script
│   └── plan-generator.ts       # Plan generator
│
├── skills/                     # Agent workflow skill files (`skills/<agentId>/`)
│   ├── frontend/SKILL.md       # Frontend (`frontend`): story → plan → code → PR
│   ├── backend/SKILL.md        # Backend (`backend`): .NET/C# story → code → PR
│   ├── sdlc/SKILL.md           # Cross-agent SDLC contracts, handoffs, and mock-safe workflow rules
│   ├── reviewer/SKILL.md       # Reviewer (`reviewer`): PR review → comment → approve
│   ├── devops/SKILL.md         # DevOps (`devops`): build monitoring → merge
│   ├── ux/SKILL.md             # UX (`ux`): design → spec → handoff
│   ├── qa/SKILL.md             # QA (`qa`): Cypress, triage, YourProject support map
│   ├── office/SKILL.md         # Shared office / token-saving tools
│
├── tools/
│   └── mcp-agility/            # Agility (VersionOne) MCP server
│
├── bruno/
│   └── sdlc-framework/               # Bruno API collection (open in Bruno)
│       ├── agility/
│       ├── scheduler/
│       ├── tokens/
│       ├── handoff/
│       ├── ollama/
│       ├── chat/
│       ├── config/
│       └── environments/local.bru
│
├── docs/                       # Project documentation
│   ├── agents.md               # SDLC pipeline, agents, scheduler, step mode
│   ├── local-ai.md             # Ollama, RAG, Modelfile, inference tuning
│   ├── dashboard.md            # 3D office, themes, TUI
│   ├── api.md                  # API endpoint reference
│   ├── developer-tools.md      # Bruno, Harlequin, test scripts
│   ├── configuration.md        # .env, config JSON, MCP, prerequisites
│   └── structure.md            # This file
│
├── rules/                      # Portable Cursor rules
├── Modelfile                   # Custom Ollama model (sdlc-local:latest)
├── .cursor/mcp.json            # Workspace MCP config (committed)
├── .sdlc-framework.config.json       # Runtime config (gitignored)
├── .env                        # Credentials (gitignored)
├── .env.example                # Credentials template
├── vite.config.ts              # Vite build config + /api proxy → port 3001
└── package.json
```

## Key Boundaries

| Layer | Files | Notes |
|-------|-------|-------|
| **Agent processes** | `skills/*/SKILL.md`, `bin/run-agent.ps1` | Read/write `.{agentId}-status.json` directly |
| **API server** | `src/server/app.ts`, `src/server/index.ts` | Serves dashboard, drives handoffs |
| **SQLite** | `src/server/db.ts`, `.sdlc-framework/sdlc-framework.db` | Token ledger, chat, ollama state |
| **Status JSON** | `.frontend-status.json`, `.reviewer-status.json`, etc. | On-disk for agent CLI compat; filenames use **agent ID**, not display name |
| **Dashboard** | `src/dashboard/` | React, polls API, no direct file access |
