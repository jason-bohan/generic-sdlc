# Developer Tools

## Bruno (API Explorer)

A Bruno collection covering all SDLC Framework API endpoints is committed at `bruno/sdlc-framework/`. Collections are plain `.bru` files — no account or sync required, and they live in git alongside the code.

**Install:**

```powershell
winget install Bruno.Bruno
```

**Open:** Bruno → **Open Collection** → select `bruno/sdlc-framework/` → switch to the **local** environment.

Start the API server first: `npm run server`

**Folders:**

| Folder | Requests |
|--------|----------|
| `agility/` | Get teams, class of service, stories list, create story, update status |
| `scheduler/` | Assign story, approve, step advance, create/update task |
| `tokens/` | Get full ledger, ledger by story, update cloud/ollama tokens |
| `handoff/` | Review complete, build complete, design ready |
| `ollama/` | Health check, RAG reindex, local generate |
| `chat/` | Get messages, send message, chat with trigger matching |
| `config/` | Agent status, get config, list projects, send Teams notification |

See [API Reference](api.md) for full endpoint documentation.

---

## Scalar (API Reference)

An interactive API reference UI served at `http://localhost:3001/` when the standalone server is running. Powered by [Scalar](https://scalar.com/) with a built-in request tester — no extra install needed.

- **`/`** — Scalar interactive docs (dark theme, try-it-out for every endpoint)
- **`/api/openapi.json`** — raw OpenAPI 3.1 spec

All 30+ API routes are documented with request/response schemas, organized by tag: Status, Config, Agility, Scheduler, Handoff, Tokens, Chat, Ollama.

---

## Harlequin (SQLite TUI)

Harlequin is a full TUI SQL IDE for inspecting SDLC Framework's SQLite database directly from the terminal.

**Prerequisites:** Python 3.11+ (install via `winget install Python.Python.3.12` if needed).

**Install:**

```powershell
# If python/pip is on PATH:
pip install harlequin

# If not on PATH (common on Windows):
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m pip install harlequin
```

**Open the SDLC Framework database:**

```powershell
# If harlequin is on PATH:
harlequin .sdlc-framework/sdlc-framework.db

# If not on PATH:
& "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts\harlequin.exe" .sdlc-framework/sdlc-framework.db

# Or via npm script:
npm run db
```

Features: schema browser, split results pane, syntax highlighting, autocomplete, themes (Dracula, Solarized Dark, etc.).

**Tables:**

| Table | Contents |
|-------|----------|
| `token_ledger` | Per-story token history (replaces `.token-ledger.json`) |
| `ollama_state` | Ollama model state, digest, last pulled (replaces `ollama-state.json`) |
| `chat_messages` | Agent chat messages indexed by agent (replaces `.<agentId>-messages.json`) |

Agent status files (`.frontend-status.json`, `.reviewer-status.json`, `.devops-status.json`, etc.) remain on disk — agent CLI processes read them directly.

---

## Scripts

```powershell
npm run server                                                              # API server on port 3001
npm run db                                                                  # Harlequin SQLite TUI
npm run btw -- --agent frontend --message "hey, prioritize the login page"    # /btw chat
npm run ollama                                                              # Ollama delegation script
npm run pr:watch                                                            # PR watcher
npm run plan                                                                # Plan generator
```

---

## Testing

```powershell
npm test           # Run all Vitest tests (193 tests)
npm run test:watch # Watch mode
npm run cypress:run # Cypress integration tests
```

Tests use `jsdom` environment and mock external integrations. Set `SDLC_EXTERNAL_MODE=mock` or use `sdlc-framework --test` to run with local mock Agility/ADO/Teams.
