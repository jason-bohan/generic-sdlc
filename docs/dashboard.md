# Dashboard

Primary dashboard views:

## Simple Floor (2D)

Card-based grid showing all agents with phase badges, work-item keys, current tasks, model controls, provider status, chat, and action buttons such as Open Desk, /btw chat, Pick Up Story, Approve, Continue, Stop, and Step mode.

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
| Modern | Neutral product UI |
| Retro Carpet | Office-carpet inspired dense dashboard |

## Stats Bar

- Agent count, cloud/Ollama/MeshLLM token consumption, active tasks, open PRs (with dropdown links)
- Per-story token ledger with input/output breakdown

## Org Chart

The Org Chart panel shows the full agent hierarchy and infrastructure:

- **Ollama node** — shows green **↑ Updated** badge when a model digest change is detected on pull, and a purple **RAG** badge when `nomic-embed-text` is ready
- Agent cards show active/inactive status, role, and model where applicable

## AIQA Quality Panel

The **AIQA Quality Panel** appears inside any agent detail view. It provides a comprehensive quality dashboard:

- **Summary metrics**: Quality score (0–100), open findings count, financial risk level, sessions reviewed, total ledger tokens
- **Per-agent scorecards**: current phase, finding count, open tasks, token consumption — one card per agent
- **Eval checks**: 6 guardrail-style status indicators — tool-call format, evidence before success, handoff health, hallucination risk, token efficiency, eval suite health
- **Eval suite results**: Pass/fail breakdown of all built-in eval datasets, with drill-down to failing examples
- **Registered datasets**: Lists all active eval datasets with example counts
- **Hallucination risk signals**: When detected, shows severity, type, and description per signal
- **Financial controls panel**: Money-path tests, regulated data redaction, approval integrity, provider policy, audit evidence bundle — each with pass/warn/fail status and owner
- **Risk signals**: High-level financial risk areas (money movement, access control, regulated data, target repo)
- **Top findings**: Most severe open AIQA findings with severity badge, evidence, owner, and source
- **Run Eval Sweep button**: Files all open findings as task pills in `.aiqa-status.json`

Data refreshes every 30 seconds.

## AIQA Observability Panel

The **AIQA Observability Panel** shows a Datadog-inspired service topology with:

- **Service nodes**: API, database, cache, and external-service cards with latency (p50/p95/p99), request volume, and error rate sparklines
- **Error timeline**: Recent error events with severity, service, and message
- **Anomaly alerts**: Detected anomalies from telemetry data with severity and metric details
- **Topology graph**: SVG service-dependency map with latency-colored edges

The panel updates every 15 seconds and uses a dark theme with DD-style colors.

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
