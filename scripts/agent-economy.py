#!/usr/bin/env python3
"""
agent-economy.py  —  Credit-based internal economy for agent task bidding.

Agents bid on tasks based on predicted reward minus cost. Winners execute the
task; credits are paid on success and deducted on failure. Agents that exhaust
their credits are deprioritized, creating natural specialization without routing
rules.

Wallet schema:
  {
    "agent_id":        "null-ref-agent-1",
    "credits":         124.5,
    "cost_per_task":   2.0,
    "tasks_completed": 47,
    "tasks_won":       31,
    "lifetime_earned": 89.3,
    "lifetime_spent":  42.1,
  }

Storage: .agent-economy.json

Usage:
  python scripts/agent-economy.py bid --task "Fix null ref" --agents agent1,agent2
  python scripts/agent-economy.py auction --task "Fix null ref"
  python scripts/agent-economy.py pay --agent null-ref-agent-1 --reward 0.8 --success true
  python scripts/agent-economy.py status
  python scripts/agent-economy.py reset --agent null-ref-agent-1
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

ECONOMY_FILE      = Path(".agent-economy.json")
DEFAULT_CREDITS   = 10.0
DEFAULT_COST      = 2.0
PENALTY_AMOUNT    = 1.0
MIN_ACTIVE_CREDITS = 2.0
META_KEYS = {"_last_auction"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict:
    if ECONOMY_FILE.exists():
        try:
            return json.loads(ECONOMY_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save(economy: dict) -> None:
    ECONOMY_FILE.write_text(json.dumps(economy, indent=2, ensure_ascii=False), encoding="utf-8")


def _wallet_ids(economy: dict) -> list[str]:
    return [k for k in economy.keys() if k not in META_KEYS]


def _wallets(economy: dict) -> list[dict]:
    return [economy[k] for k in _wallet_ids(economy)]


# ─── Wallet management ────────────────────────────────────────────────────────

def _ensure(agent_id: str, economy: dict) -> dict:
    if agent_id not in economy:
        economy[agent_id] = {
            "agent_id":        agent_id,
            "credits":         DEFAULT_CREDITS,
            "cost_per_task":   DEFAULT_COST,
            "tasks_completed": 0,
            "tasks_won":       0,
            "lifetime_earned": 0.0,
            "lifetime_spent":  0.0,
            "created":         _now(),
            "last_active":     _now(),
        }
    return economy[agent_id]


def _predicted_reward(agent_id: str, profiles: dict | None) -> float:
    """Estimate expected reward from agent profile, default 0.5."""
    if profiles and agent_id in profiles:
        return profiles[agent_id]["performance"]["avg_reward"]
    return 0.5


def explain_bid(agent_id: str, task: str, economy: dict, profiles: dict | None = None) -> dict:
    w = _ensure(agent_id, economy)
    expected = _predicted_reward(agent_id, profiles)
    credit_cost_rate = w["cost_per_task"] / max(w["credits"], 1.0)
    active = w["credits"] >= MIN_ACTIVE_CREDITS
    bid = -999.0 if not active else round(expected - credit_cost_rate, 4)
    return {
        "agent_id":         agent_id,
        "task":             task,
        "bid":              bid,
        "active":           active,
        "credits":          w["credits"],
        "expected_reward":  expected,
        "cost_per_task":    w["cost_per_task"],
        "credit_cost_rate": round(credit_cost_rate, 4),
    }


def compute_bid(agent_id: str, task: str, economy: dict, profiles: dict | None = None) -> float:
    return explain_bid(agent_id, task, economy, profiles)["bid"]


def run_auction(task: str, agent_ids: list[str], economy: dict, profiles: dict | None = None) -> str | None:
    bid_details = [explain_bid(aid, task, economy, profiles) for aid in agent_ids]
    bid_details.sort(key=lambda x: -x["bid"])
    valid = [b for b in bid_details if b["bid"] > -999]
    if not valid:
        economy["_last_auction"] = {
            "task": task,
            "winner": None,
            "bids": bid_details,
            "reason": "no eligible bidders",
            "created": _now(),
        }
        return None
    winner = valid[0]["agent_id"]
    economy[winner]["tasks_won"] += 1
    economy["_last_auction"] = {
        "task": task,
        "winner": winner,
        "bids": bid_details,
        "reason": "highest active bid wins",
        "created": _now(),
    }
    return winner


def pay_reward(agent_id: str, economy: dict, reward: float, success: bool) -> None:
    w = _ensure(agent_id, economy)
    w["tasks_completed"] += 1
    w["last_active"]      = _now()
    if success:
        payout              = reward * w["cost_per_task"] * 2
        w["credits"]        += payout
        w["lifetime_earned"] += payout
    else:
        w["credits"]       = max(0.0, w["credits"] - PENALTY_AMOUNT)
        w["lifetime_spent"] += PENALTY_AMOUNT


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Agent credit economy")
    sub = parser.add_subparsers(dest="cmd", required=True)

    bid_p = sub.add_parser("bid", help="Compute bids for a task")
    bid_p.add_argument("--task",   required=True)
    bid_p.add_argument("--agents", required=True, help="Comma-separated agent IDs")

    auc = sub.add_parser("auction", help="Run auction and return winner")
    auc.add_argument("--task",   required=True)
    auc.add_argument("--agents", default="", help="Comma-sep IDs (default: all registered)")

    pay = sub.add_parser("pay", help="Pay reward or apply penalty")
    pay.add_argument("--agent",   required=True)
    pay.add_argument("--reward",  type=float, default=0.5)
    pay.add_argument("--success", type=lambda x: x.lower() == "true", required=True)

    sub.add_parser("status", help="Show all wallets")

    rst = sub.add_parser("reset", help="Reset an agent wallet")
    rst.add_argument("--agent", required=True)

    args = parser.parse_args()
    economy = _load()

    # Load profiles for informed bidding if available
    profiles = None
    profiles_path = Path(".agent-profiles.json")
    if profiles_path.exists():
        try:
            profiles = json.loads(profiles_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    if args.cmd == "bid":
        agents = [a.strip() for a in args.agents.split(",") if a.strip()]
        print(f"{'Agent':<30} {'Bid':>8}  {'Credits':>8}  Active")
        print("-" * 55)
        for aid in agents:
            w      = _ensure(aid, economy)
            bid    = compute_bid(aid, args.task, economy, profiles)
            active = w["credits"] >= MIN_ACTIVE_CREDITS
            print(f"{aid:<30} {bid:>8.4f}  {w['credits']:>8.2f}  {'yes' if active else 'no'}")
        _save(economy)

    elif args.cmd == "auction":
        agents = [a.strip() for a in args.agents.split(",") if a.strip()] if args.agents else _wallet_ids(economy)
        if not agents:
            print("No agents registered")
            return
        winner = run_auction(args.task, agents, economy, profiles)
        _save(economy)
        if winner:
            bid = compute_bid(winner, args.task, economy, profiles)
            print(f"Winner: {winner}  bid={bid:.4f}  credits={economy[winner]['credits']:.2f}")
        else:
            print("No eligible bidders (all agents below credit threshold)")

    elif args.cmd == "pay":
        pay_reward(args.agent, economy, args.reward, args.success)
        _save(economy)
        w = economy[args.agent]
        print(f"Paid {args.agent}: success={args.success}  reward={args.reward}  credits={w['credits']:.2f}")

    elif args.cmd == "status":
        if not economy:
            print("No wallets yet")
            return
        print(f"{'Agent':<30} {'Credits':>8} {'Won':>5} {'Done':>5} {'Earned':>8} {'Spent':>7}")
        print("-" * 68)
        for w in sorted(_wallets(economy), key=lambda x: -x["credits"]):
            print(f"{w['agent_id']:<30} {w['credits']:>8.2f} {w['tasks_won']:>5} "
                  f"{w['tasks_completed']:>5} {w['lifetime_earned']:>8.2f} {w['lifetime_spent']:>7.2f}")

    elif args.cmd == "reset":
        if args.agent in economy:
            del economy[args.agent]
            _save(economy)
            print(f"Reset: {args.agent}")
        else:
            print(f"Not found: {args.agent}")


if __name__ == "__main__":
    main()
