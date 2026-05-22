#!/usr/bin/env python3
"""
meta-learning.py  —  Track system learning efficiency and adapt routing/training.

Answers: "not just does the fix work, but how fast does the system learn to fix this CLASS of bug?"

Records per-attempt telemetry and computes per-cluster efficiency scores.
Higher efficiency = fewer attempts + faster time. Lower = route to better model or resample.

Storage: .meta-learning.jsonl  (append-only event log)
         .meta-routing.json    (derived routing recommendations, regenerated on demand)

Usage:
  # Record an attempt (called by fix-pipeline.py / plan-and-fix.py)
  python scripts/meta-learning.py record \\
      --cluster null_ref --attempt 1 --success false --model meitheal-tuned \\
      --time 14.2 --score 0.43

  # Query routing recommendation for a cluster
  python scripts/meta-learning.py recommend --cluster null_ref

  # Print full efficiency report
  python scripts/meta-learning.py report

  # Generate training resampling weights (for trainer-service.py)
  python scripts/meta-learning.py weights --output ml/unsloth/data/sample-weights.json

Importable:
  from scripts.meta_learning import record_attempt, get_routing_recommendation
"""

import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

LOG_FILE     = Path(".meta-learning.jsonl")
ROUTING_FILE = Path(".meta-routing.json")

# Models in preference order (cheapest/fastest first)
MODEL_LADDER = [
    "meitheal-tuned",
    "qwen3:8b",
    "qwen3:14b",
    "deepseek/deepseek-chat",
    "anthropic/claude-sonnet-4",
]

# Minimum attempts before we trust the efficiency estimate
MIN_SAMPLES = 5
# Efficiency below this triggers a routing upgrade
ESCALATE_THRESHOLD = 0.15


# ─── I/O ──────────────────────────────────────────────────────────────────────

def _append(record: dict) -> None:
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _load_log() -> list[dict]:
    if not LOG_FILE.exists():
        return []
    records = []
    with LOG_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return records


# ─── Recording ────────────────────────────────────────────────────────────────

def record_attempt(
    cluster: str,
    attempt: int,
    success: bool,
    model_used: str,
    time_s: float,
    diff_score: float = 0.0,
    task_id: str = "",
) -> None:
    _append({
        "ts":         datetime.now(timezone.utc).isoformat(),
        "cluster":    cluster,
        "attempt":    attempt,
        "success":    success,
        "model":      model_used,
        "time_s":     round(time_s, 2),
        "diff_score": round(diff_score, 3),
        "task_id":    task_id,
    })


# ─── Analysis ─────────────────────────────────────────────────────────────────

def _cluster_stats(records: list[dict]) -> dict[str, dict]:
    """Aggregate per-cluster metrics from the raw log."""
    clusters: dict[str, dict] = defaultdict(lambda: {
        "total":          0,
        "successes":      0,
        "total_attempts": 0,
        "total_time":     0.0,
        "models":         defaultdict(int),
        "scores":         [],
    })

    # Group by task_id to count unique tasks
    tasks: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        key = r.get("task_id") or f"anon-{r['cluster']}-{r['ts']}"
        tasks[key].append(r)

    for task_records in tasks.values():
        cluster    = task_records[0]["cluster"]
        succeeded  = any(r["success"] for r in task_records)
        n_attempts = len(task_records)
        total_time = sum(r["time_s"] for r in task_records)
        models     = [r["model"] for r in task_records]
        scores     = [r["diff_score"] for r in task_records if r["diff_score"] > 0]
        final_model = models[-1]

        c = clusters[cluster]
        c["total"]          += 1
        c["successes"]      += int(succeeded)
        c["total_attempts"] += n_attempts
        c["total_time"]     += total_time
        c["models"][final_model] += 1
        c["scores"].extend(scores)

    return dict(clusters)


def _efficiency(stats: dict) -> float:
    """Efficiency = success_rate / (avg_attempts * avg_time_normalised)."""
    if stats["total"] == 0:
        return 0.0
    success_rate = stats["successes"] / stats["total"]
    avg_attempts = stats["total_attempts"] / max(stats["total"], 1)
    avg_time     = stats["total_time"] / max(stats["total"], 1)
    # Normalize time: assume 60s is the expected baseline
    time_factor  = max(1.0, avg_time / 60.0)
    return success_rate / (avg_attempts * time_factor)


# ─── Routing recommendations ───────────────────────────────────────────────────

