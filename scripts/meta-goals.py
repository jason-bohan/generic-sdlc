#!/usr/bin/env python3
"""
meta-goals.py  —  Self-defined goal evolution: what SHOULD the system optimize for?

Instead of hardcoding goals, this script infers what objectives have historically
driven the best outcomes, scores candidate goals by impact/stability/alignment,
and evolves the system's goal set over time. Meta-constraints prevent reward hacking
by keeping goals tethered to human-legible engineering outcomes.

Goal schema:
  {
    "id":          "goal_reduce_null_ref_failures",
    "description": "Reduce null reference errors to below 5% of all failures",
    "type":        "quality | performance | reliability | process",
    "source":      "inferred | proposed | inherited",
    "score": {
      "impact":     0.85,   -- how much does this improve real outcomes?
      "stability":  0.70,   -- how consistent is progress toward it?
      "alignment":  0.90,   -- does it align with software engineering values?
      "composite":  0.815,
    },
    "meta_constraints": ["requires_tests", "no_scope_creep", "measurable"],
    "status":      "active | achieved | retired | rejected",
    "progress":    0.60,    -- 0-1 fraction
    "created":     "...",
    "updated":     "...",
  }

Storage: .meta-goals.json, .meta-goals-history.jsonl

Usage:
  python scripts/meta-goals.py infer
  python scripts/meta-goals.py score
  python scripts/meta-goals.py evolve --mesh-url http://localhost:9337
  python scripts/meta-goals.py status
  python scripts/meta-goals.py propose --goal "Achieve 95% test pass rate" --type reliability
"""

import argparse
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR  = Path(__file__).parent
GOALS_FILE   = Path(".meta-goals.json")
HISTORY_FILE = Path(".meta-goals-history.jsonl")

META_LOG    = Path(".meta-learning.jsonl")
BLIND_SPOTS = Path(".blind-spots.json")
PRINCIPLES  = Path(".principles.json")
ROADMAP     = Path(".roadmap.json")

# Goal weights for composite scoring
SCORE_WEIGHTS = {"impact": 0.40, "stability": 0.30, "alignment": 0.30}

# Meta-constraints: all inferred goals must satisfy these
META_CONSTRAINTS = [
    "requires_tests",        # any fix must keep tests green
    "no_scope_creep",        # goal must be bounded and measurable
    "measurable",            # must have a numeric success criterion
    "engineering_value",     # must correspond to actual code quality improvement
]

# Forbidden goal patterns (reward-hacking detection)
_HACKING_PATTERNS = [
    r"skip.*test",
    r"disable.*check",
    r"ignore.*error",
    r"increase.*score.*without",
    r"bypass.*lint",
    r"always.*pass",
]

