#!/usr/bin/env python3
"""
manager-agent.py  —  Orchestrator: prioritizes tasks, auctions to agents, evolves models.

The manager acts as tech lead + engineering manager for the autonomous system:
  - Collects tasks from goal-engine, CI failures, or a manual queue
  - Prioritizes by impact * urgency
  - Runs agent auctions (via agent-economy) to assign work
  - Executes via fix-pipeline.py and updates all downstream state
  - Periodically reflects on system health and triggers model evolution

Usage:
  python scripts/manager-agent.py run --cycles 5
  python scripts/manager-agent.py run --forever --delay 30
  python scripts/manager-agent.py status
  python scripts/manager-agent.py reflect
  python scripts/manager-agent.py queue --add "Fix null ref in agent status" --cluster null_ref
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR   = Path(__file__).parent
QUEUE_FILE    = Path(".manager-queue.json")
STATE_FILE    = Path(".manager-state.json")

REFLECT_EVERY = 5   # reflect every N cycles
EVOLVE_EVERY  = 10  # evolve model pool every N cycles


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Queue ────────────────────────────────────────────────────────────────────

def _load_queue() -> list[dict]:
    if QUEUE_FILE.exists():
        try:
            return json.loads(QUEUE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_queue(queue: list[dict]) -> None:
    QUEUE_FILE.write_text(json.dumps(queue, indent=2, ensure_ascii=False), encoding="utf-8")


def add_task(
    queue: list[dict],
    instruction: str,
    cluster: str = "unknown",
    urgency: float = 0.5,
    impact: float = 0.5,
) -> None:
    dedupe_key = f"{cluster}::{instruction}"
    for task in queue:
        trace = task.get("decision_trace", {})
        existing_key = trace.get("dedupe_key") or f"{task.get('cluster', 'unknown')}::{task.get('instruction', '')}"
        if task.get("status") == "pending" and existing_key == dedupe_key:
            return

    clamped_urgency = max(0.0, min(1.0, urgency))
    clamped_impact  = max(0.0, min(1.0, impact))
    queue.append({
        "instruction": instruction,
        "cluster":     cluster,
        "urgency":     clamped_urgency,
        "impact":      clamped_impact,
        "score":       round(clamped_urgency * clamped_impact, 4),
        "added":       _now(),
        "status":      "pending",
        "decision_trace": {
            "dedupe_key":    dedupe_key,
            "raw_urgency":   urgency,
            "raw_impact":    impact,
            "score_formula": "clamp(urgency) * clamp(impact)",
        },
    })
    queue.sort(key=lambda t: -t["score"])


def pending_tasks(queue: list[dict]) -> list[dict]:
    return [t for t in queue if t.get("status") == "pending"]


# ─── State evidence ───────────────────────────────────────────────────────────

def build_state_snapshot(state: dict, profiles: dict, queue: list[dict]) -> dict:
    """Build structured evidence that reflective model claims can be checked against."""
    pending = pending_tasks(queue)
    done = [t for t in queue if t.get("status") == "done"]
    failed = [t for t in queue if t.get("status") == "failed"]
    top_agents = sorted(
        profiles.values(),
        key=lambda p: -p.get("performance", {}).get("success_rate", 0.0),
    )
    top_agent_ids = [p.get("agent_id") for p in top_agents if p.get("agent_id")]
    return {
        "cycle": state.get("cycle", 0),
        "tasks_run": state.get("tasks_run", 0),
        "active_agents": len(profiles),
        "agent_ids": sorted(profiles.keys()),
        "top_agent_ids": top_agent_ids,
        "pending_tasks": len(pending),
        "done_tasks": len(done),
        "failed_tasks": len(failed),
        "queue_size": len(queue),
    }


def validate_state_claims(claims: dict, snapshot: dict) -> dict:
    """Reject structured claims that cannot be backed by the current evidence snapshot."""
    unsupported = []
    numeric_fields = ["cycle", "tasks_run", "active_agents", "pending_tasks", "done_tasks", "failed_tasks", "queue_size"]
    for field in numeric_fields:
        if field in claims and claims[field] != snapshot.get(field):
            unsupported.append({
                "field": field,
                "claimed": claims[field],
                "observed": snapshot.get(field),
            })

    if "top_agent" in claims and claims["top_agent"] not in snapshot.get("top_agent_ids", []):
        unsupported.append({
            "field": "top_agent",
            "claimed": claims["top_agent"],
            "observed": snapshot.get("top_agent_ids", []),
        })

    if "agent_id" in claims and claims["agent_id"] not in snapshot.get("agent_ids", []):
        unsupported.append({
            "field": "agent_id",
            "claimed": claims["agent_id"],
            "observed": snapshot.get("agent_ids", []),
        })

    return {
        "ok": len(unsupported) == 0,
        "unsupported_claims": unsupported,
        "evidence": snapshot,
    }


def create_checkpoint(
    decision_type: str,
    summary: str,
    evidence: dict,
    context: dict | None = None,
) -> dict:
    """Create a human-visible checkpoint before high-risk autonomous decisions."""
    context = context or {}
    checkpoint = {
        "checkpoint_id": f"checkpoint-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
        "decision_type": decision_type,
        "summary": summary,
        "requires_human_review": True,
        "created": _now(),
        "evidence": evidence,
        "context": context,
    }
    if "rollback_ref" in context:
        checkpoint["rollback_ref"] = context["rollback_ref"]
    if "changed_files" in context:
        checkpoint["changed_files"] = context["changed_files"]
    return checkpoint


# ─── State ────────────────────────────────────────────────────────────────────

def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"cycle": 0, "tasks_run": 0, "last_reflect": None, "last_evolve": None}


def _save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


# ─── Profile + economy helpers ────────────────────────────────────────────────

def _load_json(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _select_agent(task: dict, profiles: dict) -> str:
    """Pick the highest-affinity agent for the task cluster."""
    cluster    = task.get("cluster", "")
    best_id    = None
    best_score = -1.0
    for agent_id, p in profiles.items():
        seen  = p["clusters_seen"].get(cluster, 0)
        total = sum(p["clusters_seen"].values()) or 1
        score = 0.6 * (seen / total) + 0.4 * p["performance"]["success_rate"]
        if score > best_score:
            best_score = score
            best_id    = agent_id
    return best_id or "default-agent"


# ─── Pipeline execution ───────────────────────────────────────────────────────

def run_pipeline(
    task: dict,
    mesh_url: str,
    model: str,
    test_cmd: str,
) -> bool:
    pipeline = SCRIPTS_DIR / "fix-pipeline.py"
    cmd = [
        sys.executable, str(pipeline),
        "--task",     task["instruction"],
        "--mesh-url", mesh_url,
        "--model",    model,
        "--test",     test_cmd,
        "--record-meta",
    ]
    return subprocess.run(cmd, text=True, encoding="utf-8", errors="replace").returncode == 0


# ─── Goal-engine top-up ───────────────────────────────────────────────────────

def _topup_from_goal_engine(limit: int = 3) -> int:
    ge = SCRIPTS_DIR / "goal-engine.py"
    if not ge.exists():
        return 0
    result = subprocess.run(
        [sys.executable, str(ge), "generate", "--top-k", str(limit)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode == 0:
        try:
            tasks = json.loads(result.stdout)
            queue = _load_queue()
            for t in tasks:
                add_task(queue, t["instruction"], t.get("cluster", "unknown"),
                         urgency=t.get("score", 0.3), impact=t.get("failure_rate", 0.3))
            _save_queue(queue)
            return len(tasks)
        except Exception:
            pass
    return 0


# ─── Reflective reasoning ─────────────────────────────────────────────────────

_REFLECT_PROMPT = """\
You are the manager of an autonomous AI engineering system.
Review this system snapshot and identify the single biggest weakness or opportunity.
Output ONE concrete action to take (2 sentences max).

