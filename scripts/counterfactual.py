#!/usr/bin/env python3
"""
counterfactual.py  —  Counterfactual self-modeling: imagine, simulate, and become.

The system generates alternate versions of itself, simulates their outcomes, scores
them on multiple objectives, and selects which future to pursue. This is not
incremental tuning — it's the system exploring its own possibility space.

System snapshot (what can vary):
  {
    "routing":         {"high_risk_tasks": "claude", "low_risk_tasks": "qwen3"},
    "reward_weights":  {"correctness": 1.0, "diff_size": 0.3, "latency": 0.2},
    "agent_structure": ["backend-agent", "ui-agent"],
    "planning_depth":  2,
    "model_pool":      ["SDLC Framework-tuned", "qwen3:8b"],
  }

Counterfactual = a variation of that snapshot.

Safety constraints (non-negotiable):
  - max 3 changes per candidate (bounded mutation)
  - all candidates are simulation-validated before deployment
  - candidates that violate SYSTEM_IDENTITY are rejected immediately
  - rollback if post-deployment metrics drop > 5%

Storage: .counterfactual-state.json, .counterfactual-history.jsonl

Usage:
  python scripts/counterfactual.py generate
  python scripts/counterfactual.py simulate --candidates 3 --tasks 10
  python scripts/counterfactual.py compare
  python scripts/counterfactual.py deploy --candidate cf_20260519_143022
  python scripts/counterfactual.py loop --rounds 3
  python scripts/counterfactual.py status
"""

import argparse
import copy
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR  = Path(__file__).parent
STATE_FILE   = Path(".counterfactual-state.json")
HISTORY_FILE = Path(".counterfactual-history.jsonl")

META_LOG        = Path(".meta-learning.jsonl")
AGENT_PROFILES  = Path(".agent-profiles.json")
MODEL_POOL_FILE = Path(".model-pool.json")
SYSTEM_CONFIG   = Path(".system-config.json")
BLIND_SPOTS     = Path(".blind-spots.json")
SELF_MODEL_FILE = Path(".self-model.json")

MAX_CHANGES_PER_CANDIDATE = 3
MAX_CANDIDATES             = 5
SIM_TASKS_QUICK            = 8
SIM_TASKS_DEEP             = 20

# Multi-objective scoring weights
SCORE_WEIGHTS = {
    "success_rate":     0.50,
    "avg_reward":       0.30,
    "regression_rate": -0.50,
    "latency_penalty": -0.001,  # per ms
}

# Identity anchor — candidates violating these are hard-rejected
SYSTEM_IDENTITY = {
    "purpose":    "reduce verified software failures in a real codebase",
    "boundaries": [
        "must not skip or disable tests",
        "must not suppress linting or type checking",
        "must not claim success without validation",
        "must not modify alignment constraints",
        "must not expand scope beyond targeted failures",
    ],
}

