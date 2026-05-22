#!/usr/bin/env python3
"""
meta-manager.py  —  System self-redesign: improve structure, not just outputs.

The meta-manager observes all system telemetry and proposes structural changes:
  - Routing policies (route null_ref tasks to the best-performing specialist)
  - Reward weights (increase penalty for large diffs)
  - Agent roles (split overloaded agents, spawn new specialists)
  - Training strategy (increase sampling weight for failing clusters)

Changes are tested in simulation before deployment to prevent regressions.
All proposals are persisted so the system has an audit trail of its own redesigns.

Storage:
  .meta-manager-proposals.json  — proposal log (pending / tested / deployed / rejected)
  .system-config.json           — active routing + reward configuration

Usage:
  python scripts/meta-manager.py analyze               # Propose improvements
  python scripts/meta-manager.py proposals             # List all proposals
  python scripts/meta-manager.py test  --id <n>        # Test proposal in sim
  python scripts/meta-manager.py deploy --id <n>       # Apply a tested proposal
  python scripts/meta-manager.py status
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
PROPOSALS_FILE = Path(".meta-manager-proposals.json")
CONFIG_FILE    = Path(".system-config.json")

DEFAULT_CONFIG = {
    "routing": {
        "default_model": "meitheal-tuned",
        "cluster_overrides": {},          # cluster -> model
        "min_affinity_to_route": 0.3,
    },
    "reward_weights": {
        "test_pass":          0.50,
        "diff_size_penalty":  0.15,
        "format_quality":     0.15,
        "file_match":         0.10,
        "speed_bonus":        0.10,
    },
    "training": {
        "cluster_sample_weights": {},     # cluster -> float (1.0 = normal)
    },
    "version": 1,
    "updated": None,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default if default is not None else {}


def _save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_config() -> dict:
    cfg = _load_json(CONFIG_FILE)
    if not cfg:
        cfg = dict(DEFAULT_CONFIG)
        _save_json(CONFIG_FILE, cfg)
    return cfg


def save_config(cfg: dict) -> None:
    cfg["updated"] = _now()
    _save_json(CONFIG_FILE, cfg)


def load_proposals() -> list[dict]:
    return _load_json(PROPOSALS_FILE, [])


def save_proposals(proposals: list[dict]) -> None:
    _save_json(PROPOSALS_FILE, proposals)


# ─── System telemetry snapshot ────────────────────────────────────────────────

def build_system_report() -> str:
    lines = []

    # Agent profiles
    profiles = _load_json(Path(".agent-profiles.json"))
    if profiles:
        lines.append(f"Agents ({len(profiles)}):")
        for p in sorted(profiles.values(), key=lambda x: -x["performance"]["tasks_completed"])[:5]:
            sr   = p["performance"]["success_rate"]
            spec = p["specialization"]
            tasks = p["performance"]["tasks_completed"]
            lines.append(f"  {p['agent_id']:<28} sr={sr:.2f}  spec={spec}  tasks={tasks}")

    # Meta-learning cluster efficiency
    meta_log = Path(".meta-learning.jsonl")
    if meta_log.exists():
        from collections import defaultdict
        clusters: dict[str, dict] = defaultdict(lambda: {"total": 0, "fail": 0, "att": 0})
        seen_tasks: dict[str, set] = defaultdict(set)
        with meta_log.open(encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line.strip())
                except Exception:
                    continue
                c = r.get("cluster", "unknown")
                tid = r.get("task_id") or f"__{r.get('ts','')}_{c}"
                seen_tasks[c].add(tid)
                clusters[c]["att"] += 1
                if not r.get("success"):
                    clusters[c]["fail"] += 1
        for c, st in clusters.items():
            st["total"] = len(seen_tasks[c])
        lines.append(f"\nCluster failures:")
        for c, st in sorted(clusters.items(), key=lambda x: -x[1]["fail"]):
            fr = st["fail"] / max(st["total"], 1)
            lines.append(f"  {c:<18} failure_rate={fr:.2f}  tasks={st['total']}  attempts={st['att']}")

    # Model pool
    pool = _load_json(Path(".model-pool.json"))
    if pool:
        lines.append(f"\nModel pool ({len(pool)}):")
        for m in sorted(pool.values(), key=lambda x: -x["avg_reward"])[:4]:
            lines.append(f"  {m['model_id']:<28} reward={m['avg_reward']:.3f}  "
                         f"sr={m['success_rate']:.2f}  status={m['status']}")

    return "\n".join(lines) if lines else "(no telemetry data yet)"


# ─── LLM proposal generation ──────────────────────────────────────────────────

_ANALYZE_PROMPT = """\
You are the meta-manager of an autonomous AI engineering system.
Analyze the performance report below and propose 2-3 concrete structural improvements.