{state_summary}
"""


def _call_model(prompt: str, url: str, model: str) -> str:
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens": 256,
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
    req = urllib.request.Request(
        f"{url}/v1/chat/completions", data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"[reflect error: {e}]"


def reflect(mesh_url: str, model: str, state: dict, profiles: dict, queue: list[dict]) -> str:
    top_agents = sorted(profiles.values(), key=lambda p: -p["performance"]["success_rate"])[:3]
    agents_str = ", ".join(
        f"{p['agent_id']}(sr={p['performance']['success_rate']:.2f})"
        for p in top_agents
    ) or "none"

    summary = (
        f"Cycle: {state['cycle']}  Tasks run: {state['tasks_run']}  "
        f"Active agents: {len(profiles)}\n"
        f"Top agents: {agents_str}\n"
        f"Pending tasks: {len(pending_tasks(queue))}"
    )
    return _call_model(_REFLECT_PROMPT.format(state_summary=summary), mesh_url, model)


# ─── Main loop ────────────────────────────────────────────────────────────────

def run_loop(
    max_cycles: int,
    mesh_url: str,
    model: str,
    test_cmd: str,
    forever: bool,
    delay_s: float,
) -> None:
    state      = _load_state()
    cycle_num  = 0

    while forever or cycle_num < max_cycles:
        state["cycle"] += 1
        cycle_num      += 1
        print(f"\n=== Manager cycle {state['cycle']} ===  {_now()}")

        queue    = _load_queue()
        profiles = _load_json(Path(".agent-profiles.json"))
        tasks    = pending_tasks(queue)

        if not tasks:
            print("  Queue empty — generating goals...")
            added = _topup_from_goal_engine(limit=3)
            print(f"  Added {added} tasks from goal-engine")
            queue = _load_queue()
            tasks = pending_tasks(queue)

        if tasks:
            task     = tasks[0]
            agent_id = _select_agent(task, profiles)
            print(f"  Task    : {task['instruction'][:70]}")
            print(f"  Cluster : {task.get('cluster', '?')}  score={task['score']:.3f}")
            print(f"  Agent   : {agent_id}")

            success = run_pipeline(task, mesh_url, model, test_cmd)
            status  = "done" if success else "failed"
            print(f"  Result  : {status}")

            for t in queue:
                if t["instruction"] == task["instruction"] and t["status"] == "pending":
                    t["status"] = status
                    break
            _save_queue(queue)
            state["tasks_run"] += 1
        else:
            print("  No tasks available this cycle")

        # Periodic: reflect
        if state["cycle"] % REFLECT_EVERY == 0:
            print("\n  [reflect] Analyzing system state...")
            insight = reflect(mesh_url, model, state, profiles, queue)
            print(f"  Insight : {insight}")
            state["last_reflect"] = _now()

        # Periodic: evolve model pool
        if state["cycle"] % EVOLVE_EVERY == 0:
            evo = SCRIPTS_DIR / "model-evolution.py"
            if evo.exists():
                print("\n  [evolve] Running model evolution...")
                subprocess.run([sys.executable, str(evo), "evolve"],
                               capture_output=True)
            state["last_evolve"] = _now()

        _save_state(state)

        if (forever or cycle_num < max_cycles) and delay_s > 0:
            time.sleep(delay_s)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Manager agent — orchestrates the autonomous system")
    sub = parser.add_subparsers(dest="cmd", required=True)

    run_p = sub.add_parser("run", help="Run orchestration loop")
    run_p.add_argument("--cycles",   type=int, default=5)
    run_p.add_argument("--forever",  action="store_true")
    run_p.add_argument("--delay",    type=float, default=5.0, help="Seconds between cycles")
    run_p.add_argument("--mesh-url", default="http://localhost:9337")
    run_p.add_argument("--model",    default="SDLC Framework-tuned")
    run_p.add_argument("--test",     default="npx vitest run")

    sub.add_parser("status", help="Show manager state and pending queue")

    ref_p = sub.add_parser("reflect", help="Run one reflective reasoning step")
    ref_p.add_argument("--mesh-url", default="http://localhost:9337")
    ref_p.add_argument("--model",    default="qwen3:14b")

    q_add = sub.add_parser("queue", help="Add a task to the queue")
    q_add.add_argument("--add",     required=True)
    q_add.add_argument("--cluster", default="unknown")
    q_add.add_argument("--urgency", type=float, default=0.5)
    q_add.add_argument("--impact",  type=float, default=0.5)

    args = parser.parse_args()

    if args.cmd == "run":
        run_loop(args.cycles, args.mesh_url, args.model, args.test, args.forever, args.delay)

    elif args.cmd == "status":
        state = _load_state()
        queue = _load_queue()
        p_cnt = sum(1 for t in queue if t["status"] == "pending")
        d_cnt = sum(1 for t in queue if t["status"] == "done")
        f_cnt = sum(1 for t in queue if t["status"] == "failed")
        print(f"Cycle        : {state.get('cycle', 0)}")
        print(f"Tasks run    : {state.get('tasks_run', 0)}")
        print(f"Last reflect : {state.get('last_reflect', 'never')}")
        print(f"Last evolve  : {state.get('last_evolve', 'never')}")
        print(f"\nQueue: {p_cnt} pending / {d_cnt} done / {f_cnt} failed")
        for t in queue[:5]:
            if t["status"] == "pending":
                print(f"  [{t['cluster']}] {t['instruction'][:60]}  score={t['score']:.3f}")

    elif args.cmd == "reflect":
        state    = _load_state()
        profiles = _load_json(Path(".agent-profiles.json"))
        queue    = _load_queue()
        insight  = reflect(args.mesh_url, args.model, state, profiles, queue)
        print(f"Insight: {insight}")

    elif args.cmd == "queue":
        queue = _load_queue()
        add_task(queue, args.add, args.cluster, args.urgency, args.impact)
        _save_queue(queue)
        print(f"Added: {args.add[:70]}")
        print(f"  cluster={args.cluster}  score={args.urgency * args.impact:.3f}")


if __name__ == "__main__":
    main()
