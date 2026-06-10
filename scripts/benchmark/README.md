# SDLC Framework Benchmarking

This directory contains scripts to benchmark the SDLC framework's agents against custom test cases (SWE-bench equivalent).

## Scripts

### 1. `inject.ts`
Injects test work items (e.g., GitHub issues, Agility tasks) into the framework.
- **Inputs**: JSON file with test cases (e.g., `[{"title": "Fix login redirect", "description": "...", "repo": "frontend"}]`).
- **Outputs**: Work items in the `workflow_items` table.

### 2. `monitor.ts`
Monitors agent workflows for injected work items.
- **Tracks**: Phase transitions, tool usage, handoffs, and token consumption.
- **Outputs**: JSON logs of agent activity.

### 3. `evaluate.ts`
Evaluates benchmark results.
- **Metrics**: Success rate, time-to-resolution, token efficiency, handoff accuracy.
- **Outputs**: Markdown report with pass/fail results.

## Usage

1. **Define test cases**: Add a JSON file (e.g., `test-cases.json`) with work items.
2. **Inject**: `npx tsx scripts/benchmark/inject.ts test-cases.json`
3. **Monitor**: `npx tsx scripts/benchmark/monitor.ts` (runs in background)
4. **Evaluate**: `npx tsx scripts/benchmark/evaluate.ts`

## Example Test Case
```json
[
  {
    "title": "Add dark mode toggle",
    "description": "Implement a dark/light mode toggle in the dashboard. Use the existing theme context.",
    "repo": "frontend",
    "expected_phases": ["tasking", "coding", "reviewing", "devops"],
    "expected_tools": ["read_file", "edit_file", "create_pr"]
  }
]
```