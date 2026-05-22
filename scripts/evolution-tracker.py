#!/usr/bin/env python3
"""
evolution-tracker.py  —  System self-versioning: track how the system evolves over time.

Snapshots the full system state at each significant change:
  - Active models and their performance
  - Routing configuration and overrides
  - Reward weights
  - Agent profiles summary
  - Aggregate success metrics

Tracks deltas between versions. Enables rollback if a new version underperforms.
Supports branching for experimental evolution (e.g., "infra-focus" vs "ui-focus").

Storage:
  system_versions/
    v1.json, v2.json, ...   — version snapshots
    evolution.jsonl          — delta log
    branches/                — named experimental branches

Usage:
  python scripts/evolution-tracker.py snapshot --label "added null_ref specialist"
  python scripts/evolution-tracker.py history
  python scripts/evolution-tracker.py diff v3 v4
  python scripts/evolution-tracker.py rollback --to v3
  python scripts/evolution-tracker.py branch --from v5 --name infra-focus
  python scripts/evolution-tracker.py merge --branch infra-focus
"""

import argparse
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

VERSIONS_DIR = Path("system_versions")
DELTA_LOG    = VERSIONS_DIR / "evolution.jsonl"
BRANCHES_DIR = VERSIONS_DIR / "branches"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_dirs() -> None:
    VERSIONS_DIR.mkdir(exist_ok=True)
    BRANCHES_DIR.mkdir(exist_ok=True)


def _load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default if default is not None else {}


def _save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _append_delta(entry: dict) -> None:
    _ensure_dirs()
    with DELTA_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ─── Version numbering ────────────────────────────────────────────────────────

def _next_version() -> str:
    _ensure_dirs()
    existing = [p for p in VERSIONS_DIR.glob("v*.json")]
    nums = []
    for p in existing:
        m = re.match(r"v(\d+)\.json$", p.name)
        if m:
            nums.append(int(m.group(1)))
    return f"v{max(nums, default=0) + 1}"


def _version_path(version: str) -> Path:
    return VERSIONS_DIR / f"{version}.json"


def list_versions() -> list[str]:
    _ensure_dirs()
    names = [p.stem for p in sorted(VERSIONS_DIR.glob("v*.json"),
                                    key=lambda p: int(re.sub(r'\D', '', p.stem) or '0'))]
    return names


# ─── Snapshot collection ──────────────────────────────────────────────────────

def _collect_state() -> dict:
    state: dict = {
        "models":          {},
        "routing":         {},
        "reward_weights":  {},
        "agents":          {},
        "economy":         {},
        "performance":     {},
    }

    # Model pool
    pool = _load_json(Path(".model-pool.json"))
    for m in pool.values():
        state["models"][m["model_id"]] = {
            "status":       m["status"],
            "avg_reward":   m.get("avg_reward", 0),
            "success_rate": m.get("success_rate", 0),
            "tasks":        m.get("tasks_completed", 0),
        }

    # System config (routing + reward weights)
    cfg = _load_json(Path(".system-config.json"))
    state["routing"]        = cfg.get("routing", {})
    state["reward_weights"] = cfg.get("reward_weights", {})

    # Agent profiles summary
    profiles = _load_json(Path(".agent-profiles.json"))
    for agent_id, p in profiles.items():
        state["agents"][agent_id] = {
            "specialization": p.get("specialization", ""),
            "success_rate":   p["performance"]["success_rate"],
            "tasks":          p["performance"]["tasks_completed"],
        }

    # Economy summary
    economy = _load_json(Path(".agent-economy.json"))
    state["economy"] = {
        "agents": len(economy),
        "total_credits": round(sum(w["credits"] for w in economy.values()), 2),
    }

    # Aggregate performance from meta-learning
    meta_log = Path(".meta-learning.jsonl")
    if meta_log.exists():
        total, successes = 0, 0
        with meta_log.open(encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line.strip())
                    total += 1
                    if r.get("success"):
                        successes += 1
                except Exception:
                    pass
        if total > 0:
            state["performance"] = {
                "total_tasks":   total,
                "success_rate":  round(successes / total, 3),
                "total_success": successes,
            }

    return state


def snapshot(label: str) -> str:
    _ensure_dirs()
    version = _next_version()
    state   = _collect_state()

    entry = {
        "version":   version,
        "label":     label,
        "timestamp": _now(),
        "state":     state,
    }
    _save_json(_version_path(version), entry)

    # Record delta vs previous version
    versions = list_versions()
    prev_v   = versions[-2] if len(versions) >= 2 else None
    if prev_v:
        prev = _load_json(_version_path(prev_v))
        delta = _compute_delta(prev["state"], state, prev_v, version, label)
        _append_delta(delta)

    return version


def _compute_delta(old: dict, new: dict, from_v: str, to_v: str, label: str) -> dict:
    changes = []

    # Model changes
    old_models = set(old.get("models", {}).keys())
    new_models = set(new.get("models", {}).keys())
    for m in new_models - old_models:
        changes.append(f"added model {m}")
    for m in old_models - new_models:
        changes.append(f"removed model {m}")
    for m in old_models & new_models:
        old_r = old["models"][m]["avg_reward"]
        new_r = new["models"][m]["avg_reward"]
        if abs(new_r - old_r) > 0.02:
            changes.append(f"model {m}: reward {old_r:.3f} -> {new_r:.3f}")

    # Agent changes
    old_agents = set(old.get("agents", {}).keys())
    new_agents = set(new.get("agents", {}).keys())
    for a in new_agents - old_agents:
        changes.append(f"new agent {a}")

    # Performance delta
    old_perf = old.get("performance", {})
    new_perf = new.get("performance", {})
    old_sr   = old_perf.get("success_rate", 0)
    new_sr   = new_perf.get("success_rate", 0)
    if abs(new_sr - old_sr) > 0.005:
        sign = "+" if new_sr > old_sr else ""
        changes.append(f"overall success_rate: {old_sr:.3f} -> {new_sr:.3f} ({sign}{new_sr - old_sr:.3f})")

    return {
        "from":      from_v,
        "to":        to_v,
        "label":     label,
        "changes":   changes,
        "timestamp": _now(),
        "impact": {
            "success_rate_delta": round(new_sr - old_sr, 4),
            "agent_count_delta":  len(new_agents) - len(old_agents),
        },
    }


