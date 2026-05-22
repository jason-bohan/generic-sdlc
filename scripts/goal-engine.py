#!/usr/bin/env python3
"""
goal-engine.py  —  Goal-directed autonomy: identify and generate improvement tasks.

Instead of only reacting to CI failures, the goal engine proactively analyzes
learning telemetry, scores opportunity clusters, and generates targeted fix tasks
that the pipeline can execute autonomously.

Opportunity score = (failure_rate * severity) * frequency / avg_difficulty

Usage:
  python scripts/goal-engine.py targets             # Show ranked improvement targets
  python scripts/goal-engine.py generate --top-k 5 --output tasks.json
  python scripts/goal-engine.py run --limit 3 --dry-run
  python scripts/goal-engine.py status
"""

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR  = Path(__file__).parent
META_LOG     = Path(".meta-learning.jsonl")
CLUSTER_HIST = Path(".failure-clusters.json")
GOALS_FILE   = Path(".goal-engine-state.json")

_SEVERITY: dict[str, float] = {
    "null_ref":       1.2,
    "async_await":    1.0,
    "test_assertion": 0.8,
    "timeout":        0.9,
    "import_error":   1.0,
    "type_error":     0.9,
    "syntax_error":   1.3,
    "unknown":        0.5,
}

_TEMPLATES: dict[str, list[str]] = {
    "null_ref": [
        "Audit property accesses in src/ and add null guards where needed",
        "Fix null reference errors in the null_ref cluster — add defensive checks",
    ],
    "async_await": [
        "Review async functions and ensure all promises are properly awaited",
        "Fix missing await calls in the async_await cluster",
    ],
    "test_assertion": [
        "Update failing test assertions to match current implementation",
        "Fix test expectations for the test_assertion cluster",
    ],
    "timeout": [
        "Increase timeouts and add retry logic for flaky async operations",
        "Fix timeout failures — review all API client calls",
    ],
    "import_error": [
        "Fix broken import paths and missing exports in codebase",
        "Resolve import errors — check all module boundaries",
    ],
    "type_error": [
        "Fix TypeScript type mismatches — add missing type annotations",
        "Resolve type errors in the type_error cluster",
    ],
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_meta_log() -> list[dict]:
    if not META_LOG.exists():
        return []
    records = []
    with META_LOG.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except Exception:
                    pass
    return records


def _load_goals() -> dict:
    if GOALS_FILE.exists():
        try:
            return json.loads(GOALS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"generated_tasks": [], "last_run": None, "cycles": 0}


def _save_goals(state: dict) -> None:
    GOALS_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


# ─── Opportunity analysis ─────────────────────────────────────────────────────

def analyze_opportunities(meta_records: list[dict]) -> list[dict]:
    cluster_data: dict[str, dict] = defaultdict(lambda: {
        "tasks":    set(),
        "failures": 0,
        "attempts": 0,
    })

    for r in meta_records:
        cluster = r.get("cluster", "unknown")
        task_id = r.get("task_id") or f"__anon__{r.get('ts', '')}_{cluster}"
        cluster_data[cluster]["tasks"].add(task_id)
        cluster_data[cluster]["attempts"] += 1
        if not r.get("success"):
            cluster_data[cluster]["failures"] += 1

    max_tasks = max((len(d["tasks"]) for d in cluster_data.values()), default=1) or 1

    opportunities = []
    for cluster, d in cluster_data.items():
        n_tasks     = len(d["tasks"]) or 1
        failure_rate = d["failures"] / n_tasks
        frequency    = n_tasks / max_tasks
        difficulty   = d["attempts"] / n_tasks
        severity     = _SEVERITY.get(cluster, 0.7)
        score        = (failure_rate * severity) * frequency / max(difficulty, 1.0)

        opportunities.append({
            "cluster":        cluster,
            "score":          round(score, 4),
            "failure_rate":   round(failure_rate, 3),
            "frequency":      round(frequency, 3),
            "difficulty":     round(difficulty, 2),
            "total_tasks":    n_tasks,
            "total_failures": d["failures"],
        })

    opportunities.sort(key=lambda x: -x["score"])
    return opportunities


def generate_tasks(opportunities: list[dict], top_k: int = 5) -> list[dict]:
    tasks = []
    viable = [o for o in opportunities if o.get("score", 0) > 0 and o.get("failure_rate", 0) > 0]
    for opp in viable[:top_k]:
        cluster   = opp["cluster"]
        templates = _TEMPLATES.get(cluster, [f"Improve handling of {cluster} issues in codebase"])
        for tmpl in templates[:2]:
            tasks.append({
                "instruction":         tmpl,
                "cluster":             cluster,
                "score":               opp["score"],
                "failure_rate":        opp["failure_rate"],
                "source":              "goal-engine",
                "generated_at":        _now(),
                "alignment_objective": "reduce recurring verified failures without expanding scope",
                "acceptance_criteria": [
                    "the targeted failure cluster is reduced or eliminated",
                    "the configured validation command passes",
                    "no unrelated behavior is changed",
                ],
                "guardrails": {
                    "requires_tests": True,
                    "scope": "targeted failure cluster",
                    "reject_if_score_at_or_below": 0,
                },
                "decision_trace": {
                    "source":            "goal-engine",
                    "cluster":           cluster,
                    "opportunity_score": opp["score"],
                    "failure_rate":      opp["failure_rate"],
                    "template":          tmpl,
                },
            })
    return tasks


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Goal-directed autonomous task generation")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("targets", help="Show ranked improvement opportunities")

    gen = sub.add_parser("generate", help="Generate improvement task list")
    gen.add_argument("--top-k", type=int, default=5)
    gen.add_argument("--output", default="", help="Write JSON to file (default: stdout)")

    run_p = sub.add_parser("run", help="Generate tasks and run fix pipeline")
    run_p.add_argument("--limit",    type=int, default=3)
    run_p.add_argument("--pipeline", default="scripts/fix-pipeline.py")
    run_p.add_argument("--mesh-url", default="http://localhost:9337")
    run_p.add_argument("--model",    default="SDLC Framework-tuned")
    run_p.add_argument("--test",     default="npx vitest run")
    run_p.add_argument("--dry-run",  action="store_true")

    sub.add_parser("status", help="Show goal engine state and top target")

    args = parser.parse_args()
    records = _load_meta_log()
    opps    = analyze_opportunities(records)

    if args.cmd == "targets":
        if not opps:
            print("No data yet — run fix-pipeline.py with --record-meta to populate")
            return
        print(f"{'Cluster':<18} {'Score':>7} {'FailRate':>9} {'Freq':>6} {'Diff':>6} {'Tasks':>6}")
        print("-" * 60)
        for o in opps[:10]:
            print(f"{o['cluster']:<18} {o['score']:>7.4f} {o['failure_rate']:>9.2f} "
                  f"{o['frequency']:>6.2f} {o['difficulty']:>6.1f} {o['total_tasks']:>6}")

    elif args.cmd == "generate":
        tasks = generate_tasks(opps, args.top_k)
        if not tasks:
            print("No opportunities identified — see 'targets' subcommand")
            return
        out = json.dumps(tasks, indent=2)
        if args.output:
            Path(args.output).write_text(out, encoding="utf-8")
            print(f"Generated {len(tasks)} tasks -> {args.output}")
        else:
            print(out)
        state = _load_goals()
        state["generated_tasks"].extend(tasks)
        state["last_run"] = _now()
        state["cycles"] += 1
        _save_goals(state)

    elif args.cmd == "run":
        tasks = generate_tasks(opps, args.limit)
        if not tasks:
            print("No tasks to run")
            return
        for i, task in enumerate(tasks):
            print(f"\n[{i+1}/{len(tasks)}] {task['instruction']}")
            print(f"  cluster={task['cluster']}  score={task['score']:.4f}")
            if args.dry_run:
                print("  (dry-run)")
                continue
            cmd = [
                sys.executable, str(Path(args.pipeline).resolve()),
                "--task",     task["instruction"],
                "--mesh-url", args.mesh_url,
                "--model",    args.model,
                "--test",     args.test,
                "--record-meta",
            ]
            rc = subprocess.run(cmd, text=True, encoding="utf-8", errors="replace").returncode
            print(f"  -> {'PASSED' if rc == 0 else 'FAILED'}")

    elif args.cmd == "status":
        state = _load_goals()
        print(f"Last run       : {state.get('last_run', 'never')}")
        print(f"Tasks generated: {len(state.get('generated_tasks', []))}")
        print(f"Cycles run     : {state.get('cycles', 0)}")
        print(f"Meta records   : {len(records)}")
        print(f"Opportunities  : {len(opps)}")
        if opps:
            t = opps[0]
            print(f"Top target     : {t['cluster']}  score={t['score']:.4f}  "
                  f"failure_rate={t['failure_rate']:.2f}")


if __name__ == "__main__":
    main()
