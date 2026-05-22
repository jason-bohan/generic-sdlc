#!/usr/bin/env python3
"""
culture.py  —  Emergent culture: detect, codify, and reinforce system behavioral norms.

Over time, an autonomous system develops consistent behavioral patterns — preferred
approaches to testing, error handling, naming. This script detects those patterns,
turns them into "norms", injects them as soft constraints into agent prompts, and
detects cultural drift when behavior deviates.

Norm schema:
  {
    "id":           "norm_defensive_null_check",
    "description":  "Always add null checks before property access on external data",
    "source":       "detected | manual | ecosystem",
    "strength":     0.85,      -- 0-1; high = nearly universal behavior
    "reinforcement_count": 42, -- times this norm was applied/rewarded
    "drift_score":  0.0,       -- recent deviation (0=stable, 1=lost)
    "examples":     ["if (x != null) { ... }", "x?.property"],
    "category":     "defensive | style | process | testing",
    "status":       "active | deprecated",
    "created":      "...",
    "updated":      "...",
  }

Storage: .culture-norms.json, .culture-drift.jsonl

Usage:
  python scripts/culture.py detect
  python scripts/culture.py inject --prompt-file task.txt
  python scripts/culture.py reinforce --norm norm_defensive_null_check --success true
  python scripts/culture.py drift
  python scripts/culture.py status
"""

import argparse
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR  = Path(__file__).parent
NORMS_FILE   = Path(".culture-norms.json")
DRIFT_FILE   = Path(".culture-drift.jsonl")

META_LOG     = Path(".meta-learning.jsonl")
EPISODES_LOG = Path(".episodes.jsonl")
PRINCIPLES   = Path(".principles.json")
SKILL_LIB    = Path(".skill-library.json")

DRIFT_THRESHOLD  = 0.30   # norm is "drifting" if drift_score >= this
NORM_MIN_SAMPLES = 5      # need at least 5 observations before a norm is stable
EMA_ALPHA        = 0.15


# ─── Known behavioral pattern templates ───────────────────────────────────────