# ─── Rollback ─────────────────────────────────────────────────────────────────

_ROLLBACK_FILES = {
    ".system-config.json": "routing",
    ".model-pool.json":    "models",
    ".agent-profiles.json": "agents",
}


def rollback(to_version: str) -> None:
    path = _version_path(to_version)
    if not path.exists():
        print(f"Version not found: {to_version}")
        return

    v = _load_json(path)
    state = v.get("state", {})

    # Restore system config (routing + reward weights)
    cfg = _load_json(Path(".system-config.json"))
    if state.get("routing"):
        cfg["routing"] = state["routing"]
    if state.get("reward_weights"):
        cfg["reward_weights"] = state["reward_weights"]
    cfg["version"] = int(to_version[1:]) if to_version[1:].isdigit() else cfg.get("version", 1)
    _save_json(Path(".system-config.json"), cfg)

    # Log the rollback as a new snapshot
    new_v = snapshot(f"rollback to {to_version}")
    print(f"Rolled back to {to_version} -> created snapshot {new_v}")


# ─── Branching ────────────────────────────────────────────────────────────────

def create_branch(from_version: str, branch_name: str) -> None:
    src = _version_path(from_version)
    if not src.exists():
        print(f"Version not found: {from_version}")
        return
    branch_dir = BRANCHES_DIR / branch_name
    branch_dir.mkdir(exist_ok=True)
    shutil.copy(src, branch_dir / f"base_{from_version}.json")
    meta = {"name": branch_name, "from": from_version, "created": _now(), "snapshots": []}
    _save_json(branch_dir / "meta.json", meta)
    print(f"Created branch '{branch_name}' from {from_version}")


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="System evolution tracker and versioning")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sn = sub.add_parser("snapshot", help="Take a system snapshot")
    sn.add_argument("--label", default="", help="Description of what changed")

    sub.add_parser("history", help="Show version history with performance trajectory")

    df = sub.add_parser("diff", help="Show delta between two versions")
    df.add_argument("from_v", metavar="from")
    df.add_argument("to_v",   metavar="to")

    rb = sub.add_parser("rollback", help="Roll back to a previous version")
    rb.add_argument("--to", required=True, help="Version to restore (e.g. v3)")

    br = sub.add_parser("branch", help="Create an experimental branch from a version")
    br.add_argument("--from", dest="from_v", required=True)
    br.add_argument("--name", required=True)

    sub.add_parser("branches", help="List all branches")

    args = parser.parse_args()

    if args.cmd == "snapshot":
        v = snapshot(args.label or f"snapshot at {_now()[:16]}")
        print(f"Snapshot: {v}  ({args.label})")
        state = _load_json(_version_path(v))
        perf  = state.get("state", {}).get("performance", {})
        if perf:
            print(f"  success_rate={perf.get('success_rate','?')}  "
                  f"total_tasks={perf.get('total_tasks','?')}")

    elif args.cmd == "history":
        versions = list_versions()
        if not versions:
            print("No snapshots yet — run: python scripts/evolution-tracker.py snapshot")
            return
        print(f"{'Version':<10} {'Date':<12} {'SR':>6} {'Tasks':>7}  Label")
        print("-" * 65)
        for v in versions:
            data  = _load_json(_version_path(v))
            ts    = data.get("timestamp", "")[:10]
            perf  = data.get("state", {}).get("performance", {})
            sr    = f"{perf.get('success_rate', '?'):.3f}" if isinstance(perf.get("success_rate"), float) else "?"
            tasks = str(perf.get("total_tasks", "?"))
            label = data.get("label", "")[:40]
            print(f"{v:<10} {ts:<12} {sr:>6} {tasks:>7}  {label}")

    elif args.cmd == "diff":
        for v in [args.from_v, args.to_v]:
            if not _version_path(v).exists():
                print(f"Version not found: {v}")
                return
        old = _load_json(_version_path(args.from_v))
        new = _load_json(_version_path(args.to_v))
        delta = _compute_delta(
            old.get("state", {}), new.get("state", {}),
            args.from_v, args.to_v, "manual diff",
        )
        print(f"Delta: {args.from_v} -> {args.to_v}")
        print(f"  success_rate change: {delta['impact']['success_rate_delta']:+.4f}")
        print(f"  agent count change : {delta['impact']['agent_count_delta']:+d}")
        print(f"Changes:")
        for c in delta["changes"]:
            print(f"  - {c}")
        if not delta["changes"]:
            print("  (no significant changes detected)")

    elif args.cmd == "rollback":
        rollback(args.to)

    elif args.cmd == "branch":
        create_branch(args.from_v, args.name)

    elif args.cmd == "branches":
        if not BRANCHES_DIR.exists():
            print("No branches yet")
            return
        for branch_dir in sorted(BRANCHES_DIR.iterdir()):
            if branch_dir.is_dir():
                meta = _load_json(branch_dir / "meta.json")
                print(f"  {branch_dir.name:<20} from={meta.get('from','?')}  "
                      f"created={meta.get('created','?')[:10]}")


if __name__ == "__main__":
    main()