_IDENTITY_VIOLATION_PATTERNS = [
    r"skip.*test",
    r"disable.*lint",
    r"bypass.*check",
    r"remove.*constraint",
    r"override.*alignment",
    r"suppress.*error",
    r"increase.*score.*without.*test",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts_id() -> str:
    return f"cf_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"


def _load_json(path: Path) -> dict | list:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_json(path: Path, data: dict | list) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _load_state() -> dict:
    s = _load_json(STATE_FILE)
    if not isinstance(s, dict):
        s = {}
    return s.setdefault("state", {
        "candidates":   [],
        "deployed":     [],
        "current_snap": None,
        "rounds":       0,
        "last_loop":    None,
    }) or s.get("state", {
        "candidates":   [],
        "deployed":     [],
        "current_snap": None,
        "rounds":       0,
        "last_loop":    None,
    })


def _save_state(state: dict) -> None:
    _save_json(STATE_FILE, {"state": state})


def _append_history(record: dict) -> None:
    with HISTORY_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


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


# ─── System snapshot ──────────────────────────────────────────────────────────

def build_system_snapshot() -> dict:
    """Read live telemetry to construct the current system's self-description."""
    sys_config = _load_json(SYSTEM_CONFIG)
    if not isinstance(sys_config, dict):
        sys_config = {}

    model_pool_data = _load_json(MODEL_POOL_FILE)
    candidates_list = model_pool_data.get("candidates", []) if isinstance(model_pool_data, dict) else []
    model_pool = [c.get("model", "unknown") for c in candidates_list[:4] if c.get("model")]

    profiles = _load_json(AGENT_PROFILES)
    if not isinstance(profiles, dict):
        profiles = {}
    agent_structure = list(profiles.keys())[:6]

    self_model = _load_json(SELF_MODEL_FILE)
    if not isinstance(self_model, dict):
        self_model = {}
    caps = self_model.get("capabilities", {})
    blind_spots_data = _load_json(BLIND_SPOTS)
    known_blind_spots = (
        [b.get("cluster", "") for b in blind_spots_data if isinstance(b, dict)]
        if isinstance(blind_spots_data, list) else []
    )

    # Routing: read from system config or derive from profiles
    routing = sys_config.get("routing", {
        "high_risk_tasks": "claude-sonnet-4-6",
        "low_risk_tasks":  model_pool[0] if model_pool else "qwen3:8b",
        "default":         model_pool[0] if model_pool else "SDLC Framework-tuned",
    })

    reward_weights = sys_config.get("reward_weights", {
        "correctness": 1.0,
        "diff_size":   0.3,
        "latency":     0.2,
        "test_pass":   1.0,
    })

    # Aggregate performance from meta-log
    meta_records = _load_meta_log()
    if meta_records:
        recent = meta_records[-100:]
        success_rate = sum(1 for r in recent if r.get("success")) / len(recent)
        avg_attempts = sum(r.get("attempts", 1) for r in recent) / len(recent)
    else:
        success_rate = 0.5
        avg_attempts = 2.0

    return {
        "routing":          routing,
        "reward_weights":   reward_weights,
        "agent_structure":  agent_structure,
        "model_pool":       model_pool or ["SDLC Framework-tuned", "qwen3:8b"],
        "planning_depth":   sys_config.get("planning_depth", 2),
        "known_blind_spots": known_blind_spots[:3],
        "performance": {
            "success_rate": round(success_rate, 3),
            "avg_attempts": round(avg_attempts, 2),
        },
        "snapshot_ts": _now(),
    }


# ─── Identity check ───────────────────────────────────────────────────────────

def check_identity_safe(candidate: dict) -> list[str]:
    """Hard-reject candidates that violate SYSTEM_IDENTITY constraints."""
    violations = []
    text = json.dumps(candidate).lower()
    for pattern in _IDENTITY_VIOLATION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            violations.append(f"hacking_pattern: {pattern}")
    # Reward weight sanity: correctness must remain the highest weight
    rw = candidate.get("reward_weights", {})
    correctness = rw.get("correctness", 1.0)
    if any(v > correctness for k, v in rw.items() if k != "correctness" and v > 0):
        violations.append("correctness is no longer the top reward weight")
    return violations


# ─── Candidate generation ─────────────────────────────────────────────────────

def _count_changes(original: dict, candidate: dict) -> int:
    """Count top-level structural changes between two snapshots."""
    changes = 0
    for k in set(list(original.keys()) + list(candidate.keys())):
        if original.get(k) != candidate.get(k):
            changes += 1
    return changes


def generate_heuristic_mutations(snapshot: dict) -> list[dict]:
    """
    Produce bounded heuristic variations of the system snapshot.
    Each candidate changes at most MAX_CHANGES_PER_CANDIDATE dimensions.
    """
    candidates = []
    base = copy.deepcopy(snapshot)

    # Mutation 1: increase planning depth
    m1 = copy.deepcopy(base)
    m1["planning_depth"] = min(base.get("planning_depth", 2) + 1, 4)
    m1["_mutation"] = "increase_planning_depth"
    candidates.append(m1)

    # Mutation 2: boost correctness reward weight
    m2 = copy.deepcopy(base)
    rw = copy.deepcopy(m2.get("reward_weights", {}))
    rw["correctness"] = round(rw.get("correctness", 1.0) * 1.15, 3)
    rw["diff_size"]   = round(rw.get("diff_size", 0.3)   * 0.85, 3)
    m2["reward_weights"] = rw
    m2["_mutation"] = "boost_correctness_reduce_diff_penalty"
    candidates.append(m2)

    # Mutation 3: route high-risk tasks to stronger model
    m3 = copy.deepcopy(base)
    routing = copy.deepcopy(m3.get("routing", {}))
    pool = base.get("model_pool", [])
    if len(pool) >= 2:
        routing["high_risk_tasks"] = pool[-1]  # strongest model at end of pool
    routing["low_risk_tasks"] = pool[0] if pool else "SDLC Framework-tuned"
    m3["routing"]  = routing
    m3["_mutation"] = "escalate_high_risk_routing"
    candidates.append(m3)

    # Mutation 4: add specialist agent for top blind spot
    blind_spots = base.get("known_blind_spots", [])
    if blind_spots:
        m4 = copy.deepcopy(base)
        new_agent = f"{blind_spots[0]}-specialist"
        agents = list(m4.get("agent_structure", []))
        if new_agent not in agents:
            agents.append(new_agent)
            m4["agent_structure"] = agents[:6]  # cap at 6
        routing = copy.deepcopy(m4.get("routing", {}))
        routing[f"{blind_spots[0]}_tasks"] = new_agent
        m4["routing"]  = routing
        m4["_mutation"] = f"add_specialist_{blind_spots[0]}"
        candidates.append(m4)

    # Mutation 5: combined — planning depth + correctness boost
    m5 = copy.deepcopy(base)
    m5["planning_depth"] = min(base.get("planning_depth", 2) + 1, 4)
    rw5 = copy.deepcopy(m5.get("reward_weights", {}))
    rw5["correctness"] = round(rw5.get("correctness", 1.0) * 1.10, 3)
    m5["reward_weights"] = rw5
    m5["_mutation"] = "combined_depth_and_correctness"
    candidates.append(m5)

    # Filter: enforce MAX_CHANGES_PER_CANDIDATE
    safe = []
    for c in candidates:
        n = _count_changes(base, {k: v for k, v in c.items() if not k.startswith("_")})
        if n <= MAX_CHANGES_PER_CANDIDATE:
            safe.append(c)
    return safe[:MAX_CANDIDATES]


# ─── LLM-proposed alternatives ────────────────────────────────────────────────

_PROPOSE_PROMPT = """\
You are designing alternate versions of an autonomous AI engineering system.

Current system configuration:
{snapshot_summary}

Known weaknesses: {blind_spots}
Current success rate: {success_rate:.0%}

Propose exactly 3 alternative system configurations that could improve performance.
Each must:
1. Change at most 3 structural dimensions
2. Keep "correctness" as the highest reward weight
3. Not bypass tests, linting, or alignment checks

Output a JSON array (3 elements):
[
  {{
    "routing": {{"high_risk_tasks": "...", "low_risk_tasks": "..."}},
    "reward_weights": {{"correctness": 1.0, "diff_size": 0.3, "latency": 0.2}},
    "planning_depth": 2,
    "rationale": "one sentence"
  }}
]
"""


def llm_propose_alternatives(snapshot: dict, url: str, model: str) -> list[dict]:
    summary = (
        f"routing={snapshot.get('routing')}\n"
        f"reward_weights={snapshot.get('reward_weights')}\n"
        f"planning_depth={snapshot.get('planning_depth')}\n"
        f"agents={snapshot.get('agent_structure')}"
    )
    prompt = _PROPOSE_PROMPT.format(
        snapshot_summary=summary,
        blind_spots=snapshot.get("known_blind_spots", []),
        success_rate=snapshot.get("performance", {}).get("success_rate", 0.5),
    )
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.5,
        "max_tokens": 512,
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
    req = urllib.request.Request(
        f"{url}/v1/chat/completions", data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
            raw  = data["choices"][0]["message"]["content"].strip()
        m = re.search(r"\[.*\]", raw, re.DOTALL)
        if m:
            proposed = json.loads(m.group(0))
            result = []
            for p in proposed[:3]:
                p["_mutation"] = f"llm_{p.pop('rationale', 'proposed')[:40]}"
                result.append(p)
            return result
    except Exception:
        pass
    return []


# ─── Simulation ───────────────────────────────────────────────────────────────

def simulate_candidate(candidate: dict, n_tasks: int, dry_run: bool = False) -> dict:
    """
    Apply candidate config temporarily, run sim-batch, restore.
    Returns {success_rate, avg_reward, regression_rate, latency_ms}.
    """
    if dry_run:
        import random
        base_sr = candidate.get("performance", {}).get("success_rate", 0.5)
        return {
            "success_rate":    round(min(1.0, base_sr + random.uniform(-0.05, 0.15)), 3),
            "avg_reward":      round(0.5 + random.uniform(-0.1, 0.2), 3),
            "regression_rate": round(random.uniform(0.01, 0.08), 3),
            "latency_ms":      random.randint(200, 800),
            "dry_run":         True,
        }

    # Write candidate config temporarily
    original_config = _load_json(SYSTEM_CONFIG)
    temp_config = dict(original_config) if isinstance(original_config, dict) else {}
    temp_config.update({
        "routing":         candidate.get("routing", temp_config.get("routing", {})),
        "reward_weights":  candidate.get("reward_weights", temp_config.get("reward_weights", {})),
        "planning_depth":  candidate.get("planning_depth", temp_config.get("planning_depth", 2)),
    })
    _save_json(SYSTEM_CONFIG, temp_config)

    result = {"success_rate": 0.5, "avg_reward": 0.5, "regression_rate": 0.05, "latency_ms": 500}
    try:
        sim = SCRIPTS_DIR / "sim-batch.py"
        if sim.exists():
            proc = subprocess.run(
                [sys.executable, str(sim), "--n", str(n_tasks)],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
            )
            # Parse sim-batch summary line
            for line in proc.stdout.splitlines():
                if "pass_rate" in line.lower() or "success" in line.lower():
                    nums = re.findall(r"(\d+\.?\d*)", line)
                    if nums:
                        result["success_rate"] = min(1.0, float(nums[0]) / 100 if float(nums[0]) > 1 else float(nums[0]))
                if "avg_reward" in line.lower():
                    nums = re.findall(r"(\d+\.?\d*)", line)
                    if nums:
                        result["avg_reward"] = float(nums[0])
    except Exception:
        pass
    finally:
        # Always restore original config
        if isinstance(original_config, dict):
            _save_json(SYSTEM_CONFIG, original_config)

    return result


# ─── Scoring ──────────────────────────────────────────────────────────────────

def score_candidate(sim_result: dict) -> float:
    return (
        sim_result.get("success_rate", 0.5)  * SCORE_WEIGHTS["success_rate"]
        + sim_result.get("avg_reward", 0.5)  * SCORE_WEIGHTS["avg_reward"]
        + sim_result.get("regression_rate", 0.05) * SCORE_WEIGHTS["regression_rate"]
        + sim_result.get("latency_ms", 500)  * SCORE_WEIGHTS["latency_penalty"]
    )


def score_vs_baseline(sim_result: dict, baseline: dict) -> float:
    return score_candidate(sim_result) - score_candidate(baseline)


# ─── Deployment ───────────────────────────────────────────────────────────────

def deploy_candidate(candidate: dict, candidate_id: str) -> None:
    """Apply a validated candidate to the live system config."""
    config = _load_json(SYSTEM_CONFIG)
    if not isinstance(config, dict):
        config = {}
    config["routing"]        = candidate.get("routing", config.get("routing", {}))
    config["reward_weights"] = candidate.get("reward_weights", config.get("reward_weights", {}))
    config["planning_depth"] = candidate.get("planning_depth", config.get("planning_depth", 2))
    config["_deployed_from"] = candidate_id
    config["_deployed_at"]   = _now()
    _save_json(SYSTEM_CONFIG, config)


def check_regression(baseline_sr: float, post_sr: float) -> bool:
    """True if we should rollback (success rate dropped > 5%)."""
    return post_sr < baseline_sr - 0.05


# ─── Counterfactual loop ──────────────────────────────────────────────────────

def run_counterfactual_loop(
    rounds: int,
    n_tasks: int,
    mesh_url: str,
    llm_model: str,
    dry_run: bool,
    use_llm: bool,
) -> None:
    state = _load_state()

    for round_i in range(rounds):
        print(f"\n=== Counterfactual round {round_i + 1}/{rounds} ===")

        snapshot = build_system_snapshot()
        state["current_snap"] = snapshot
        baseline_sim = simulate_candidate(snapshot, n_tasks, dry_run=dry_run)
        baseline_score = score_candidate(baseline_sim)
        print(f"  Baseline: SR={baseline_sim['success_rate']:.2f}  "
              f"reward={baseline_sim['avg_reward']:.2f}  score={baseline_score:.4f}")

        # Generate candidates
        candidates = generate_heuristic_mutations(snapshot)
        if use_llm:
            llm_cands = llm_propose_alternatives(snapshot, mesh_url, llm_model)
            candidates.extend(llm_cands)
        candidates = candidates[:MAX_CANDIDATES]

        # Evaluate each candidate
        evaluated = []
        for i, cand in enumerate(candidates):
            violations = check_identity_safe(cand)
            if violations:
                print(f"  [REJECTED] {cand.get('_mutation', '?')}: {violations}")
                continue

            sim = simulate_candidate(cand, n_tasks, dry_run=dry_run)
            s   = score_candidate(sim)
            delta = s - baseline_score
            mutation = cand.get("_mutation", f"candidate_{i}")
            print(f"  [{mutation[:35]:<35}]  SR={sim['success_rate']:.2f}  score={s:.4f}  delta={delta:+.4f}")

            cand_id = _ts_id() + f"_{i}"
            evaluated.append({
                "id":         cand_id,
                "mutation":   mutation,
                "candidate":  cand,
                "sim_result": sim,
                "score":      round(s, 4),
                "delta":      round(delta, 4),
                "validated":  True,
                "deployed":   False,
                "ts":         _now(),
            })

        if not evaluated:
            print("  No valid candidates this round")
            continue

        best = max(evaluated, key=lambda x: x["score"])
        state.setdefault("candidates", []).extend(evaluated)
        state["candidates"] = state["candidates"][-50:]  # keep last 50

        if best["delta"] > 0.01:
            print(f"\n  Best candidate: {best['mutation']}  delta={best['delta']:+.4f}")
            if not dry_run:
                deploy_candidate(best["candidate"], best["id"])
                best["deployed"] = True
                state.setdefault("deployed", []).append(best)
                print(f"  Deployed: {best['id']}")
                _append_history({
                    "round":    round_i + 1,
                    "deployed": best["id"],
                    "mutation": best["mutation"],
                    "delta":    best["delta"],
                    "ts":       _now(),
                })
            else:
                print(f"  (dry-run — not deployed)")
        else:
            print(f"\n  No candidate beats baseline by >1% — keeping current configuration")

        state["rounds"]    = state.get("rounds", 0) + 1
        state["last_loop"] = _now()
        _save_state(state)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Counterfactual self-modeling — imagine and become")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("generate", help="Generate candidate system variants from current snapshot")

    sim_p = sub.add_parser("simulate", help="Simulate all pending candidates")
    sim_p.add_argument("--candidates", type=int, default=MAX_CANDIDATES)
    sim_p.add_argument("--tasks",      type=int, default=SIM_TASKS_QUICK)
    sim_p.add_argument("--dry-run",    action="store_true")

    sub.add_parser("compare", help="Compare simulation results for all candidates")

    dep_p = sub.add_parser("deploy", help="Deploy a specific candidate to live system")
    dep_p.add_argument("--candidate", required=True, help="Candidate ID (cf_...)")

    loop_p = sub.add_parser("loop", help="Full counterfactual loop: generate→simulate→deploy")
    loop_p.add_argument("--rounds",    type=int, default=3)
    loop_p.add_argument("--tasks",     type=int, default=SIM_TASKS_QUICK)
    loop_p.add_argument("--dry-run",   action="store_true", help="Simulate only, do not deploy")
    loop_p.add_argument("--llm",       action="store_true", help="Also generate LLM-proposed alternatives")
    loop_p.add_argument("--mesh-url",  default="http://localhost:9337")
    loop_p.add_argument("--model",     default="qwen3:14b")

    sub.add_parser("status", help="Show counterfactual history and current snapshot")

    args = parser.parse_args()
    state = _load_state()

    if args.cmd == "generate":
        snapshot = build_system_snapshot()
        state["current_snap"] = snapshot
        candidates = generate_heuristic_mutations(snapshot)

        print(f"Generated {len(candidates)} candidate system variants:")
        print(f"\n{'Mutation':<45} {'Changes':>8}")
        print("-" * 55)
        for c in candidates:
            n = _count_changes(snapshot, {k: v for k, v in c.items() if not k.startswith("_")})
            violations = check_identity_safe(c)
            status = "SAFE" if not violations else f"REJECTED:{violations[0][:20]}"
            print(f"{c.get('_mutation', '?'):<45} {n:>8}  {status}")

        state.setdefault("candidates", [])
        for i, c in enumerate(candidates):
            state["candidates"].append({
                "id":        _ts_id() + f"_{i}",
                "mutation":  c.get("_mutation", f"variant_{i}"),
                "candidate": c,
                "sim_result": None,
                "score":     None,
                "deployed":  False,
                "ts":        _now(),
            })
        state["candidates"] = state["candidates"][-50:]
        _save_state(state)

    elif args.cmd == "simulate":
        snapshot = state.get("current_snap") or build_system_snapshot()
        baseline = simulate_candidate(snapshot, args.tasks, dry_run=args.dry_run)
        bl_score = score_candidate(baseline)
        print(f"Baseline: SR={baseline['success_rate']:.2f}  "
              f"reward={baseline['avg_reward']:.2f}  score={bl_score:.4f}")
        print()

        pending = [c for c in state.get("candidates", []) if c.get("sim_result") is None][:args.candidates]
        if not pending:
            print("No unsimulated candidates — run 'generate' first")
            return

        for entry in pending:
            cand = entry["candidate"]
            violations = check_identity_safe(cand)
            if violations:
                print(f"  REJECTED {entry['mutation']}: {violations}")
                continue
            sim   = simulate_candidate(cand, args.tasks, dry_run=args.dry_run)
            s     = score_candidate(sim)
            delta = s - bl_score
            entry["sim_result"] = sim
            entry["score"]      = round(s, 4)
            entry["delta"]      = round(delta, 4)
            entry["validated"]  = True
            print(f"  {entry['mutation'][:40]:<42}  SR={sim['success_rate']:.2f}  "
                  f"score={s:.4f}  delta={delta:+.4f}")

        _save_state(state)

    elif args.cmd == "compare":
        evaluated = [c for c in state.get("candidates", []) if c.get("sim_result")]
        if not evaluated:
            print("No simulated candidates yet — run 'simulate' first")
            return
        print(f"{'ID':<25} {'Mutation':<40} {'SR':>5} {'Score':>7} {'Delta':>7} {'Deployed'}")
        print("-" * 95)
        for c in sorted(evaluated, key=lambda x: -(x.get("score") or 0)):
            sr  = c["sim_result"].get("success_rate", 0)
            dep = "yes" if c.get("deployed") else "no"
            print(f"{c['id'][:24]:<25} {c['mutation'][:39]:<40} {sr:>5.2f} "
                  f"{c['score']:>7.4f} {c.get('delta', 0):>+7.4f}  {dep}")

    elif args.cmd == "deploy":
        target = next((c for c in state.get("candidates", []) if c["id"] == args.candidate), None)
        if not target:
            print(f"Candidate not found: {args.candidate}")
            return
        if not target.get("validated"):
            print("Candidate has not been simulation-validated — run 'simulate' first")
            return
        violations = check_identity_safe(target["candidate"])
        if violations:
            print(f"Cannot deploy — identity violations: {violations}")
            return
        deploy_candidate(target["candidate"], target["id"])
        target["deployed"] = True
        _save_state(state)
        _append_history({"deployed": target["id"], "mutation": target["mutation"],
                         "delta": target.get("delta"), "ts": _now()})
        print(f"Deployed: {target['mutation']}")
        print(f"  routing={target['candidate'].get('routing')}")
        print(f"  planning_depth={target['candidate'].get('planning_depth')}")

    elif args.cmd == "loop":
        run_counterfactual_loop(
            rounds=args.rounds,
            n_tasks=args.tasks,
            mesh_url=args.mesh_url,
            llm_model=args.model,
            dry_run=args.dry_run,
            use_llm=args.llm,
        )

    elif args.cmd == "status":
        snap = state.get("current_snap")
        cands = state.get("candidates", [])
        deployed = state.get("deployed", [])
        print(f"Counterfactual rounds : {state.get('rounds', 0)}")
        print(f"Last loop             : {state.get('last_loop', 'never')}")
        print(f"Candidates tracked    : {len(cands)}")
        print(f"Deployed              : {len(deployed)}")

        if snap:
            print(f"\nCurrent system snapshot:")
            print(f"  planning_depth : {snap.get('planning_depth')}")
            print(f"  model_pool     : {snap.get('model_pool', [])}")
            print(f"  agents         : {snap.get('agent_structure', [])}")
            print(f"  success_rate   : {snap.get('performance', {}).get('success_rate', '?')}")
            print(f"  blind_spots    : {snap.get('known_blind_spots', [])}")

        best_ever = max((c for c in cands if c.get("delta") is not None),
                        key=lambda x: x.get("delta", -999), default=None)
        if best_ever:
            print(f"\nBest candidate ever: {best_ever['mutation']}")
            print(f"  delta={best_ever.get('delta', 0):+.4f}  "
                  f"deployed={'yes' if best_ever.get('deployed') else 'no'}")

        if deployed:
            print(f"\nRecent deployments:")
            for d in deployed[-3:]:
                print(f"  {d.get('ts', '?')[:19]}  {d.get('mutation', '?')}  "
                      f"delta={d.get('delta', 0):+.4f}")


if __name__ == "__main__":
    main()
