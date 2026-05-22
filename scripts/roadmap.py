#!/usr/bin/env python3
"""
roadmap.py  —  Self-directed system roadmap: what should we build next?

Unlike goal-engine.py (which generates fix tasks for existing bugs), the roadmap
generates CAPABILITY improvements: new agents, new modules, better processes.
The system analyzes its own weaknesses and proposes what to build or change next.

Item types:
  capability    — add a new skill, agent role, or module
  process       — change how something works
  optimization  — tune an existing component
  architecture  — restructure or split a component

Scoring: priority = impact * frequency / difficulty

Roadmap item schema:
  {
    "id":          "rm_20260519_001",
    "title":       "Add dedicated race-condition specialist agent",
    "type":        "capability",
    "rationale":   "race_condition cluster has 41% failure rate, no specialist agent",
    "priority":    0.72,
    "impact":      0.9,
    "frequency":   0.8,
    "difficulty":  1.0,
    "status":      "proposed" | "in_progress" | "done" | "rejected",
    "outcome_sr":  null | float,
  }

Storage: .roadmap.json

Usage:
  python scripts/roadmap.py generate
  python scripts/roadmap.py show
  python scripts/roadmap.py execute --item 1 --dry-run
  python scripts/roadmap.py feedback --item 1 --improved true
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR  = Path(__file__).parent
ROADMAP_FILE = Path(".roadmap.json")

SYSTEM_GOALS = {
    "reliability":   0.40,
    "performance":   0.20,
    "code_quality":  0.20,
    "ux":            0.20,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_roadmap() -> list[dict]:
    if ROADMAP_FILE.exists():
        try:
            return json.loads(ROADMAP_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_roadmap(items: list[dict]) -> None:
    ROADMAP_FILE.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


def _load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default if default is not None else {}


# ─── Opportunity analysis ─────────────────────────────────────────────────────

def _collect_opportunities() -> list[dict]:
    """Build opportunity list from all system telemetry."""
    opps = []

    # Cluster failures from meta-learning
    from collections import defaultdict
    clusters: dict[str, dict] = defaultdict(lambda: {"total": 0, "fail": 0, "att": 0})
    tasks_seen: dict[str, set] = defaultdict(set)
    meta_log = Path(".meta-learning.jsonl")
    if meta_log.exists():
        with meta_log.open(encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line.strip())
                    c = r.get("cluster", "unknown")
                    tid = r.get("task_id") or f"__{r.get('ts','')}_{c}"
                    tasks_seen[c].add(tid)
                    clusters[c]["att"] += 1
                    if not r.get("success"):
                        clusters[c]["fail"] += 1
                except Exception:
                    pass
        for c, d in clusters.items():
            d["total"] = len(tasks_seen[c])
        for c, d in clusters.items():
            fr = d["fail"] / max(d["total"], 1)
            if fr > 0.2 and d["total"] >= 3:
                opps.append({
                    "area":        f"{c}_handling",
                    "cluster":     c,
                    "impact":      min(1.0, fr * 1.5),
                    "frequency":   min(1.0, d["total"] / 20),
                    "difficulty":  min(2.0, d["att"] / max(d["total"], 1)),
                    "failure_rate": round(fr, 3),
                    "type_hint":   "capability",
                })

    # Blind spots
    blind_spots = _load_json(Path(".blind-spots.json"))
    for bs in blind_spots.get("blind_spots", []):
        opps.append({
            "area":       f"{bs['cluster']}_confidence_calibration",
            "cluster":    bs["cluster"],
            "impact":     min(1.0, abs(bs["confidence_gap"]) * 2),
            "frequency":  0.5,
            "difficulty": 0.5,
            "type_hint":  "optimization",
        })

    # Overloaded agents (high task count without specialization)
    profiles = _load_json(Path(".agent-profiles.json"))
    for p in profiles.values():
        tasks = p["performance"]["tasks_completed"]
        if tasks > 50 and not p.get("specialization"):
            opps.append({
                "area":       f"split_{p['agent_id']}",
                "cluster":    "all",
                "impact":     0.6,
                "frequency":  0.7,
                "difficulty": 0.8,
                "type_hint":  "architecture",
            })

    return opps


# ─── LLM-driven roadmap generation ────────────────────────────────────────────

_ROADMAP_PROMPT = """\
You are a tech lead planning improvements for an autonomous AI engineering system.