def build_routing(records: list[dict]) -> dict[str, dict]:
    stats = _cluster_stats(records)
    routing: dict[str, dict] = {}

    for cluster, s in stats.items():
        n = s["total"]
        eff = _efficiency(s)
        success_rate = s["successes"] / max(n, 1)

        # Current best model for this cluster
        best_model = max(s["models"], key=s["models"].__getitem__) if s["models"] else MODEL_LADDER[0]

        # Recommend upgrade if efficiency is low and we have enough data
        recommended_model = best_model
        if n >= MIN_SAMPLES and eff < ESCALATE_THRESHOLD:
            current_idx = next(
                (i for i, m in enumerate(MODEL_LADDER) if m == best_model),
                0,
            )
            if current_idx < len(MODEL_LADDER) - 1:
                recommended_model = MODEL_LADDER[current_idx + 1]

        routing[cluster] = {
            "n":                n,
            "efficiency":       round(eff, 4),
            "success_rate":     round(success_rate, 3),
            "avg_attempts":     round(s["total_attempts"] / max(n, 1), 2),
            "avg_time_s":       round(s["total_time"] / max(n, 1), 1),
            "best_model":       best_model,
            "recommended_model": recommended_model,
            "upgraded":         recommended_model != best_model,
            "avg_score":        round(sum(s["scores"]) / max(len(s["scores"]), 1), 3),
        }

    # Save derived routing file
    ROUTING_FILE.write_text(json.dumps(routing, indent=2), encoding="utf-8")
    return routing


def get_routing_recommendation(cluster: str) -> dict:
    """Return the routing recommendation for a cluster. Builds routing if stale."""
    if ROUTING_FILE.exists():
        try:
            routing = json.loads(ROUTING_FILE.read_text(encoding="utf-8"))
            if cluster in routing:
                return routing[cluster]
        except Exception:
            pass
    # Rebuild
    records = _load_log()
    routing = build_routing(records)
    return routing.get(cluster, {"recommended_model": MODEL_LADDER[0], "efficiency": None})


# ─── Training weights ─────────────────────────────────────────────────────────

def compute_training_weights(records: list[dict]) -> dict[str, float]:
    """
    Return per-cluster sampling weights for the next training run.
    Clusters with low efficiency → higher weight (need more training).
    Clusters with high efficiency → lower weight (already learned well).
    """
    stats = _cluster_stats(records)
    if not stats:
        return {}

    efficiencies = {c: _efficiency(s) for c, s in stats.items()}
    max_eff = max(efficiencies.values()) or 1.0

    weights: dict[str, float] = {}
    for cluster, eff in efficiencies.items():
        # Invert and normalise: worst cluster → weight 2.0, best → weight 0.5
        normalised = eff / max_eff if max_eff else 1.0
        weights[cluster] = round(2.0 - 1.5 * normalised, 3)

    return weights


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Meta-learning tracker and routing advisor")
    sub = parser.add_subparsers(dest="cmd", required=True)

    rec = sub.add_parser("record", help="Record a fix attempt")
    rec.add_argument("--cluster",  required=True)
    rec.add_argument("--attempt",  type=int, required=True)
    rec.add_argument("--success",  type=lambda x: x.lower() == "true", required=True)
    rec.add_argument("--model",    required=True)
    rec.add_argument("--time",     type=float, required=True)
    rec.add_argument("--score",    type=float, default=0.0)
    rec.add_argument("--task-id",  default="")

    rec2 = sub.add_parser("recommend", help="Get routing recommendation for a cluster")
    rec2.add_argument("--cluster", required=True)

    sub.add_parser("report", help="Print efficiency report for all clusters")

    wt = sub.add_parser("weights", help="Compute training resampling weights")
    wt.add_argument("--output", default="", help="Write JSON to this file (default: stdout)")

    args = parser.parse_args()

    if args.cmd == "record":
        record_attempt(
            cluster=args.cluster,
            attempt=args.attempt,
            success=args.success,
            model_used=args.model,
            time_s=args.time,
            diff_score=args.score,
            task_id=args.task_id,
        )
        print(f"Recorded: cluster={args.cluster} attempt={args.attempt} success={args.success}")

    elif args.cmd == "recommend":
        rec = get_routing_recommendation(args.cluster)
        print(json.dumps(rec, indent=2))

    elif args.cmd == "report":
        records = _load_log()
        if not records:
            print("No data yet — run fix-pipeline.py with --record-meta to populate")
            return
        routing = build_routing(records)
        print(f"{'Cluster':<18} {'N':>4} {'Eff':>6} {'SR':>5} {'AvgAtt':>7} {'AvgT':>7}  {'Model → Recommend'}")
        print("─" * 80)
        for cluster, r in sorted(routing.items(), key=lambda x: x[1]["efficiency"]):
            arrow = f"{r['best_model']} → {r['recommended_model']}" if r["upgraded"] else r["best_model"]
            print(f"{cluster:<18} {r['n']:>4} {r['efficiency']:>6.3f} {r['success_rate']:>5.2f} "
                  f"{r['avg_attempts']:>7.1f} {r['avg_time_s']:>7.1f}s  {arrow}")

    elif args.cmd == "weights":
        records = _load_log()
        weights = compute_training_weights(records)
        out = json.dumps(weights, indent=2)
        if args.output:
            Path(args.output).write_text(out, encoding="utf-8")
            print(f"Weights written to {args.output}")
        else:
            print(out)


if __name__ == "__main__":
    main()
