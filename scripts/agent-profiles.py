#!/usr/bin/env python3
"""
agent-profiles.py  —  Persistent agent identity and specialization tracking.

Each agent develops a profile: skills mastered, performance history, and which
failure clusters it handles best. Over time, agents are routed to tasks that
match their specialization — and new agents are spawned for under-served clusters.

Profile schema:
  {
    "agent_id":       "null-ref-agent-1",
    "specialization": "null_ref",
    "skills":         ["add_null_guard"],
    "performance":    {"success_rate": 0.82, "avg_reward": 0.74, "tasks_completed": 183},
    "clusters_seen":  {"null_ref": 47, "timeout": 12},
    "credits":        124.5,
    "created":        "2026-05-19T...",
    "last_active":    "2026-05-19T...",
  }

Storage: .agent-profiles.json

Usage:
  python scripts/agent-profiles.py list
  python scripts/agent-profiles.py show backend-agent-1
  python scripts/agent-profiles.py update backend-agent-1 --cluster null_ref --success true --reward 0.8
  python scripts/agent-profiles.py best --cluster null_ref
  python scripts/agent-profiles.py spawn --cluster null_ref
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

PROFILES_FILE = Path(".agent-profiles.json")
ALPHA = 0.1  # EMA smoothing


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict:
    if PROFILES_FILE.exists():
        try:
            return json.loads(PROFILES_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save(profiles: dict) -> None:
    PROFILES_FILE.write_text(json.dumps(profiles, indent=2, ensure_ascii=False), encoding="utf-8")


# ─── Profile operations ───────────────────────────────────────────────────────

def create_agent(agent_id: str, profiles: dict) -> dict:
    profile = {
        "agent_id":       agent_id,
        "specialization": "",
        "skills":         [],
        "performance":    {"success_rate": 0.5, "avg_reward": 0.0, "tasks_completed": 0},
        "clusters_seen":  {},
        "credits":        10.0,
        "created":        _now(),
        "last_active":    _now(),
    }
    profiles[agent_id] = profile
    return profile


def update_agent(
    agent_id: str,
    profiles: dict,
    cluster: str,
    success: bool,
    reward: float = 0.0,
    skills_used: list[str] | None = None,
) -> dict:
    if agent_id not in profiles:
        create_agent(agent_id, profiles)

    p    = profiles[agent_id]
    perf = p["performance"]

    perf["success_rate"]   = (1 - ALPHA) * perf["success_rate"]   + ALPHA * float(success)
    perf["avg_reward"]     = (1 - ALPHA) * perf["avg_reward"]     + ALPHA * reward
    perf["tasks_completed"] += 1

    p["clusters_seen"][cluster] = p["clusters_seen"].get(cluster, 0) + 1
    # Specialization = cluster seen most often
    p["specialization"] = max(p["clusters_seen"], key=p["clusters_seen"].__getitem__)

    for sk in (skills_used or []):
        if sk not in p["skills"]:
            p["skills"].append(sk)

    p["last_active"] = _now()
    return p


def cluster_affinity(profile: dict, cluster: str) -> float:
    """0-1 score: how well-suited is this agent for this cluster?"""
    seen  = profile["clusters_seen"].get(cluster, 0)
    total = sum(profile["clusters_seen"].values()) or 1
    return round(0.6 * (seen / total) + 0.4 * profile["performance"]["success_rate"], 4)


def best_agent_for_task(cluster: str, profiles: dict) -> str | None:
    if not profiles:
        return None
    scored = [(aid, cluster_affinity(p, cluster)) for aid, p in profiles.items()]
    scored.sort(key=lambda x: -x[1])
    return scored[0][0]


def spawn_agent(cluster: str, profiles: dict) -> str:
    existing = [k for k in profiles if k.startswith(f"{cluster}-agent-")]
    agent_id = f"{cluster}-agent-{len(existing) + 1}"
    create_agent(agent_id, profiles)
    return agent_id


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Agent profile management")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="List all agent profiles")

    sh = sub.add_parser("show", help="Show a specific agent profile")
    sh.add_argument("agent_id")

    upd = sub.add_parser("update", help="Record a task result for an agent")
    upd.add_argument("agent_id")
    upd.add_argument("--cluster",  required=True)
    upd.add_argument("--success",  type=lambda x: x.lower() == "true", required=True)
    upd.add_argument("--reward",   type=float, default=0.0)
    upd.add_argument("--skills",   default="", help="Comma-separated skills used")

    best = sub.add_parser("best", help="Find best agent for a cluster")
    best.add_argument("--cluster", required=True)

    spawn = sub.add_parser("spawn", help="Spawn new specialist agent for a cluster")
    spawn.add_argument("--cluster", required=True)

    args = parser.parse_args()
    profiles = _load()

    if args.cmd == "list":
        if not profiles:
            print("No agents yet")
            return
        print(f"{'Agent':<30} {'Spec':<18} {'SR':>5} {'Reward':>7} {'Tasks':>6}")
        print("-" * 65)
        for p in sorted(profiles.values(), key=lambda x: -x["performance"]["success_rate"]):
            perf = p["performance"]
            print(f"{p['agent_id']:<30} {p['specialization']:<18} "
                  f"{perf['success_rate']:>5.2f} {perf['avg_reward']:>7.3f} "
                  f"{perf['tasks_completed']:>6}")

    elif args.cmd == "show":
        p = profiles.get(args.agent_id)
        print(json.dumps(p, indent=2) if p else f"Not found: {args.agent_id}")

    elif args.cmd == "update":
        skills = [s.strip() for s in args.skills.split(",") if s.strip()]
        update_agent(args.agent_id, profiles, args.cluster, args.success, args.reward, skills)
        _save(profiles)
        p = profiles[args.agent_id]
        print(f"Updated {args.agent_id}: sr={p['performance']['success_rate']:.3f}  "
              f"spec={p['specialization']}")

    elif args.cmd == "best":
        winner = best_agent_for_task(args.cluster, profiles)
        if winner:
            aff = cluster_affinity(profiles[winner], args.cluster)
            print(f"Best for '{args.cluster}': {winner}  affinity={aff:.3f}")
        else:
            print("No agents registered")

    elif args.cmd == "spawn":
        new_id = spawn_agent(args.cluster, profiles)
        _save(profiles)
        print(f"Spawned: {new_id}")


if __name__ == "__main__":
    main()