_PATTERN_SIGNATURES = [
    ("norm_defensive_null_check",
     "defensive",
     "Always add null/undefined checks before accessing properties on external data",
     [r"\?\.", r"!= null", r"!== undefined", r"if \(.*\) \{", r"\?\?"],
     ["x?.property", "if (data != null) { ... }", "value ?? defaultValue"]),

    ("norm_explicit_await",
     "defensive",
     "Always explicitly await async operations — never fire-and-forget",
     [r"\bawait\b", r"async.*=>"],
     ["await fetchData()", "const result = await api.call()"]),

    ("norm_test_first_fix",
     "testing",
     "Write or update tests before modifying implementation",
     [r"\.test\.(ts|tsx|js)", r"\.spec\.(ts|tsx|js)", r"describe\(", r"it\(", r"expect\("],
     ["describe('component', () => { it('handles null', ...) })"]),

    ("norm_typed_returns",
     "style",
     "Always declare explicit TypeScript return types on public functions",
     [r"\): [A-Z][a-zA-Z<>\[\]]+", r": Promise<", r": string", r": number", r": boolean"],
     ["function fetch(): Promise<User>", "const getName = (): string => ..."]),

    ("norm_small_focused_diff",
     "process",
     "Keep changes small and focused on a single concern",
     [],  # detected from diff size stats, not pattern matching
     ["< 50 lines changed", "1-2 files per commit"]),

    ("norm_error_boundary",
     "defensive",
     "Wrap external calls in try/catch with meaningful error messages",
     [r"try \{", r"catch \(", r"throw new Error\(", r"\.catch\("],
     ["try { await api() } catch (e) { throw new Error(`Failed: ${e.message}`) }"]),
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_norms() -> dict:
    if NORMS_FILE.exists():
        try:
            return json.loads(NORMS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"norms": [], "last_detected": None, "detection_count": 0}


def _save_norms(state: dict) -> None:
    NORMS_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def _append_drift(record: dict) -> None:
    with DRIFT_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _load_episodes() -> list[dict]:
    if not EPISODES_LOG.exists():
        return []
    records = []
    with EPISODES_LOG.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except Exception:
                    pass
    return records


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


# ─── Pattern detection ────────────────────────────────────────────────────────

def detect_patterns_in_text(text: str) -> set[str]:
    """Return set of norm IDs whose signatures appear in the text."""
    matched = set()
    for norm_id, _, _, signatures, _ in _PATTERN_SIGNATURES:
        for sig in signatures:
            if re.search(sig, text, re.MULTILINE):
                matched.add(norm_id)
                break
    return matched


def observe_corpus(episodes: list[dict], meta: list[dict]) -> dict[str, dict]:
    """
    Scan episode diffs and meta-log for behavioral patterns.
    Returns {norm_id: {hits, total, success_when_present}}.
    """
    observations: dict[str, dict] = {
        sig[0]: {"hits": 0, "total": 0, "success_when_present": 0}
        for sig in _PATTERN_SIGNATURES
    }

    for ep in episodes:
        diff = ep.get("diff", "") or ep.get("instruction", "")
        if not diff:
            continue
        observed = detect_patterns_in_text(diff)
        success  = ep.get("result", "") in ("tests_passed", "success", "passed")
        for norm_id in observations:
            observations[norm_id]["total"] += 1
            if norm_id in observed:
                observations[norm_id]["hits"] += 1
                if success:
                    observations[norm_id]["success_when_present"] += 1

    # Use meta-log diff field if episodes are sparse
    if len(episodes) < 10:
        for r in meta[-100:]:
            diff = r.get("diff", "")
            if not diff:
                continue
            observed = detect_patterns_in_text(diff)
            success  = r.get("success", False)
            for norm_id in observations:
                observations[norm_id]["total"] += 1
                if norm_id in observed:
                    observations[norm_id]["hits"] += 1
                    if success:
                        observations[norm_id]["success_when_present"] += 1

    return observations


def build_norms_from_observations(observations: dict[str, dict]) -> list[dict]:
    """Convert raw observation counts into norm records."""
    norms = []
    for sig in _PATTERN_SIGNATURES:
        norm_id, category, description, _, examples = sig
        obs = observations.get(norm_id, {})
        total = obs.get("total", 0)
        hits  = obs.get("hits", 0)

        if total < NORM_MIN_SAMPLES:
            strength = 0.5  # insufficient data — neutral strength
        else:
            strength = hits / total

        success_rate = (
            obs.get("success_when_present", 0) / max(hits, 1)
            if hits > 0 else 0.5
        )

        norms.append({
            "id":                  norm_id,
            "description":         description,
            "source":              "detected",
            "strength":            round(strength, 3),
            "success_rate":        round(success_rate, 3),
            "reinforcement_count": 0,
            "drift_score":         0.0,
            "examples":            examples,
            "category":            category,
            "status":              "active",
            "observation_count":   total,
            "hit_count":           hits,
            "created":             _now(),
            "updated":             _now(),
        })

    norms.sort(key=lambda n: -n["strength"])
    return norms


# ─── Prompt injection ─────────────────────────────────────────────────────────

def build_culture_injection(norms: list[dict], top_n: int = 5) -> str:
    """Build a soft-constraint block for injection into agent prompts."""
    active = [n for n in norms if n["status"] == "active" and n["strength"] >= 0.5]
    top    = sorted(active, key=lambda n: -n["strength"])[:top_n]

    if not top:
        return ""

    lines = ["Cultural norms for this codebase (follow these behavioral conventions):"]
    for n in top:
        strength_label = "always" if n["strength"] >= 0.80 else "usually" if n["strength"] >= 0.60 else "often"
        lines.append(f"  - [{strength_label}] {n['description']}")
        if n["examples"]:
            lines.append(f"    e.g. {n['examples'][0]}")

    return "\n".join(lines)


# ─── Reinforcement ────────────────────────────────────────────────────────────

def reinforce_norm(norm: dict, success: bool) -> dict:
    """Update norm strength via EMA based on success/failure."""
    outcome = 1.0 if success else 0.0
    norm["strength"]            = round(EMA_ALPHA * outcome + (1 - EMA_ALPHA) * norm["strength"], 4)
    norm["reinforcement_count"] = norm.get("reinforcement_count", 0) + 1
    norm["updated"]             = _now()
    return norm


# ─── Cultural drift detection ─────────────────────────────────────────────────

def measure_drift(norms: list[dict], recent_episodes: list[dict]) -> list[dict]:
    """
    Compare recent behavior against established norms.
    High drift_score means the system is deviating from its own culture.
    """
    if not recent_episodes:
        return norms

    recent_observations = observe_corpus(recent_episodes, [])

    for norm in norms:
        nid       = norm["id"]
        obs       = recent_observations.get(nid, {})
        total     = obs.get("total", 0)
        hits      = obs.get("hits", 0)

        if total < 3:
            # not enough recent data to measure drift
            continue

        recent_strength = hits / total
        expected        = norm["strength"]
        delta           = abs(expected - recent_strength)

        norm["drift_score"] = round(EMA_ALPHA * delta + (1 - EMA_ALPHA) * norm.get("drift_score", 0.0), 4)
        norm["updated"]     = _now()

        if norm["drift_score"] >= DRIFT_THRESHOLD:
            _append_drift({
                "norm_id":        nid,
                "drift_score":    norm["drift_score"],
                "expected_strength": expected,
                "recent_strength":   round(recent_strength, 3),
                "ts":             _now(),
            })

    return norms


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Emergent culture detection and norm management")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("detect",  help="Detect behavioral patterns and update norms")
    sub.add_parser("drift",   help="Measure cultural drift in recent behavior")
    sub.add_parser("status",  help="Show current norms and drift scores")

    inj = sub.add_parser("inject", help="Inject cultural norms into a prompt file")
    inj.add_argument("--prompt-file", required=True, help="Path to prompt text file")
    inj.add_argument("--output",      default="",    help="Output file (default: print to stdout)")
    inj.add_argument("--top",         type=int, default=5)

    rei = sub.add_parser("reinforce", help="Reinforce or weaken a norm based on outcome")
    rei.add_argument("--norm",    required=True, help="Norm ID")
    rei.add_argument("--success", type=lambda x: x.lower() == "true", required=True)

    args = parser.parse_args()
    state = _load_norms()

    if args.cmd == "detect":
        episodes = _load_episodes()
        meta     = _load_meta_log()

        if not episodes and not meta:
            print("No episode or meta-log data found — run the pipeline first")
            return

        observations = observe_corpus(episodes, meta)
        new_norms    = build_norms_from_observations(observations)

        existing_ids = {n["id"] for n in state["norms"]}
        merged = list(state["norms"])
        added, updated = 0, 0

        for new_n in new_norms:
            if new_n["id"] in existing_ids:
                # Update existing norm — preserve reinforcement count and drift
                for i, existing in enumerate(merged):
                    if existing["id"] == new_n["id"]:
                        new_n["reinforcement_count"] = existing.get("reinforcement_count", 0)
                        new_n["drift_score"]         = existing.get("drift_score", 0.0)
                        merged[i] = new_n
                        updated += 1
                        break
            else:
                merged.append(new_n)
                added += 1

        merged.sort(key=lambda n: -n["strength"])
        state["norms"]            = merged
        state["last_detected"]    = _now()
        state["detection_count"]  = state.get("detection_count", 0) + 1
        _save_norms(state)

        print(f"Detected {len(new_norms)} patterns  (added={added}, updated={updated})")
        print(f"\n{'Norm':<40} {'Strength':>9} {'SR':>6} {'Category'}")
        print("-" * 65)
        for n in merged[:8]:
            print(f"{n['id']:<40} {n['strength']:>9.2f} {n['success_rate']:>6.2f}  {n['category']}")

    elif args.cmd == "inject":
        prompt_path = Path(args.prompt_file)
        if not prompt_path.exists():
            print(f"File not found: {args.prompt_file}")
            return
        original  = prompt_path.read_text(encoding="utf-8")
        injection = build_culture_injection(state["norms"], top_n=args.top)
        result    = f"{injection}\n\n{original}" if injection else original

        if args.output:
            Path(args.output).write_text(result, encoding="utf-8")
            print(f"Written to {args.output}")
        else:
            print(result)

    elif args.cmd == "reinforce":
        target = next((n for n in state["norms"] if n["id"] == args.norm), None)
        if not target:
            print(f"Norm not found: {args.norm}")
            return
        reinforce_norm(target, args.success)
        _save_norms(state)
        print(f"Reinforced {args.norm}: success={args.success}  "
              f"new_strength={target['strength']:.3f}  "
              f"count={target['reinforcement_count']}")

    elif args.cmd == "drift":
        episodes = _load_episodes()
        # Measure drift using the most recent 50 episodes
        recent   = episodes[-50:] if len(episodes) >= 50 else episodes
        state["norms"] = measure_drift(state["norms"], recent)
        _save_norms(state)

        drifting = [n for n in state["norms"] if n.get("drift_score", 0) >= DRIFT_THRESHOLD]
        print(f"Measured drift on {len(recent)} recent episodes")
        print(f"Drifting norms: {len(drifting)}")
        if drifting:
            print(f"\n{'Norm':<40} {'Drift':>7} {'Expected':>9} {'Status'}")
            print("-" * 65)
            for n in sorted(drifting, key=lambda x: -x["drift_score"]):
                print(f"{n['id']:<40} {n['drift_score']:>7.3f} {n['strength']:>9.3f}  DRIFTING")

    elif args.cmd == "status":
        norms  = state["norms"]
        active = [n for n in norms if n["status"] == "active"]
        drifting = [n for n in active if n.get("drift_score", 0) >= DRIFT_THRESHOLD]

        print(f"Total norms    : {len(norms)} ({len(active)} active)")
        print(f"Drifting       : {len(drifting)}")
        print(f"Last detected  : {state.get('last_detected', 'never')}")
        print(f"Detection runs : {state.get('detection_count', 0)}")

        if active:
            print(f"\n{'Norm':<40} {'Strength':>9} {'Drift':>7} {'Category':<12} {'RC':>4}")
            print("-" * 75)
            for n in sorted(active, key=lambda x: -x["strength"])[:10]:
                drift_marker = " *" if n.get("drift_score", 0) >= DRIFT_THRESHOLD else ""
                print(f"{n['id']:<40} {n['strength']:>9.3f} {n.get('drift_score', 0):>7.3f} "
                      f"{n['category']:<12} {n.get('reinforcement_count', 0):>4}{drift_marker}")

        injection = build_culture_injection(active, top_n=3)
        if injection:
            print(f"\nTop norms for prompt injection:\n{injection}")


if __name__ == "__main__":
    main()