Based on these improvement opportunities, generate a prioritized roadmap.
Focus on CAPABILITY improvements (new features, modules, agents) — not individual bug fixes.

Opportunities:
{opportunities}

System goals (weighted): {goals}

Output a JSON array of roadmap items:
[
  {{
    "title":      "concise item title",
    "type":       "capability | process | optimization | architecture",
    "rationale":  "one sentence why this matters",
    "impact":     0.0-1.0,
    "frequency":  0.0-1.0,
    "difficulty": 0.1-2.0,
    "target_cluster": "cluster name or 'all'"
  }}
]

Propose 3-5 items. Output only the JSON array.
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


def generate_roadmap(url: str, model: str, top_k: int = 5) -> list[dict]:
    opps = _collect_opportunities()
    if not opps:
        return []

    opps_text = "\n".join(
        f"- {o['area']}: impact={o['impact']:.2f} freq={o['frequency']:.2f} "
        f"difficulty={o['difficulty']:.2f} failure_rate={o.get('failure_rate','?')}"
        for o in opps[:8]
    )
    goals_text = ", ".join(f"{g}({w:.0%})" for g, w in SYSTEM_GOALS.items())

    raw   = call_model(_ROADMAP_PROMPT.format(opportunities=opps_text, goals=goals_text), url, model)
    m     = re.search(r"\[.*\]", raw, re.DOTALL)
    items_raw = json.loads(m.group(0)) if m else []

    existing  = _load_roadmap()
    next_id   = len(existing) + 1
    new_items = []

    for raw_item in items_raw[:top_k]:
        priority = (raw_item.get("impact", 0.5) * raw_item.get("frequency", 0.5) /
                    max(raw_item.get("difficulty", 1.0), 0.1))
        item = {
            "id":             f"rm_{datetime.now(timezone.utc).strftime('%Y%m%d')}_{next_id:03d}",
            "title":          raw_item.get("title", "Untitled"),
            "type":           raw_item.get("type", "capability"),
            "rationale":      raw_item.get("rationale", ""),
            "priority":       round(priority, 4),
            "impact":         raw_item.get("impact", 0.5),
            "frequency":      raw_item.get("frequency", 0.5),
            "difficulty":     raw_item.get("difficulty", 1.0),
            "target_cluster": raw_item.get("target_cluster", "all"),
            "status":         "proposed",
            "outcome_sr":     None,
            "created":        _now(),
        }
        new_items.append(item)
        next_id += 1

    new_items.sort(key=lambda x: -x["priority"])
    all_items = existing + new_items
    _save_roadmap(all_items)
    return new_items


# ─── Execution ────────────────────────────────────────────────────────────────

