#!/usr/bin/env python3
"""
self-awareness.py  —  Detect system blind spots: confidence gaps and systematic failures.

The system tracks predicted confidence vs actual success per cluster. A large
gap means the model is overconfident in areas where it fails — these are blind spots.

Blind spot detection triggers automatic remediation:
  - Increase training weight for the cluster (meta-manager + trainer-service)
  - Route future tasks to a stronger model
  - Generate targeted improvement tasks via goal-engine

Metric schema (per event):
  {
    "cluster":    "null_ref",
    "predicted":  0.82,         # score from score-diff.py or model introspection
    "actual":     0,            # 1 = success, 0 = failure
    "attempts":   1,
    "model":      "SDLC Framework-tuned",
    "ts":         "2026-05-19T..."
  }

Storage: .self-awareness.jsonl (append-only), .blind-spots.json (derived report)

Usage:
  python scripts/self-awareness.py record \\
      --cluster null_ref --predicted 0.8 --success true --model SDLC Framework-tuned
  python scripts/self-awareness.py report
  python scripts/self-awareness.py blind-spots
  python scripts/self-awareness.py remediate
"""

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR    = Path(__file__).parent
LOG_FILE       = Path(".self-awareness.jsonl")
REPORT_FILE    = Path(".blind-spots.json")

GAP_THRESHOLD      = 0.20   # confidence - actual_sr gap that flags a blind spot
FAILURE_THRESHOLD  = 0.30   # raw failure rate threshold
RECOVERY_THRESHOLD = 3.0    # avg attempts to flag as "hard"

