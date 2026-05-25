#!/usr/bin/env python3
"""
model-evolution.py  —  Evolutionary model pool: select, retire, create candidates.

Maintains a pool of model candidates. After enough evaluation data accumulates,
weak models are retired and new candidates are registered for training (the actual
fine-tuning is delegated to trainer-service.py). Best performers survive.

Pool schema:
  {
    "SDLC Framework-v2": {
      "model_id":        "SDLC Framework-v2",
      "base_model":      "SDLC Framework-v1",
      "status":          "active",    # active | candidate | retired
      "avg_reward":      0.83,
      "success_rate":    0.91,
      "tasks_completed": 324,
      "trained_on":      ["null_ref", "async_await"],
      "created":         "...",
      "last_eval":       "...",
    }
  }

Storage: .model-pool.json

Usage:
  python scripts/model-evolution.py pool
  python scripts/model-evolution.py record --model SDLC Framework-tuned --success true --reward 0.8
  python scripts/model-evolution.py evolve
  python scripts/model-evolution.py promote --model SDLC Framework-v2
  python scripts/model-evolution.py benchmark --model SDLC Framework-tuned --eval eval.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

POOL_FILE       = Path(".model-pool.json")
SCRIPTS_DIR     = Path(__file__).parent
ALPHA           = 0.1
RETIRE_THRESHOLD = 0.35
MIN_TASKS_TO_RETIRE = 20
TOP_N_SURVIVE   = 3
MAX_CANDIDATES_PER_EVOLUTION = 3
MIN_TASKS_TO_PROMOTE = 20
MIN_PROMOTION_SIM_PASS_RATE = 0.80
MIN_PROMOTION_HOLDOUT_PASS_RATE = 0.75


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict:
    if POOL_FILE.exists():
        try:
            return json.loads(POOL_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save(pool: dict) -> None:
    POOL_FILE.write_text(json.dumps(pool, indent=2, ensure_ascii=False), encoding="utf-8")


# ─── Pool operations ──────────────────────────────────────────────────────────

def _ensure(model_id: str, pool: dict, base_model: str = "") -> dict:
    if model_id not in pool:
        pool[model_id] = {
            "model_id":        model_id,
            "base_model":      base_model or model_id,
            "status":          "active",
            "avg_reward":      0.5,
            "success_rate":    0.5,
            "tasks_completed": 0,
            "trained_on":      [],
            "created":         _now(),
            "last_eval":       _now(),
        }
    return pool[model_id]


def record_result(model_id: str, pool: dict, success: bool, reward: float) -> None:
    m = _ensure(model_id, pool)
    m["avg_reward"]      = (1 - ALPHA) * m["avg_reward"]      + ALPHA * reward
    m["success_rate"]    = (1 - ALPHA) * m["success_rate"]    + ALPHA * float(success)
    m["tasks_completed"] += 1
    m["last_eval"]        = _now()


def select_survivors(pool: dict, top_n: int = TOP_N_SURVIVE) -> list[str]:
    active = [m for m in pool.values() if m["status"] == "active"]
    active.sort(key=lambda m: -m["avg_reward"])
    return [m["model_id"] for m in active[:top_n]]


def retire_weak(pool: dict) -> list[str]:
    retired = []
    for m in pool.values():
        if (m["status"] == "active" and
                m["avg_reward"] < RETIRE_THRESHOLD and
                m["tasks_completed"] >= MIN_TASKS_TO_RETIRE):
            m["status"] = "retired"
            retired.append(m["model_id"])
    return retired


def register_candidate(base_model_id: str, pool: dict, trained_on: list[str] | None = None) -> str:
    """Register a new model candidate. Actual training is done by trainer-service."""
    prefix  = base_model_id.split("-v")[0]
    version = sum(1 for m in pool if m.startswith(prefix)) + 1
    new_id  = f"{prefix}-v{version}"
    m       = _ensure(new_id, pool, base_model_id)
    m["status"]     = "candidate"
    m["trained_on"] = trained_on or []
    return new_id


def evaluate_promotion(model_id: str, pool: dict) -> dict:
    model = pool.get(model_id)
    if not model:
        return {"approved": False, "reasons": ["model_not_found"], "model_id": model_id}

    reasons = []
    tasks_completed = model.get("tasks_completed", 0)
    simulation = model.get("simulation") or {}
    sim_total = simulation.get("total", 0)
    sim_passed = simulation.get("passed", 0)
    sim_pass_rate = (sim_passed / sim_total) if sim_total else 0.0
    holdout = model.get("holdout_eval") or {}
    holdout_total = holdout.get("total", 0)
    holdout_passed = holdout.get("passed", 0)
    holdout_pass_rate = (holdout_passed / holdout_total) if holdout_total else 0.0

    if model.get("status") not in {"candidate", "active"}:
        reasons.append("invalid_status")
    if tasks_completed < MIN_TASKS_TO_PROMOTE:
        reasons.append("insufficient_task_history")
    if sim_total <= 0:
        reasons.append("missing_simulation_gate")
    elif sim_pass_rate < MIN_PROMOTION_SIM_PASS_RATE:
        reasons.append("simulation_gate_failed")
    if holdout_total <= 0:
        reasons.append("missing_holdout_eval")
    elif holdout_pass_rate < MIN_PROMOTION_HOLDOUT_PASS_RATE:
        reasons.append("holdout_gate_failed")

    return {
        "approved": len(reasons) == 0,
        "reasons": reasons,
        "model_id": model_id,
        "evidence": {
            "tasks_completed": tasks_completed,
            "min_tasks": MIN_TASKS_TO_PROMOTE,
            "simulation_pass_rate": round(sim_pass_rate, 4),
            "min_simulation_pass_rate": MIN_PROMOTION_SIM_PASS_RATE,
            "simulation_total": sim_total,
            "holdout_pass_rate": round(holdout_pass_rate, 4),
            "min_holdout_pass_rate": MIN_PROMOTION_HOLDOUT_PASS_RATE,
            "holdout_total": holdout_total,
        },
    }


def promote(model_id: str, pool: dict) -> bool:
    decision = evaluate_promotion(model_id, pool)
    if decision["approved"] and model_id in pool:
        pool[model_id]["status"] = "active"
        pool[model_id]["promotion_decision"] = decision
        return True
    if model_id in pool:
        pool[model_id]["promotion_decision"] = decision
    return False


def evolve(pool: dict) -> dict:
    """One evolution step: retire weak models, create replacement candidates."""
    retired   = retire_weak(pool)
    survivors = select_survivors(pool)
    new_cands = []
    for _ in retired[:MAX_CANDIDATES_PER_EVOLUTION]:
        if survivors:
            new_id = register_candidate(survivors[0], pool)
            new_cands.append(new_id)
    return {
        "retired": retired,
        "survivors": survivors,
        "new_candidates": new_cands,
        "decision_trace": {
            "candidate_cap": MAX_CANDIDATES_PER_EVOLUTION,
            "retired_count": len(retired),
            "survivor_count": len(survivors),
            "reason": "cap replacement candidates to avoid complexity explosion",
        },
    }


# ─── Benchmark ────────────────────────────────────────────────────────────────

def benchmark(model_id: str, eval_path: str, mesh_url: str) -> float:
    eval_script = SCRIPTS_DIR / "eval-model.py"
    if not eval_script.exists():
        print("eval-model.py not found")
        return 0.0
    result = subprocess.run(
        [sys.executable, str(eval_script),
         "--dataset", eval_path, "--mesh-url", mesh_url,
         "--model", model_id, "--limit", "50"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    output = result.stdout + result.stderr
    m = re.search(r"Mean composite:\s*([0-9.]+)", output)
    score = float(m.group(1)) if m else 0.0
    print(output[-600:])
    return score


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Evolutionary model pool management")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("pool", help="Show current model pool")

    rec = sub.add_parser("record", help="Record a task result for a model")
    rec.add_argument("--model",   required=True)
    rec.add_argument("--success", type=lambda x: x.lower() == "true", required=True)
    rec.add_argument("--reward",  type=float, default=0.5)

    sub.add_parser("evolve", help="Run one evolution step (retire weak, create candidates)")

    prom = sub.add_parser("promote", help="Promote a candidate to active")
    prom.add_argument("--model", required=True)

    cand = sub.add_parser("candidate", help="Manually register a new candidate model")
    cand.add_argument("--base",   required=True, help="Base model ID")
    cand.add_argument("--trained-on", default="", help="Comma-sep clusters this was trained on")

    bench = sub.add_parser("benchmark", help="Benchmark a model against an eval set")
    bench.add_argument("--model",    required=True)
    bench.add_argument("--eval",     required=True, help="Path to eval JSONL")
    bench.add_argument("--mesh-url", default="http://localhost:9337")

    args = parser.parse_args()
    pool = _load()

    if args.cmd == "pool":
        if not pool:
            print("Pool is empty")
            return
        print(f"{'Model':<30} {'Status':<12} {'Reward':>8} {'SR':>6} {'Tasks':>7}")
        print("-" * 62)
        for m in sorted(pool.values(), key=lambda x: -x["avg_reward"]):
            print(f"{m['model_id']:<30} {m['status']:<12} {m['avg_reward']:>8.3f} "
                  f"{m['success_rate']:>6.2f} {m['tasks_completed']:>7}")

    elif args.cmd == "record":
        record_result(args.model, pool, args.success, args.reward)
        _save(pool)
        m = pool[args.model]
        print(f"Updated {args.model}: reward={m['avg_reward']:.3f}  sr={m['success_rate']:.3f}")

    elif args.cmd == "evolve":
        result = evolve(pool)
        _save(pool)
        print(f"Retired   : {result['retired'] or 'none'}")
        print(f"Survivors : {result['survivors']}")
        print(f"New cands : {result['new_candidates'] or 'none'}")

    elif args.cmd == "promote":
        promoted = promote(args.model, pool)
        _save(pool)
        if promoted:
            print(f"Promoted: {args.model} -> active")
        else:
            decision = pool.get(args.model, {}).get("promotion_decision", {})
            print(f"Promotion blocked: {args.model}  reasons={decision.get('reasons', ['model_not_found'])}")

    elif args.cmd == "candidate":
        clusters = [c.strip() for c in args.trained_on.split(",") if c.strip()]
        new_id   = register_candidate(args.base, pool, clusters)
        _save(pool)
        print(f"Registered candidate: {new_id}  base={args.base}")

    elif args.cmd == "benchmark":
        score = benchmark(args.model, args.eval, args.mesh_url)
        print(f"\nComposite score: {score:.3f}")
        record_result(args.model, pool, score >= 0.60, score)
        _save(pool)


if __name__ == "__main__":
    main()