def execute_item(item: dict, dry_run: bool, mesh_url: str, model: str) -> bool:
    """
    Translate a roadmap item into concrete actions:
    - capability → spawn agent or add to goal-engine queue
    - optimization → update system config via meta-manager
    - architecture → spawn agents, update routing
    """
    item_type = item["type"]
    cluster   = item.get("target_cluster", "all")
    print(f"  Executing [{item_type}]: {item['title']}")

    if dry_run:
        print("  (dry-run)")
        return True

    if item_type in ("capability", "architecture") and cluster != "all":
        ap = SCRIPTS_DIR / "agent-profiles.py"
        if ap.exists():
            result = subprocess.run(
                [sys.executable, str(ap), "spawn", "--cluster", cluster],
                capture_output=True, text=True, encoding="utf-8",
            )
            print(f"  -> {result.stdout.strip()}")

    elif item_type == "optimization":
        # Propose via meta-manager
        mm = SCRIPTS_DIR / "meta-manager.py"
        if mm.exists():
            result = subprocess.run(
                [sys.executable, str(mm), "analyze", "--mesh-url", mesh_url, "--model", model],
                capture_output=True, text=True, encoding="utf-8",
            )
            print(f"  -> meta-manager: {result.stdout.strip()[:100]}")

    elif item_type == "process":
        # Add to goal-engine for task generation
        ge = SCRIPTS_DIR / "goal-engine.py"
        if ge.exists():
            result = subprocess.run(
                [sys.executable, str(ge), "generate", "--top-k", "2"],
                capture_output=True, text=True, encoding="utf-8",
            )
            print(f"  -> goal-engine: generated tasks")

    return True


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Self-directed system roadmap")
    sub = parser.add_subparsers(dest="cmd", required=True)

    gen = sub.add_parser("generate", help="Generate roadmap from system analysis")
    gen.add_argument("--mesh-url", default="http://localhost:9337")
    gen.add_argument("--model",    default="qwen3:14b")
    gen.add_argument("--top-k",   type=int, default=5)

    sub.add_parser("show", help="Show current roadmap")

    exc = sub.add_parser("execute", help="Execute a roadmap item")
    exc.add_argument("--item",     type=int, required=True, help="Item number (1-based)")
    exc.add_argument("--dry-run",  action="store_true")
    exc.add_argument("--mesh-url", default="http://localhost:9337")
    exc.add_argument("--model",    default="meitheal-tuned")

    fb = sub.add_parser("feedback", help="Record whether a roadmap item improved things")
    fb.add_argument("--item",     type=int, required=True)
    fb.add_argument("--improved", type=lambda x: x.lower() == "true", required=True)
    fb.add_argument("--sr",       type=float, default=0.0, help="Measured success rate post-execution")

    args = parser.parse_args()

    if args.cmd == "generate":
        items = generate_roadmap(args.mesh_url, args.model, args.top_k)
        if not items:
            print("No opportunities detected yet (need more telemetry data)")
            return
        print(f"Generated {len(items)} roadmap items:")
        for item in items:
            print(f"  [{item['type']:<14}] pri={item['priority']:.3f}  {item['title']}")
            print(f"    {item['rationale']}")

    elif args.cmd == "show":
        items = _load_roadmap()
        if not items:
            print("No roadmap yet — run 'generate' first")
            return
        proposed  = [i for i in items if i["status"] == "proposed"]
        done      = [i for i in items if i["status"] == "done"]
        print(f"Roadmap: {len(proposed)} proposed / {len(done)} done / {len(items)} total\n")
        print(f"{'#':<4} {'Pri':>6} {'Type':<14} {'Status':<12} Title")
        print("-" * 70)
        for n, item in enumerate(sorted(items, key=lambda x: -x["priority"]), 1):
            print(f"{n:<4} {item['priority']:>6.3f} {item['type']:<14} {item['status']:<12} "
                  f"{item['title'][:40]}")

    elif args.cmd == "execute":
        items = _load_roadmap()
        proposed = [i for i in items if i["status"] == "proposed"]
        if args.item < 1 or args.item > len(proposed):
            print(f"Item {args.item} not found (have {len(proposed)} proposed)")
            return
        item = sorted(proposed, key=lambda x: -x["priority"])[args.item - 1]
        ok = execute_item(item, args.dry_run, args.mesh_url, args.model)
        if ok and not args.dry_run:
            item["status"] = "in_progress"
            _save_roadmap(items)

    elif args.cmd == "feedback":
        items    = _load_roadmap()
        proposed = [i for i in items if i["status"] in ("proposed", "in_progress")]
        if args.item < 1 or args.item > len(proposed):
            print(f"Item {args.item} not found")
            return
        item = sorted(proposed, key=lambda x: -x["priority"])[args.item - 1]
        item["status"]     = "done" if args.improved else "rejected"
        item["outcome_sr"] = args.sr
        item["completed"]  = _now()
        _save_roadmap(items)
        print(f"Item '{item['title']}': {item['status']}  outcome_sr={args.sr}")


if __name__ == "__main__":
    main()