MODEL_LADDER = [
    "SDLC Framework-tuned",
    "qwen3:8b",
    "qwen3:14b",
    "deepseek/deepseek-chat",
    "anthropic/claude-sonnet-4-6",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
                except Exception:
                    pass
    return records


def _save_report(report: dict) -> None:
    REPORT_FILE.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")


# ─── Analysis ─────────────────────────────────────────────────────────────────

def analyze(records: list[dict]) -> dict[str, dict]:
    """Per-cluster metrics: confidence, actual SR, gap, recovery difficulty."""
    clusters: dict[str, dict] = defaultdict(lambda: {
        "predictions": [], "actuals": [], "attempts": [], "models": []
    })

    for r in records:
        c = r.get("cluster", "unknown")
        clusters[c]["predictions"].append(float(r.get("predicted", 0.5)))
        clusters[c]["actuals"].append(int(r.get("actual", 0)))
        clusters[c]["attempts"].append(int(r.get("attempts", 1)))
        clusters[c]["models"].append(r.get("model", ""))

    report = {}
    for cluster, d in clusters.items():
        n             = len(d["actuals"])
        avg_predicted = sum(d["predictions"]) / n
        actual_sr     = sum(d["actuals"]) / n
        gap           = avg_predicted - actual_sr          # positive = overconfident
        avg_attempts  = sum(d["attempts"]) / n
        failure_rate  = 1.0 - actual_sr

        # Most common model
        from collections import Counter
        most_common_model = Counter(d["models"]).most_common(1)[0][0] if d["models"] else ""

        report[cluster] = {
            "n":                  n,
            "avg_predicted":      round(avg_predicted, 3),
            "actual_success_rate": round(actual_sr, 3),
            "confidence_gap":     round(gap, 3),
            "failure_rate":       round(failure_rate, 3),
            "avg_attempts":       round(avg_attempts, 2),
            "current_model":      most_common_model,
        }

    return report


def detect_blind_spots(report: dict[str, dict]) -> list[dict]:
    """Return clusters that are blind spots (overconfident + high failure rate)."""
    blind_spots = []
    for cluster, m in report.items():
        is_overconfident  = m["confidence_gap"] > GAP_THRESHOLD
        is_failing        = m["failure_rate"] > FAILURE_THRESHOLD
        is_hard           = m["avg_attempts"] > RECOVERY_THRESHOLD
        if is_overconfident or is_failing:
            blind_spots.append({
                "cluster":        cluster,
                "confidence_gap": m["confidence_gap"],
                "failure_rate":   m["failure_rate"],
                "avg_attempts":   m["avg_attempts"],
                "current_model":  m["current_model"],
                "reasons":        (
                    (["overconfident"] if is_overconfident else []) +
                    (["high_failure"]  if is_failing       else []) +
                    (["hard_to_fix"]   if is_hard          else [])
                ),
            })
    blind_spots.sort(key=lambda x: -(x["confidence_gap"] + x["failure_rate"]))
    return blind_spots


def suggest_stronger_model(current: str) -> str:
    idx = next((i for i, m in enumerate(MODEL_LADDER) if m == current), 0)
    return MODEL_LADDER[min(idx + 1, len(MODEL_LADDER) - 1)]


# ─── Remediation ──────────────────────────────────────────────────────────────

def remediate(blind_spots: list[dict], dry_run: bool = False) -> None:
    """
    For each blind spot:
      1. Increase training weight via meta-manager
      2. Add routing override to stronger model
      3. Generate targeted tasks via goal-engine
    """
    if not blind_spots:
        print("No blind spots detected — system is well-calibrated")
        return

    meta_config_path = Path(".system-config.json")
    cfg = {}
    if meta_config_path.exists():
        try:
            cfg = json.loads(meta_config_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    for bs in blind_spots:
        cluster   = bs["cluster"]
        new_model = suggest_stronger_model(bs["current_model"])
        weight    = round(min(2.0, 1.0 + bs["failure_rate"] + abs(bs["confidence_gap"])), 2)

        print(f"Blind spot: {cluster}")
        print(f"  gap={bs['confidence_gap']:+.3f}  failure_rate={bs['failure_rate']:.3f}  "
              f"attempts={bs['avg_attempts']:.1f}")
        print(f"  Action: route to {new_model}, training weight={weight}")
        print(f"  Reasons: {', '.join(bs['reasons'])}")

        if not dry_run:
            # Update routing in system config
            if cfg:
                cfg.setdefault("routing", {}).setdefault("cluster_overrides", {})[cluster] = new_model
                cfg.setdefault("training", {}).setdefault("cluster_sample_weights", {})[cluster] = weight

            # Generate improvement tasks via goal-engine (if available)
            ge = SCRIPTS_DIR / "goal-engine.py"
            if ge.exists():
                subprocess.run(
                    [sys.executable, str(ge), "generate", "--top-k", "2"],
                    capture_output=True,
                )

        print()

    if not dry_run and cfg:
        meta_config_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Updated system config: {meta_config_path}")


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Self-awareness: blind spot detection")
    sub = parser.add_subparsers(dest="cmd", required=True)

    rec = sub.add_parser("record", help="Record a prediction vs actual outcome")
    rec.add_argument("--cluster",   required=True)
    rec.add_argument("--predicted", type=float, required=True, help="Predicted confidence (0-1)")
    rec.add_argument("--success",   type=lambda x: x.lower() == "true", required=True)
    rec.add_argument("--attempts",  type=int, default=1)
    rec.add_argument("--model",     default="SDLC Framework-tuned")

    sub.add_parser("report", help="Show per-cluster confidence calibration")

    sub.add_parser("blind-spots", help="List detected blind spots")

    rem = sub.add_parser("remediate", help="Apply remediation for blind spots")
    rem.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()
    records = _load_log()

    if args.cmd == "record":
        entry = {
            "cluster":   args.cluster,
            "predicted": args.predicted,
            "actual":    int(args.success),
            "attempts":  args.attempts,
            "model":     args.model,
            "ts":        _now(),
        }
        _append(entry)
        gap = args.predicted - float(args.success)
        print(f"Recorded: cluster={args.cluster}  predicted={args.predicted:.2f}  "
              f"actual={int(args.success)}  gap={gap:+.2f}")

    elif args.cmd == "report":
        if not records:
            print("No data yet — use 'record' to add observations")
            return
        report = analyze(records)
        _save_report(report)
        print(f"{'Cluster':<18} {'N':>4} {'Pred':>6} {'Actual':>7} {'Gap':>6} {'FailRate':>9} {'Attempts':>9}")
        print("-" * 65)
        for cluster, m in sorted(report.items(), key=lambda x: -abs(x[1]["confidence_gap"])):
            gap_str = f"{m['confidence_gap']:+.3f}"
            print(f"{cluster:<18} {m['n']:>4} {m['avg_predicted']:>6.3f} "
                  f"{m['actual_success_rate']:>7.3f} {gap_str:>6} "
                  f"{m['failure_rate']:>9.3f} {m['avg_attempts']:>9.2f}")

    elif args.cmd == "blind-spots":
        if not records:
            print("No data yet")
            return
        report      = analyze(records)
        blind_spots = detect_blind_spots(report)
        _save_report({"clusters": report, "blind_spots": blind_spots})
        if not blind_spots:
            print("No blind spots detected")
            return
        print(f"Blind spots detected ({len(blind_spots)}):\n")
        for bs in blind_spots:
            print(f"  {bs['cluster']:<18} gap={bs['confidence_gap']:+.3f}  "
                  f"failure={bs['failure_rate']:.3f}  attempts={bs['avg_attempts']:.1f}  "
                  f"[{', '.join(bs['reasons'])}]")

    elif args.cmd == "remediate":
        report      = analyze(records)
        blind_spots = detect_blind_spots(report)
        remediate(blind_spots, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
