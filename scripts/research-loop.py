#!/usr/bin/env python3
"""
research-loop.py  —  System self-research: hypothesis → experiment → discovery.

The system proposes improvement hypotheses based on its own telemetry, designs
experiments (config variants), runs them in the simulation environment, and stores
confirmed discoveries as new system knowledge.

Hypothesis types:
  reward_weight_change  — e.g., "increase format_quality weight to 0.25"
  routing_policy        — e.g., "route null_ref to qwen3:14b"
  training_strategy     — e.g., "oversample timeout cluster (weight=2.0)"
  agent_structure       — e.g., "spawn dedicated race_condition specialist"

Discovery schema:
  {
    "id":          "disc_20260519_143022",
    "hypothesis":  "increasing AST weight improves correctness",
    "type":        "reward_weight_change",
    "change":      {"key": "format_quality", "value": 0.25},
    "baseline_sr": 0.72,
    "result_sr":   0.76,
    "delta":       +0.04,
    "confidence":  0.86,
    "status":      "pending" | "confirmed" | "adopted" | "rejected",
  }

Storage: .discoveries.jsonl, .research-state.json

Usage:
  python scripts/research-loop.py propose           # Generate hypotheses from telemetry
  python scripts/research-loop.py run    --limit 2  # Test pending hypotheses in sim
  python scripts/research-loop.py adopt  --id disc_20260519_143022
  python scripts/research-loop.py discoveries
  python scripts/research-loop.py status
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR    = Path(__file__).parent
DISC_FILE      = Path(".discoveries.jsonl")
STATE_FILE     = Path(".research-state.json")

MIN_DELTA_TO_CONFIRM = 0.01   # at least 1pp improvement to confirm a discovery
SIM_TASKS            = 10     # tasks to run per experiment


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts_id() -> str:
    return f"disc_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"


def _load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default if default is not None else {}


def _save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _append_disc(d: dict) -> None:
    with DISC_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(d, ensure_ascii=False) + "\n")


def _load_discoveries() -> list[dict]:
    if not DISC_FILE.exists():
        return []
    items = []
    with DISC_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    items.append(json.loads(line))
                except Exception:
                    pass
    return items


# ─── System metrics snapshot for hypothesis generation ────────────────────────

def _build_metrics_summary() -> str:
    lines = []

    # Failure clusters from meta-learning
    meta_log = Path(".meta-learning.jsonl")
    if meta_log.exists():
        from collections import defaultdict, Counter
        clusters: dict[str, dict] = defaultdict(lambda: {"total": 0, "fail": 0})
        tasks_seen: dict[str, set] = defaultdict(set)
        with meta_log.open(encoding="utf-8") as f:
            for ln in f:
                try:
                    r = json.loads(ln.strip())
                    c = r.get("cluster", "unknown")
                    tid = r.get("task_id") or f"__{r.get('ts','')}_{c}"
                    tasks_seen[c].add(tid)
                    if not r.get("success"):
                        clusters[c]["fail"] += 1
                except Exception:
                    pass
        for c, st in clusters.items():
            st["total"] = len(tasks_seen[c])
        lines.append("Cluster failure rates:")
        for c, st in sorted(clusters.items(), key=lambda x: -x[1]["fail"]):
            fr = st["fail"] / max(st["total"], 1)
            lines.append(f"  {c:<18} failure_rate={fr:.2f}  tasks={st['total']}")

    # Blind spots
    blind_spots = _load_json(Path(".blind-spots.json"))
    if blind_spots and isinstance(blind_spots, dict):
        bs = blind_spots.get("blind_spots", [])
        if bs:
            lines.append(f"\nBlind spots ({len(bs)}):")
            for b in bs[:3]:
                lines.append(f"  {b['cluster']}: gap={b['confidence_gap']:+.2f}  "
                             f"failure={b['failure_rate']:.2f}")

    # Model performance
    pool = _load_json(Path(".model-pool.json"))
    if pool:
        lines.append(f"\nModel rewards:")
        for m in sorted(pool.values(), key=lambda x: -x["avg_reward"])[:3]:
            lines.append(f"  {m['model_id']:<28} reward={m['avg_reward']:.3f}")

    # Current reward weights
    cfg = _load_json(Path(".system-config.json"))
    if cfg.get("reward_weights"):
        lines.append(f"\nCurrent reward weights: {cfg['reward_weights']}")

    return "\n".join(lines) if lines else "(no telemetry yet)"


# ─── Hypothesis generation ────────────────────────────────────────────────────

_PROPOSE_PROMPT = """\
You are a research agent for an autonomous AI engineering system.
Based on the system performance metrics below, propose 2-3 improvement hypotheses.

Each hypothesis must be specific and testable in a simulation.
Output ONLY a JSON array of hypotheses:
[
  {{
    "hypothesis": "one sentence description",
    "type": "reward_weight_change" | "routing_policy" | "training_strategy" | "agent_structure",
    "rationale": "why this should help",
    "change": {{...specific config change...}}
  }}
]

