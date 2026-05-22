# Dashboard

Two views, switchable from settings:

## Simple Floor (2D)

Card-based grid showing all agents with phase badges, story numbers, current tasks, and action buttons (Open Desk, /btw chat, Pick Up Story, Approve, Step toggle).

## 3D Office

Interactive 3D office (React Three Fiber) with a top-down RPG aesthetic. Agents sit at desks — click to zoom in, assign stories, or chat.

Multi-room layout:
- **Dev Room** — Lasair, Cairn, Vigil at their desks
- **Server Room** — The SDLC Framework Mainframe (spinning tape reels)
- **Design Studio** — Prism's space with drafting table and mood board
- **Judge's Chamber** — Brehon's elevated bench with triple monitors and gavel
- **Break Room** — Fish tank, ping pong, water cooler

## Themes

| Theme | Description |
|-------|-------------|
| Far Out | Default 70s retro office aesthetic |
| Nice Admin | Clean admin panel style |
| Simple | Minimal flat design |
| Rock and Roll McDonald's | Maximalist fast-food energy |
| Lumon Industries | Severance MDR floor with cross desk layout and green carpet |

## Stats Bar

- Agent count, cloud/Ollama token consumption, active tasks, open PRs (with dropdown links)
- Per-story token ledger with input/output breakdown

## Org Chart

The Org Chart panel shows the full agent hierarchy and infrastructure:

- **Ollama node** — shows green **↑ Updated** badge when a model digest change is detected on pull, and a purple **RAG** badge when `nomic-embed-text` is ready
- Agent cards show active/inactive status, role, and model where applicable

## TUI (Terminal UI)

Interactive terminal interface built with Ink (React for CLI):

```powershell
sdlc-framework                # Launch the TUI
sdlc-framework --test         # Launch with local mock integrations
sdlc-framework create-story   # Create a story directly
```

Hotkeys:
- `s` — Toggle step mode for focused agent
- `n` — Advance to next step (when paused)
- `q` — Quit