SYSTEM_IDENTITY = {
    "purpose":    "reduce verified software failures in a real codebase",
    "values":     ["correctness", "reliability", "maintainability", "test coverage"],
    "anti_goals": ["gaming metrics", "overfitting to benchmarks", "suppressing failures"],
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_goals() -> dict:
    if GOALS_FILE.exists():
        try:
            return json.loads(GOALS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"goals": [], "last_evolved": None, "evolution_count": 0}


def _save_goals(state: dict) -> None:
    GOALS_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


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


# ─── Infer goals from history ─────────────────────────────────────────────────

def infer_goals_from_history(meta_records: list[dict]) -> list[dict]:
    """Analyze past successes/failures to infer what goals have mattered most."""
    from collections import defaultdict, Counter

    cluster_stats: dict[str, dict] = defaultdict(lambda: {
        "successes": 0, "failures": 0, "attempts": 0,
    })
    for r in meta_records:
        cluster = r.get("cluster", "unknown")
        cluster_stats[cluster]["attempts"] += 1
        if r.get("success"):
            cluster_stats[cluster]["successes"] += 1
        else:
            cluster_stats[cluster]["failures"] += 1

    # Load additional signals
    blind_spots: list[str] = []
    if BLIND_SPOTS.exists():
        try:
            bs = json.loads(BLIND_SPOTS.read_text(encoding="utf-8"))
            blind_spots = [b.get("cluster", "") for b in bs if isinstance(b, dict)]
        except Exception:
            pass

    goals = []
    for cluster, stats in cluster_stats.items():
        total = stats["attempts"] or 1
        failure_rate = stats["failures"] / total
        success_rate = stats["successes"] / total

        if failure_rate < 0.05:
            continue  # already near-perfect, no goal needed

        description = _goal_description(cluster, failure_rate)
        if not description:
            continue

        impact   = min(1.0, failure_rate * 1.5)           # high failure = high impact potential
        stability = success_rate                            # past success = stable progress
        alignment = _alignment_score(cluster)

        composite = sum(
            SCORE_WEIGHTS[k] * v
            for k, v in [("impact", impact), ("stability", stability), ("alignment", alignment)]
        )

        goal_id = f"goal_{cluster}_{datetime.now(timezone.utc).strftime('%Y%m%d')}"
        priority = "high" if cluster in blind_spots else ("medium" if failure_rate > 0.3 else "low")

        goals.append({
            "id":               goal_id,
            "description":      description,
            "type":             _goal_type(cluster),
            "source":           "inferred",
            "score": {
                "impact":    round(impact, 3),
                "stability": round(stability, 3),
                "alignment": round(alignment, 3),
                "composite": round(composite, 3),
            },
            "meta_constraints": META_CONSTRAINTS,
            "status":           "active",
            "progress":         round(success_rate, 3),
            "cluster":          cluster,
            "priority":         priority,
            "evidence": {
                "failure_rate":  round(failure_rate, 3),
                "success_rate":  round(success_rate, 3),
                "total_attempts": total,
            },
            "created": _now(),
            "updated": _now(),
        })

    goals.sort(key=lambda g: -g["score"]["composite"])
    return goals


def _goal_description(cluster: str, failure_rate: float) -> str:
    templates = {
        "null_ref":       f"Reduce null reference errors to below 5% of failures (currently {failure_rate:.0%})",
        "async_await":    f"Eliminate missing-await failures (currently {failure_rate:.0%} failure rate)",
        "test_assertion": f"Fix test assertion failures and keep them below 10% (currently {failure_rate:.0%})",
        "timeout":        f"Resolve timeout failures through retry/backoff improvements (currently {failure_rate:.0%})",
        "import_error":   f"Fix broken imports and module boundaries (currently {failure_rate:.0%} failure rate)",
        "type_error":     f"Achieve TypeScript type safety — eliminate type errors (currently {failure_rate:.0%})",
        "syntax_error":   f"Prevent syntax errors from reaching CI (currently {failure_rate:.0%})",
    }
    return templates.get(cluster, f"Reduce {cluster} failures below 10% (currently {failure_rate:.0%})")


def _goal_type(cluster: str) -> str:
    type_map = {
        "null_ref":       "reliability",
        "async_await":    "reliability",
        "test_assertion": "quality",
        "timeout":        "performance",
        "import_error":   "quality",
        "type_error":     "quality",
        "syntax_error":   "quality",
    }
    return type_map.get(cluster, "reliability")


def _alignment_score(cluster: str) -> float:
    alignment_map = {
        "null_ref":       0.95,
        "async_await":    0.90,
        "test_assertion": 0.85,
        "timeout":        0.80,
        "import_error":   0.90,
        "type_error":     0.92,
        "syntax_error":   0.95,
    }
    return alignment_map.get(cluster, 0.70)


# ─── Reward hacking detection ─────────────────────────────────────────────────

def check_goal_safety(goal: dict) -> list[str]:
    """Check for reward-hacking patterns in a proposed goal."""
    violations = []
    text = (goal.get("description", "") + " " + goal.get("id", "")).lower()
    for pattern in _HACKING_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            violations.append(f"hacking_pattern: {pattern}")

    # Alignment check: must reference engineering values
    engineering_terms = {"test", "error", "failure", "coverage", "type", "lint", "ci", "fix"}
    if not any(t in text for t in engineering_terms):
        violations.append("no_engineering_anchor")

    return violations


# ─── Correlation analysis ─────────────────────────────────────────────────────

def correlate_goals_with_outcomes(goals: list[dict], meta_records: list[dict]) -> list[dict]:
    """Measure how much pursuing each goal cluster actually improved outcomes over time."""
    if not meta_records:
        return goals

    # Split records into early and late halves to see trend
    mid = len(meta_records) // 2
    early, late = meta_records[:mid], meta_records[mid:]

    def _sr(records: list[dict], cluster: str) -> float:
        subset = [r for r in records if r.get("cluster") == cluster]
        if not subset:
            return 0.5
        return sum(1 for r in subset if r.get("success")) / len(subset)

    for goal in goals:
        cluster = goal.get("cluster", "")
        if not cluster:
            continue
        early_sr = _sr(early, cluster)
        late_sr  = _sr(late, cluster)
        trend    = late_sr - early_sr  # positive = improving

        goal["trend"]    = round(trend, 3)
        goal["early_sr"] = round(early_sr, 3)
        goal["late_sr"]  = round(late_sr, 3)

        # Adjust stability score based on trend
        if trend > 0.1:
            goal["score"]["stability"] = min(1.0, goal["score"]["stability"] + 0.1)
        elif trend < -0.1:
            goal["score"]["stability"] = max(0.0, goal["score"]["stability"] - 0.1)

        goal["score"]["composite"] = round(sum(
            SCORE_WEIGHTS[k] * goal["score"][k]
            for k in ["impact", "stability", "alignment"]
        ), 3)

    goals.sort(key=lambda g: -g["score"]["composite"])
    return goals


# ─── LLM goal evolution ───────────────────────────────────────────────────────

_EVOLVE_PROMPT = """\
You are the meta-goal engine for an autonomous AI engineering system.
Current goals and their performance:

{goal_summary}

System identity:
  Purpose: {purpose}
  Values: {values}
  Anti-goals: {anti_goals}

Based on this, propose 2-3 NEW goals that would meaningfully advance the system's purpose.
Each goal must:
1. Be measurable with a concrete success criterion
2. Align with software engineering values (not metric gaming)
3. Address a gap not covered by existing goals

Output a JSON array of goals:
[{{"description": "...", "type": "quality|reliability|performance|process", "rationale": "..."}}]
"""


def llm_propose_goals(goals: list[dict], url: str, model: str) -> list[dict]:
    top_goals = goals[:5]
    goal_summary = "\n".join(
        f"  [{g['status']}] {g['description'][:70]}  composite={g['score']['composite']:.2f}"
        for g in top_goals
    ) or "  (none yet)"

    prompt = _EVOLVE_PROMPT.format(
        goal_summary=goal_summary,
        purpose=SYSTEM_IDENTITY["purpose"],
        values=", ".join(SYSTEM_IDENTITY["values"]),
        anti_goals=", ".join(SYSTEM_IDENTITY["anti_goals"]),
    )

    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.4,
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
            return json.loads(m.group(0))
    except Exception:
        pass
    return []


def package_llm_goal(raw: dict) -> dict:
    description = raw.get("description", "")
    goal_id     = "goal_llm_" + re.sub(r"[^a-z0-9]+", "_", description.lower())[:40]
    return {
        "id":               goal_id,
        "description":      description,
        "type":             raw.get("type", "quality"),
        "source":           "proposed",
        "rationale":        raw.get("rationale", ""),
        "score": {
            "impact":    0.5,
            "stability": 0.5,
            "alignment": 0.7,
            "composite": 0.57,
        },
        "meta_constraints": META_CONSTRAINTS,
        "status":           "active",
        "progress":         0.0,
        "created":          _now(),
        "updated":          _now(),
    }


# ─── Goal maintenance ─────────────────────────────────────────────────────────

def retire_achieved_goals(goals: list[dict]) -> list[dict]:
    for g in goals:
        if g["status"] == "active" and g.get("progress", 0) >= 0.95:
            g["status"] = "achieved"
            g["updated"] = _now()
    return goals


def deduplicate_goals(goals: list[dict]) -> list[dict]:
    seen_ids: set[str] = set()
    result = []
    for g in goals:
        if g["id"] not in seen_ids:
            seen_ids.add(g["id"])
            result.append(g)
    return result


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Meta-goal evolution — self-defined system objectives")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("infer",  help="Infer goals from telemetry history")
    sub.add_parser("score",  help="Re-score and correlate all goals")
    sub.add_parser("status", help="Show active goals")

    evo = sub.add_parser("evolve", help="Infer + LLM-propose + commit new goal set")
    evo.add_argument("--mesh-url", default="http://localhost:9337")
    evo.add_argument("--model",    default="qwen3:14b")

    prop = sub.add_parser("propose", help="Manually propose a new goal")
    prop.add_argument("--goal", required=True)
    prop.add_argument("--type", default="quality",
                      choices=["quality", "reliability", "performance", "process"])

    args = parser.parse_args()
    state = _load_goals()

    if args.cmd == "infer":
        records = _load_meta_log()
        if not records:
            print("No meta-learning records found — run fix-pipeline.py with --record-meta first")
            return
        new_goals = infer_goals_from_history(records)
        new_goals  = correlate_goals_with_outcomes(new_goals, records)
        existing_ids = {g["id"] for g in state["goals"]}
        added = 0
        for g in new_goals:
            violations = check_goal_safety(g)
            if violations:
                print(f"  REJECTED {g['id']}: {violations}")
                continue
            if g["id"] not in existing_ids:
                state["goals"].append(g)
                added += 1
                print(f"  + {g['description'][:70]}  composite={g['score']['composite']:.2f}")
        state["goals"] = retire_achieved_goals(state["goals"])
        state["goals"] = deduplicate_goals(state["goals"])
        _save_goals(state)
        print(f"\nInferred {len(new_goals)} goals, added {added} new ones")

    elif args.cmd == "score":
        records = _load_meta_log()
        state["goals"] = correlate_goals_with_outcomes(state["goals"], records)
        state["goals"] = retire_achieved_goals(state["goals"])
        state["goals"].sort(key=lambda g: -g["score"]["composite"])
        _save_goals(state)
        print(f"{'Goal':<55} {'Impact':>7} {'Stab':>6} {'Align':>6} {'Comp':>6} {'Status':<10}")
        print("-" * 95)
        for g in state["goals"][:10]:
            s = g["score"]
            print(f"{g['description'][:54]:<55} {s['impact']:>7.2f} {s['stability']:>6.2f} "
                  f"{s['alignment']:>6.2f} {s['composite']:>6.2f} {g['status']:<10}")

    elif args.cmd == "evolve":
        records = _load_meta_log()
        inferred = infer_goals_from_history(records)
        inferred = correlate_goals_with_outcomes(inferred, records)

        proposed = llm_propose_goals(state["goals"] + inferred, args.mesh_url, args.model)
        packaged  = []
        for raw in proposed:
            g = package_llm_goal(raw)
            violations = check_goal_safety(g)
            if violations:
                print(f"  REJECTED (safety): {g['description'][:60]}  {violations}")
                continue
            packaged.append(g)
            print(f"  LLM proposed: {g['description'][:70]}")

        existing_ids = {g["id"] for g in state["goals"]}
        added = 0
        for g in inferred + packaged:
            if g["id"] not in existing_ids:
                state["goals"].append(g)
                existing_ids.add(g["id"])
                added += 1

        state["goals"] = retire_achieved_goals(state["goals"])
        state["goals"] = deduplicate_goals(state["goals"])
        state["goals"].sort(key=lambda g: -g["score"]["composite"])
        state["last_evolved"] = _now()
        state["evolution_count"] = state.get("evolution_count", 0) + 1
        _save_goals(state)
        _append_history({"ts": _now(), "added": added, "total": len(state["goals"])})
        print(f"\nEvolution complete: added {added} goals, total={len(state['goals'])}")

    elif args.cmd == "propose":
        g = package_llm_goal({"description": args.goal, "type": args.type})
        violations = check_goal_safety(g)
        if violations:
            print(f"REJECTED (safety violations): {violations}")
            return
        state["goals"].append(g)
        _save_goals(state)
        print(f"Added: {g['description']}")

    elif args.cmd == "status":
        active    = [g for g in state["goals"] if g["status"] == "active"]
        achieved  = [g for g in state["goals"] if g["status"] == "achieved"]
        print(f"Active goals: {len(active)}  Achieved: {len(achieved)}")
        print(f"Last evolved: {state.get('last_evolved', 'never')}  "
              f"Evolution count: {state.get('evolution_count', 0)}")
        if active:
            print(f"\n{'Description':<55} {'Comp':>6} {'Progress':>9} {'Priority'}")
            print("-" * 80)
            for g in sorted(active, key=lambda x: -x["score"]["composite"])[:10]:
                print(f"{g['description'][:54]:<55} {g['score']['composite']:>6.2f} "
                      f"{g.get('progress', 0):>8.0%}  {g.get('priority', '-')}")


if __name__ == "__main__":
    main()