For reward_weight_change: change = {{"key": "...", "value": 0.XX}}
For routing_policy: change = {{"cluster": "...", "model": "..."}}
For training_strategy: change = {{"cluster": "...", "weight": 2.0}}
For agent_structure: change = {{"action": "spawn", "cluster": "..."}}

System metrics:
{metrics}

Output only the JSON array.
"""


def call_model(prompt: str, url: str, model: str) -> str:
    payload = json.dumps({
        "model": model, "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3, "max_tokens": 1024,
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
    req = urllib.request.Request(
        f"{url}/v1/chat/completions", data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"[LLM ERROR: {e}]"


def propose_hypotheses(metrics: str, url: str, model: str) -> list[dict]:
    raw = call_model(_PROPOSE_PROMPT.format(metrics=metrics), url, model)
    m   = re.search(r"\[.*\]", raw, re.DOTALL)
    if not m:
        return []
    try:
        return json.loads(m.group(0))
    except Exception:
        return []


# ─── Baseline measurement ─────────────────────────────────────────────────────

def measure_baseline(mesh_url: str, model: str) -> float:
    """Run a small sim-batch to get current pass rate as baseline."""
    sim = SCRIPTS_DIR / "sim-batch.py"
    if not sim.exists():
        return 0.5  # assume 50% if can't measure
    result = subprocess.run(
        [sys.executable, str(sim), "--limit", str(SIM_TASKS),
         "--model", model, "--mesh-url", mesh_url],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"Results\s*:\s*(\d+)/(\d+)", result.stdout)
    if m:
        return int(m.group(1)) / max(int(m.group(2)), 1)
    return 0.5


# ─── Experiment execution ─────────────────────────────────────────────────────

def run_experiment(
    hypothesis: dict,
    baseline_sr: float,
    mesh_url: str,
    model: str,
) -> dict:
    """
    Apply config change temporarily, run sim, compare to baseline, restore.
    """
    change = hypothesis.get("change", {})
    h_type = hypothesis.get("type", "")

    # Apply change to system config temporarily
    cfg_path = Path(".system-config.json")
    cfg      = _load_json(cfg_path)
    original = json.dumps(cfg, indent=2)  # backup

    applied = False
    try:
        if h_type == "reward_weight_change" and change.get("key"):
            key = change["key"]
            if key in cfg.get("reward_weights", {}):
                cfg["reward_weights"][key] = float(change["value"])
                _save_json(cfg_path, cfg)
                applied = True

        elif h_type == "routing_policy" and change.get("cluster"):
            cfg.setdefault("routing", {}).setdefault("cluster_overrides", {})[
                change["cluster"]] = change["model"]
            _save_json(cfg_path, cfg)
            applied = True

        elif h_type == "training_strategy" and change.get("cluster"):
            cfg.setdefault("training", {}).setdefault("cluster_sample_weights", {})[
                change["cluster"]] = float(change.get("weight", 2.0))
            _save_json(cfg_path, cfg)
            applied = True

        # Run sim with this config
        sim = SCRIPTS_DIR / "sim-batch.py"
        result = subprocess.run(
            [sys.executable, str(sim), "--limit", str(SIM_TASKS),
             "--model", model, "--mesh-url", mesh_url],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        m = re.search(r"Results\s*:\s*(\d+)/(\d+)", result.stdout)
        result_sr = float(m.group(1)) / max(int(m.group(2)), 1) if m else baseline_sr

    finally:
        # Restore original config
        cfg_path.write_text(original, encoding="utf-8")

    delta      = result_sr - baseline_sr
    confidence = min(0.95, 0.5 + abs(delta) * 5)  # crude: bigger delta = more confident
    confirmed  = delta >= MIN_DELTA_TO_CONFIRM

    return {
        "id":          _ts_id(),
        "hypothesis":  hypothesis.get("hypothesis", ""),
        "type":        h_type,
        "rationale":   hypothesis.get("rationale", ""),
        "change":      change,
        "baseline_sr": round(baseline_sr, 4),
        "result_sr":   round(result_sr, 4),
        "delta":       round(delta, 4),
        "confidence":  round(confidence, 3),
        "applied":     applied,
        "status":      "confirmed" if confirmed else "rejected",
        "created":     _now(),
    }


# ─── Discovery adoption ───────────────────────────────────────────────────────

def adopt_discovery(disc_id: str) -> bool:
    discoveries = _load_discoveries()
    target = next((d for d in discoveries if d["id"] == disc_id), None)
    if not target:
        return False
    if target["status"] != "confirmed":
        print(f"Discovery {disc_id} is not confirmed (status={target['status']})")
        return False

    # Apply via meta-manager
    mm = SCRIPTS_DIR / "meta-manager.py"
    if mm.exists():
        proposal = {
            "type":        target["type"],
            "description": target["hypothesis"],
            "change":      target["change"],
        }
        # Patch into meta-manager proposals and deploy
        proposals_path = Path(".meta-manager-proposals.json")
        proposals      = _load_json(proposals_path, [])
        entry = {
            "id":          len(proposals) + 1,
            "type":        target["type"],
            "description": target["hypothesis"],
            "change":      target["change"],
            "status":      "tested",
            "sim_result":  {"pass_rate": target["result_sr"]},
            "created":     _now(),
        }
        proposals.append(entry)
        _save_json(proposals_path, proposals)

        result = subprocess.run(
            [sys.executable, str(mm), "deploy", "--id", str(entry["id"])],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode == 0:
            target["status"] = "adopted"
            # Rewrite discoveries file (since it's append-only we just append an update)
            _append_disc({**target, "status": "adopted", "adopted_at": _now()})
            return True

    return False


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Self-research loop: hypothesis → experiment → discovery")
    sub = parser.add_subparsers(dest="cmd", required=True)

    prop = sub.add_parser("propose", help="Generate hypotheses from system metrics")
    prop.add_argument("--mesh-url", default="http://localhost:9337")
    prop.add_argument("--model",    default="qwen3:14b")
    prop.add_argument("--limit",    type=int, default=3)

    run_p = sub.add_parser("run", help="Test pending hypotheses in simulation")
    run_p.add_argument("--limit",    type=int, default=2, help="Hypotheses to test")
    run_p.add_argument("--mesh-url", default="http://localhost:9337")
    run_p.add_argument("--model",    default="meitheal-tuned")

    adp = sub.add_parser("adopt", help="Apply a confirmed discovery to the live system")
    adp.add_argument("--id", required=True)

    sub.add_parser("discoveries", help="Show all stored discoveries")
    sub.add_parser("status",      help="Show research state")

    args = parser.parse_args()

    if args.cmd == "propose":
        metrics     = _build_metrics_summary()
        print(f"[research] Metrics snapshot:\n{metrics}\n")
        hypotheses  = propose_hypotheses(metrics, args.mesh_url, args.model)
        if not hypotheses:
            print("No hypotheses generated (model output not parseable)")
            return
        state = _load_json(STATE_FILE, {"pending": [], "cycle": 0})
        for h in hypotheses[:args.limit]:
            state["pending"].append(h)
            print(f"  Hypothesis [{h['type']}]: {h['hypothesis']}")
        state["cycle"] += 1
        _save_json(STATE_FILE, state)
        print(f"\n{len(hypotheses)} hypotheses saved to research state")

    elif args.cmd == "run":
        state = _load_json(STATE_FILE, {"pending": [], "cycle": 0})
        pending = state.get("pending", [])
        if not pending:
            print("No pending hypotheses — run 'propose' first")
            return

        print(f"[research] Measuring baseline...")
        baseline = measure_baseline(args.mesh_url, args.model)
        print(f"  Baseline pass rate: {baseline:.3f}")

        tested   = []
        for h in pending[:args.limit]:
            print(f"\n[research] Testing: {h['hypothesis'][:70]}")
            disc = run_experiment(h, baseline, args.mesh_url, args.model)
            _append_disc(disc)
            tested.append(h)
            status_str = f"delta={disc['delta']:+.4f}  {disc['status']}"
            print(f"  Result: sr={disc['result_sr']:.3f}  {status_str}  id={disc['id']}")

        # Remove tested hypotheses from pending
        state["pending"] = [h for h in pending if h not in tested]
        _save_json(STATE_FILE, state)

    elif args.cmd == "adopt":
        ok = adopt_discovery(args.id)
        print(f"{'Adopted' if ok else 'Failed to adopt'}: {args.id}")

    elif args.cmd == "discoveries":
        discs = _load_discoveries()
        if not discs:
            print("No discoveries yet")
            return
        # Show most recent unique (by id)
        seen = set()
        unique = []
        for d in reversed(discs):
            if d["id"] not in seen:
                seen.add(d["id"])
                unique.append(d)
        unique.reverse()
        print(f"{'ID':<26} {'Type':<22} {'Delta':>7} {'Status':<12} Hypothesis")
        print("-" * 90)
        for d in unique[-20:]:
            print(f"{d['id']:<26} {d['type']:<22} {d['delta']:>+7.4f} {d['status']:<12} "
                  f"{d['hypothesis'][:40]}")

    elif args.cmd == "status":
        state = _load_json(STATE_FILE, {"pending": [], "cycle": 0})
        discs  = _load_discoveries()
        seen   = {d["id"] for d in discs}
        confirmed = sum(1 for d in discs if d.get("status") in ("confirmed", "adopted"))
        print(f"Research cycles  : {state.get('cycle', 0)}")
        print(f"Pending hypotheses: {len(state.get('pending', []))}")
        print(f"Total discoveries : {len(seen)}")
        print(f"Confirmed/adopted : {confirmed}")


if __name__ == "__main__":
    main()