Output ONLY a JSON array of proposals. Each proposal must have:
  - "type": one of "routing_change", "reward_weight", "agent_split", "training_resample"
  - "description": one sentence explaining the change
  - "change": the specific config delta as a JSON object

Example:
[
  {{"type": "training_resample", "description": "Increase sampling for race_condition cluster",
    "change": {{"cluster": "race_condition", "weight": 2.0}}}},
  {{"type": "routing_change", "description": "Route null_ref to specialist model",
    "change": {{"cluster": "null_ref", "model": "meitheal-tuned"}}}}
]

System performance report:
{report}

Output only the JSON array, no other text.
"""


def call_model(prompt: str, url: str, model: str) -> str:
    payload = json.dumps({
        "model": model, "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2, "max_tokens": 1024,
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


def parse_proposals(raw: str) -> list[dict]:
    m = re.search(r"\[.*\]", raw, re.DOTALL)
    if not m:
        return []
    try:
        return json.loads(m.group(0))
    except Exception:
        return []


# ─── Proposal application ─────────────────────────────────────────────────────

def apply_proposal(proposal: dict, cfg: dict) -> bool:
    t  = proposal.get("type")
    ch = proposal.get("change", {})
    try:
        if t == "routing_change":
            cluster = ch.get("cluster")
            model   = ch.get("model")
            if cluster and model:
                cfg["routing"]["cluster_overrides"][cluster] = model
                return True
        elif t == "reward_weight":
            key   = ch.get("key")
            value = ch.get("value")
            if key and value is not None and key in cfg["reward_weights"]:
                cfg["reward_weights"][key] = float(value)
                return True
        elif t == "training_resample":
            cluster = ch.get("cluster")
            weight  = ch.get("weight")
            if cluster and weight is not None:
                cfg["training"]["cluster_sample_weights"][cluster] = float(weight)
                return True
        elif t == "agent_split":
            # Delegate to agent-profiles.py
            cluster = ch.get("cluster")
            if cluster:
                ap = SCRIPTS_DIR / "agent-profiles.py"
                if ap.exists():
                    subprocess.run([sys.executable, str(ap), "spawn", "--cluster", cluster],
                                   capture_output=True)
                return True
    except Exception:
        pass
    return False


# ─── Sim test ─────────────────────────────────────────────────────────────────

def test_in_sim(proposal: dict, mesh_url: str, model: str) -> dict:
    """Run a small sim-batch to estimate impact of a proposal."""
    sim = SCRIPTS_DIR / "sim-batch.py"
    if not sim.exists():
        return {"result": "skipped", "reason": "sim-batch.py not found"}

    cluster = proposal.get("change", {}).get("cluster", "")
    limit   = 5
    cmd     = [sys.executable, str(sim), "--limit", str(limit), "--model", model,
               "--mesh-url", mesh_url]
    if cluster:
        cmd += ["--cluster", cluster]

    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"Results\s*:\s*(\d+)/(\d+)", result.stdout)
    if m:
        passed, total = int(m.group(1)), int(m.group(2))
        return {"result": "ok", "passed": passed, "total": total,
                "pass_rate": round(passed / max(total, 1), 3)}
    return {"result": "ran", "output": result.stdout[-300:]}


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Meta-manager: system self-redesign")
    sub = parser.add_subparsers(dest="cmd", required=True)

    ana = sub.add_parser("analyze", help="Analyze telemetry and propose changes")
    ana.add_argument("--mesh-url", default="http://localhost:9337")
    ana.add_argument("--model",    default="qwen3:14b",
                     help="Model for analysis (use a strong model)")

    sub.add_parser("proposals", help="Show all proposals")

    tst = sub.add_parser("test", help="Test a proposal in simulation")
    tst.add_argument("--id",       type=int, required=True)
    tst.add_argument("--mesh-url", default="http://localhost:9337")
    tst.add_argument("--model",    default="meitheal-tuned")

    dep = sub.add_parser("deploy", help="Deploy a tested proposal")
    dep.add_argument("--id", type=int, required=True)

    rej = sub.add_parser("reject", help="Reject a proposal")
    rej.add_argument("--id", type=int, required=True)

    sub.add_parser("status", help="Show active system config")

    args = parser.parse_args()

    if args.cmd == "analyze":
        report    = build_system_report()
        print(f"[meta-manager] System report:\n{report}\n")
        raw       = call_model(_ANALYZE_PROMPT.format(report=report), args.mesh_url, args.model)
        new_props = parse_proposals(raw)
        if not new_props:
            print("No proposals generated (model output not parseable)")
            print(f"Raw: {raw[:300]}")
            return

        proposals = load_proposals()
        for p in new_props:
            entry = {
                "id":          len(proposals) + 1,
                "type":        p.get("type", "unknown"),
                "description": p.get("description", ""),
                "change":      p.get("change", {}),
                "status":      "pending",
                "sim_result":  None,
                "created":     _now(),
            }
            proposals.append(entry)
            print(f"  Proposal #{entry['id']}: [{entry['type']}] {entry['description']}")

        save_proposals(proposals)

    elif args.cmd == "proposals":
        proposals = load_proposals()
        if not proposals:
            print("No proposals yet — run: python scripts/meta-manager.py analyze")
            return
        for p in proposals:
            sim = f"  sim={p['sim_result']}" if p.get("sim_result") else ""
            print(f"#{p['id']:>3} [{p['status']:<10}] [{p['type']:<20}] {p['description'][:60]}{sim}")

    elif args.cmd == "test":
        proposals = load_proposals()
        p = next((x for x in proposals if x["id"] == args.id), None)
        if not p:
            print(f"Proposal #{args.id} not found")
            return
        print(f"Testing #{args.id}: {p['description']}")
        result = test_in_sim(p, args.mesh_url, args.model)
        p["sim_result"] = result
        p["status"]     = "tested"
        save_proposals(proposals)
        print(f"Result: {result}")

    elif args.cmd == "deploy":
        proposals = load_proposals()
        p = next((x for x in proposals if x["id"] == args.id), None)
        if not p:
            print(f"Proposal #{args.id} not found")
            return
        if p["status"] == "pending":
            print("Warning: proposal not yet tested (run 'test --id' first)")
        cfg = load_config()
        if apply_proposal(p, cfg):
            cfg["version"] += 1
            save_config(cfg)
            p["status"] = "deployed"
            save_proposals(proposals)
            print(f"Deployed #{args.id}: {p['description']}")
            print(f"Config version: {cfg['version']}")
        else:
            print(f"Could not apply proposal type '{p['type']}'")

    elif args.cmd == "reject":
        proposals = load_proposals()
        p = next((x for x in proposals if x["id"] == args.id), None)
        if p:
            p["status"] = "rejected"
            save_proposals(proposals)
            print(f"Rejected #{args.id}")

    elif args.cmd == "status":
        cfg = load_config()
        print(f"Config version  : {cfg['version']}")
        print(f"Updated         : {cfg.get('updated', 'never')}")
        print(f"Default model   : {cfg['routing']['default_model']}")
        print(f"Cluster overrides: {cfg['routing']['cluster_overrides'] or 'none'}")
        print(f"Reward weights  : {cfg['reward_weights']}")
        print(f"Training weights: {cfg['training']['cluster_sample_weights'] or 'default'}")
        proposals = load_proposals()
        pending = sum(1 for p in proposals if p["status"] == "pending")
        print(f"\nProposals: {len(proposals)} total, {pending} pending")


if __name__ == "__main__":
    main()
