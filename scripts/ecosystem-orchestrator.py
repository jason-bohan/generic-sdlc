#!/usr/bin/env python3
"""
ecosystem-orchestrator.py  —  The ecosystem as a first-class object.

While coevolution.py operates as one system within an ecosystem, this script
operates on the ecosystem itself: tracking interaction channels, classifying
systems into ecological roles, detecting phase shifts, and maintaining global
observability.

The 5-layer architecture managed here:
  Layer 1  Independent agents/systems    (each has goals, models, evolution loop)
  Layer 2  Interaction channels          (shared knowledge, task overlap, competition)
  Layer 3  Adaptation mechanisms         (how each system reacts to others)
  Layer 4  Environment                   (sim + production: selection pressure)
  Layer 5  Feedback + memory             (global cross-system metrics and patterns)

Ecological roles (emergent, not assigned):
  core_contributor  — consistently shares high-SR patterns, others benefit
  specialist        — narrow strength profile, deep in 1-2 clusters
  explorer          — frequent strategy changes, drives innovation bursts
  generalist        — broad, moderate competency across all clusters

Ecosystem events detected:
  rapid_convergence   — good pattern spreading faster than 1 cycle
  divergence_burst    — one system exploring while others converge
  emergent_hierarchy  — stable role differentiation across systems
  phase_shift         — sudden strategy reorientation across >= 2 systems

Storage: .ecosystem-orch-state.json, .ecosystem-orch-events.jsonl

Usage:
  python scripts/ecosystem-orchestrator.py snapshot
  python scripts/ecosystem-orchestrator.py channels
  python scripts/ecosystem-orchestrator.py roles
  python scripts/ecosystem-orchestrator.py events
  python scripts/ecosystem-orchestrator.py observe
  python scripts/ecosystem-orchestrator.py loop --cycles 5 --dry-run
"""

import argparse
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
STATE_FILE  = Path(".ecosystem-orch-state.json")
EVENTS_FILE = Path(".ecosystem-orch-events.jsonl")

# Peer data sources (all optional — graceful degradation)
FED_PATTERNS        = Path(".fed-patterns.json")
ECOSYSTEM_CACHE     = Path(".ecosystem-cache.json")
MULTI_TRUST         = Path(".multi-system-trust.json")
COEVOLUTION_STATE   = Path(".coevolution-state.json")
AGENT_PROFILES      = Path(".agent-profiles.json")
META_LOG            = Path(".meta-learning.jsonl")
CULTURE_NORMS       = Path(".culture-norms.json")
EMERGENCE_LOG       = Path(".emergence-log.jsonl")
SELF_MODEL_FILE     = Path(".self-model.json")

# Interaction limits
MAX_SHARED_PATTERNS = 100
MAX_CROSS_CALLS     = 5
MAX_RESOURCE_SLOTS  = 10    # simulated concurrent task capacity
MIN_PATTERN_SR      = 0.65

# Role thresholds
SPECIALIST_DEPTH    = 0.75  # competency in top cluster to qualify
CONTRIBUTOR_SR      = 0.70  # min SR to be a core contributor
EXPLORER_EXPLORE_RATE = 0.40  # fraction of rounds in "explore" strategy

# Phase shift: >= this fraction of systems changing strategy in one cycle
PHASE_SHIFT_THRESHOLD = 0.50


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_json(path: Path) -> dict | list:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _load_state() -> dict:
    raw = _load_json(STATE_FILE)
    if not isinstance(raw, dict):
        raw = {}
    return raw.get("state", _default_state())


def _default_state() -> dict:
    return {
        "systems":          {},    # {system_id: system_record}
        "interaction_log":  [],
        "role_assignments": {},
        "events":           [],
        "global_metrics":   {},
        "cycles":           0,
        "last_observed":    None,
    }


def _save_state(state: dict) -> None:
    _save_json(STATE_FILE, {"state": state})


def _append_event(event: dict) -> None:
    with EVENTS_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


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


# ─── Layer 1: Enumerate independent systems ───────────────────────────────────

def enumerate_systems(state: dict) -> dict[str, dict]:
    """
    Build the set of known systems from all available data sources.
    Returns {system_id: {sr, strengths, weaknesses, patterns, strategy_history}}.
    """
    systems = dict(state.get("systems", {}))

    # Source: local system (self)
    self_model = _load_json(SELF_MODEL_FILE)
    if isinstance(self_model, dict):
        caps = self_model.get("capabilities", {})
        strong = sorted(caps.items(), key=lambda x: -x[1].get("competency", 0))[:2]
        weak   = sorted(caps.items(), key=lambda x:  x[1].get("competency", 1))[:2]
        meta   = _load_meta_log()
        recent = meta[-50:] if meta else []
        sr = sum(1 for r in recent if r.get("success")) / max(len(recent), 1)
        systems.setdefault("self", {
            "system_id":       "self",
            "sr":              round(sr, 3),
            "strengths":       [d for d, _ in strong],
            "weaknesses":      [d for d, _ in weak],
            "pattern_count":   0,
            "strategy_history": [],
            "source":          "self",
        })
        systems["self"]["sr"] = round(sr, 3)

    # Source: co-evolution state (peer models)
    coe = _load_json(COEVOLUTION_STATE)
    if isinstance(coe, dict) and "state" in coe:
        coe_state = coe["state"]
        for sid, pm in (coe_state.get("peer_models") or {}).items():
            systems.setdefault(sid, {
                "system_id":       sid,
                "sr":              pm.get("performance", {}).get("success_rate", 0.5),
                "strengths":       pm.get("strengths", []),
                "weaknesses":      pm.get("weaknesses", []),
                "pattern_count":   len(pm.get("top_patterns", [])),
                "strategy_history": [],
                "source":          "coevolution",
            })
        # Add strategy history
        for h in (coe_state.get("strategy_history") or []):
            systems.setdefault("self", {}).setdefault("strategy_history", []).append(
                h.get("strategy")
            )

    # Source: federation patterns
    fed = _load_json(FED_PATTERNS)
    if isinstance(fed, dict):
        for sid, entry in fed.items():
            if sid.startswith("_"):
                continue
            patterns = entry if isinstance(entry, list) else entry.get("patterns", [])
            good = [p for p in patterns if isinstance(p, dict) and p.get("success_rate", 0) >= MIN_PATTERN_SR]
            systems.setdefault(sid, {
                "system_id":       sid,
                "sr":              0.5,
                "strengths":       [],
                "weaknesses":      [],
                "pattern_count":   len(good),
                "strategy_history": [],
                "source":          "federation",
            })
            systems[sid]["pattern_count"] = len(good)

    # Source: multi-system trust
    trust = _load_json(MULTI_TRUST)
    if isinstance(trust, dict):
        for sid, score in trust.items():
            if sid.startswith("_"):
                continue
            systems.setdefault(sid, {
                "system_id":       sid,
                "sr":              float(score) if isinstance(score, (int, float)) else 0.5,
                "strengths":       [],
                "weaknesses":      [],
                "pattern_count":   0,
                "strategy_history": [],
                "source":          "trust",
            })

    return systems


# ─── Layer 2: Interaction channels ────────────────────────────────────────────

def measure_interaction_channels(systems: dict[str, dict]) -> dict:
    """
    Quantify the active interaction channels between systems.
    Returns {shared_knowledge, task_overlap, resource_competition, coordination_signals}.
    """
    # Shared knowledge: total patterns available across federation
    fed = _load_json(FED_PATTERNS)
    total_patterns = 0
    high_sr_patterns = 0
    if isinstance(fed, dict):
        for sid, entry in fed.items():
            if sid.startswith("_"):
                continue
            patterns = entry if isinstance(entry, list) else entry.get("patterns", [])
            total_patterns += len(patterns)
            high_sr_patterns += sum(
                1 for p in patterns
                if isinstance(p, dict) and p.get("success_rate", 0) >= MIN_PATTERN_SR
            )
    shared_knowledge = {
        "total_patterns":    min(total_patterns, MAX_SHARED_PATTERNS),
        "high_sr_patterns":  high_sr_patterns,
        "knowledge_density": round(high_sr_patterns / max(total_patterns, 1), 3),
    }

    # Task overlap: systems with similar strengths are competing for same task types
    all_strengths: list[str] = []
    for s in systems.values():
        all_strengths.extend(s.get("strengths", []))
    strength_freq = Counter(all_strengths)
    contested_areas = {k: v for k, v in strength_freq.items() if v >= 2}
    task_overlap = {
        "contested_areas":   contested_areas,
        "overlap_intensity": round(sum(contested_areas.values()) / max(len(systems), 1), 2),
    }

    # Resource competition: simulated — systems with similar SR compete for same tasks
    srs = [s.get("sr", 0.5) for s in systems.values()]
    if len(srs) >= 2:
        sr_variance = sum((x - (sum(srs) / len(srs))) ** 2 for x in srs) / len(srs)
        competition_intensity = round(1.0 - min(1.0, sr_variance * 4), 3)  # low variance = high competition
    else:
        competition_intensity = 0.0
    resource_competition = {
        "system_count":         len(systems),
        "competition_intensity": competition_intensity,
        "resource_slots":        MAX_RESOURCE_SLOTS,
        "utilization_estimate": round(min(1.0, len(systems) / MAX_RESOURCE_SLOTS), 2),
    }

    # Coordination signals: trust scores as proxy for active coordination
    trust = _load_json(MULTI_TRUST)
    if isinstance(trust, dict):
        scores = [float(v) for v in trust.values()
                  if not str(v).startswith("_") and isinstance(v, (int, float))]
        avg_trust = round(sum(scores) / len(scores), 3) if scores else 0.0
    else:
        avg_trust = 0.0
    coordination_signals = {
        "active_trust_links": len(trust) if isinstance(trust, dict) else 0,
        "avg_trust":          avg_trust,
        "coordination_level": "high" if avg_trust > 0.7 else "medium" if avg_trust > 0.4 else "low",
    }

    return {
        "shared_knowledge":    shared_knowledge,
        "task_overlap":        task_overlap,
        "resource_competition": resource_competition,
        "coordination_signals": coordination_signals,
        "measured_at":         _now(),
    }


# ─── Layer 3: Ecological role classification ──────────────────────────────────

def classify_ecological_roles(systems: dict[str, dict]) -> dict[str, str]:
    """
    Assign each system an ecological role based on behavior patterns.
    Roles emerge from data — they're not assigned by configuration.
    """
    roles: dict[str, str] = {}

    for sid, s in systems.items():
        sr           = s.get("sr", 0.5)
        strengths    = s.get("strengths", [])
        pattern_cnt  = s.get("pattern_count", 0)
        strat_hist   = s.get("strategy_history", [])

        # Specialist: deep in 1-2 specific clusters
        if (len(strengths) <= 2 and
                sr >= SPECIALIST_DEPTH and
                len(strengths) >= 1):
            roles[sid] = "specialist"
            continue

        # Explorer: high fraction of "explore" strategy in history
        if strat_hist:
            explore_rate = strat_hist.count("explore") / len(strat_hist)
            if explore_rate >= EXPLORER_EXPLORE_RATE:
                roles[sid] = "explorer"
                continue

        # Core contributor: high SR + shares many patterns
        if sr >= CONTRIBUTOR_SR and pattern_cnt >= 5:
            roles[sid] = "core_contributor"
            continue

        # Generalist: broad but not dominant anywhere
        roles[sid] = "generalist"

    return roles


# ─── Layer 4: Environment (selection pressure) ────────────────────────────────

def measure_selection_pressure(meta_records: list[dict]) -> dict:
    """
    Characterize the current environmental selection pressure from test/prod metrics.
    """
    if not meta_records:
        return {"pressure": "unknown", "dominant_failures": [], "overall_sr": None}

    recent = meta_records[-100:]
    overall_sr = sum(1 for r in recent if r.get("success")) / len(recent)

    # Dominant failure clusters
    fail_counter: Counter = Counter()
    for r in recent:
        if not r.get("success"):
            fail_counter[r.get("cluster", "unknown")] += 1
    dominant_failures = [c for c, _ in fail_counter.most_common(3)]

    # Pressure level: high = many failures = strong selection pressure
    pressure_level = "high" if overall_sr < 0.6 else "medium" if overall_sr < 0.8 else "low"

    return {
        "overall_sr":       round(overall_sr, 3),
        "dominant_failures": dominant_failures,
        "pressure":          pressure_level,
        "selection_strength": round(1.0 - overall_sr, 3),
    }


# ─── Layer 5: Global feedback and memory ─────────────────────────────────────

def build_global_feedback(systems: dict, channels: dict, roles: dict,
                           meta_records: list[dict]) -> dict:
    """Aggregate cross-system signals into a global feedback summary."""
    avg_sr = round(
        sum(s.get("sr", 0.5) for s in systems.values()) / max(len(systems), 1), 3
    )
    role_distribution = Counter(roles.values())

    # Knowledge velocity: how quickly high-SR patterns appear
    knowledge_density = channels.get("shared_knowledge", {}).get("knowledge_density", 0)

    # Ecosystem maturity: mix of all roles = mature; only generalists = immature
    has_all_roles = all(r in role_distribution for r in ["specialist", "explorer", "core_contributor"])
    maturity = "mature" if has_all_roles else "developing" if len(role_distribution) >= 2 else "nascent"

    return {
        "avg_system_sr":   avg_sr,
        "role_distribution": dict(role_distribution),
        "ecosystem_maturity": maturity,
        "knowledge_density": knowledge_density,
        "total_systems":   len(systems),
        "feedback_at":     _now(),
    }


# ─── Ecosystem event detection ────────────────────────────────────────────────

def detect_ecosystem_events(systems: dict, roles: dict, channels: dict,
                             state: dict) -> list[dict]:
    """Detect significant ecosystem-level events."""
    events = []
    prev_roles = state.get("role_assignments", {})

    # Event 1: Emergent hierarchy — stable role differentiation
    if len(set(roles.values())) >= 3 and len(systems) >= 3:
        if prev_roles:
            # Roles are stable if <= 1 system changed role
            changes = sum(1 for sid in roles if roles.get(sid) != prev_roles.get(sid, ""))
            if changes <= 1:
                events.append({
                    "type":        "emergent_hierarchy",
                    "description": f"Stable role hierarchy: {dict(Counter(roles.values()))}",
                    "severity":    "positive",
                    "ts":          _now(),
                })

    # Event 2: Phase shift — sudden role reorganization
    if prev_roles and len(prev_roles) >= 2:
        changed = sum(1 for sid in roles if roles.get(sid) != prev_roles.get(sid, roles.get(sid)))
        if changed / max(len(roles), 1) >= PHASE_SHIFT_THRESHOLD:
            events.append({
                "type":        "phase_shift",
                "description": f"{changed}/{len(roles)} systems changed roles simultaneously",
                "severity":    "notable",
                "ts":          _now(),
            })

    # Event 3: Rapid convergence — knowledge density jumped
    prev_metrics = state.get("global_metrics", {})
    prev_density = prev_metrics.get("knowledge_density", 0)
    curr_density = channels.get("shared_knowledge", {}).get("knowledge_density", 0)
    if curr_density - prev_density > 0.15:
        events.append({
            "type":        "rapid_convergence",
            "description": f"Knowledge density jumped {prev_density:.2f} -> {curr_density:.2f}",
            "severity":    "positive",
            "ts":          _now(),
        })

    # Event 4: Divergence burst — explorer role newly appeared
    if "explorer" not in Counter(prev_roles.values()) and "explorer" in roles.values():
        events.append({
            "type":        "divergence_burst",
            "description": "Explorer role emerged — ecosystem entering innovation phase",
            "severity":    "positive",
            "ts":          _now(),
        })

    # Event 5: Collapse warning — all systems same role
    if len(set(roles.values())) == 1:
        events.append({
            "type":        "homogeneity_warning",
            "description": f"All systems converged to role: {list(roles.values())[0]}",
            "severity":    "warning",
            "ts":          _now(),
        })

    # Event 6: Competition overload — resource utilization > 80%
    util = channels.get("resource_competition", {}).get("utilization_estimate", 0)
    if util > 0.80:
        events.append({
            "type":        "resource_pressure",
            "description": f"Resource utilization at {util:.0%} — consider adding capacity",
            "severity":    "warning",
            "ts":          _now(),
        })

    return events


# ─── Global observability ─────────────────────────────────────────────────────

def compute_global_metrics(systems: dict, channels: dict, roles: dict,
                            selection: dict, feedback: dict) -> dict:
    """Single-pane-of-glass metrics for the entire ecosystem."""
    srs = [s.get("sr", 0.5) for s in systems.values()]
    avg_sr = round(sum(srs) / max(len(srs), 1), 3)
    sr_variance = round(sum((x - avg_sr) ** 2 for x in srs) / max(len(srs), 1), 4)

    # Diversity index: role entropy
    role_counts = Counter(roles.values())
    total_roles  = sum(role_counts.values()) or 1
    entropy = -sum((c / total_roles) * math.log2(c / total_roles)
                   for c in role_counts.values() if c > 0)
    max_entropy  = math.log2(max(len(role_counts), 1))
    diversity_index = round(entropy / max_entropy if max_entropy > 0 else 0, 3)

    # Innovation rate: fraction of explorers
    explorer_count = role_counts.get("explorer", 0)
    innovation_rate = round(explorer_count / max(len(systems), 1), 3)

    # Stability score: fraction non-explorers
    stability_score = round(1.0 - innovation_rate, 3)

    # Coordination efficiency: trust × knowledge density
    avg_trust = channels.get("coordination_signals", {}).get("avg_trust", 0.5)
    knowledge_density = channels.get("shared_knowledge", {}).get("knowledge_density", 0)
    coordination_efficiency = round(avg_trust * knowledge_density, 3)

    return {
        "avg_system_sr":          avg_sr,
        "sr_variance":            sr_variance,
        "diversity_index":        diversity_index,
        "innovation_rate":        innovation_rate,
        "stability_score":        stability_score,
        "coordination_efficiency": coordination_efficiency,
        "ecosystem_maturity":     feedback.get("ecosystem_maturity", "unknown"),
        "knowledge_density":      knowledge_density,
        "selection_pressure":     selection.get("pressure", "unknown"),
        "system_count":           len(systems),
        "role_counts":            dict(role_counts),
    }


# ─── Ecosystem recommendation ─────────────────────────────────────────────────

def generate_recommendations(metrics: dict, events: list[dict]) -> list[str]:
    """Translate ecosystem state into human-readable action items."""
    recs = []

    if metrics["diversity_index"] < 0.3:
        recs.append("Diversity is low — encourage exploration strategies to prevent monoculture")

    if metrics["innovation_rate"] < 0.1:
        recs.append("No explorer systems detected — consider seeding an exploration-mode instance")

    if metrics["coordination_efficiency"] < 0.2:
        recs.append("Coordination is weak — run multi-system.py and federation.py to strengthen links")

    if metrics["selection_pressure"] == "high":
        recs.append(f"High environmental pressure — focus systems on dominant failures: "
                    f"check emergence-monitor.py and goal-engine.py")

    if metrics["avg_system_sr"] < 0.6:
        recs.append("Ecosystem-wide success rate is below 60% — trigger meta-manager.py analyze")

    warning_events = [e for e in events if e.get("severity") == "warning"]
    for e in warning_events:
        recs.append(f"[{e['type']}] {e['description']}")

    if not recs:
        recs.append("Ecosystem is healthy — maintain current trajectory")

    return recs


# ─── Observation cycle ────────────────────────────────────────────────────────

def run_observation_cycle(state: dict) -> dict:
    """Run one full 5-layer observation pass and return updated state."""
    meta_records = _load_meta_log()

    # Layer 1: systems
    systems = enumerate_systems(state)

    # Layer 2: channels
    channels = measure_interaction_channels(systems)

    # Layer 3: roles (adaptation)
    roles = classify_ecological_roles(systems)

    # Layer 4: environment
    selection = measure_selection_pressure(meta_records)

    # Layer 5: global feedback
    feedback = build_global_feedback(systems, channels, roles, meta_records)

    # Events
    events   = detect_ecosystem_events(systems, roles, channels, state)
    metrics  = compute_global_metrics(systems, channels, roles, selection, feedback)
    recs     = generate_recommendations(metrics, events)

    # Update state
    state["systems"]          = systems
    state["role_assignments"] = roles
    state["global_metrics"]   = metrics
    state["last_observed"]    = _now()
    state["cycles"]           = state.get("cycles", 0) + 1
    state.setdefault("events", []).extend(events)
    state["events"] = state["events"][-100:]

    for ev in events:
        _append_event(ev)

    return {
        "systems":     systems,
        "channels":    channels,
        "roles":       roles,
        "selection":   selection,
        "feedback":    feedback,
        "metrics":     metrics,
        "events":      events,
        "recommendations": recs,
    }


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Ecosystem orchestrator — global observability and coordination")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("snapshot",  help="Enumerate all known systems (Layer 1)")
    sub.add_parser("channels",  help="Measure interaction channels (Layer 2)")
    sub.add_parser("roles",     help="Classify ecological roles (Layer 3)")
    sub.add_parser("events",    help="Show detected ecosystem events")
    sub.add_parser("observe",   help="Full 5-layer observation cycle")

    loop_p = sub.add_parser("loop", help="Run observation loop continuously")
    loop_p.add_argument("--cycles",  type=int, default=5)
    loop_p.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()
    state = _load_state()

    if args.cmd == "snapshot":
        systems = enumerate_systems(state)
        print(f"Known systems: {len(systems)}")
        print(f"\n{'System ID':<30} {'SR':>5} {'Strengths':<25} {'Patterns':>8} {'Source'}")
        print("-" * 80)
        for sid, s in sorted(systems.items(), key=lambda x: -x[1].get("sr", 0)):
            print(f"{sid[:29]:<30} {s.get('sr', 0):>5.2f} "
                  f"{str(s.get('strengths', []))[:24]:<25} "
                  f"{s.get('pattern_count', 0):>8}  {s.get('source', '?')}")
        state["systems"] = systems
        _save_state(state)

    elif args.cmd == "channels":
        systems  = state.get("systems") or enumerate_systems(state)
        channels = measure_interaction_channels(systems)
        sk = channels["shared_knowledge"]
        to = channels["task_overlap"]
        rc = channels["resource_competition"]
        cs = channels["coordination_signals"]
        print("Interaction Channels")
        print("-" * 50)
        print(f"Shared knowledge:")
        print(f"  Total patterns   : {sk['total_patterns']}")
        print(f"  High-SR patterns : {sk['high_sr_patterns']}")
        print(f"  Knowledge density: {sk['knowledge_density']:.3f}")
        print(f"\nTask overlap:")
        print(f"  Contested areas  : {to['contested_areas']}")
        print(f"  Overlap intensity: {to['overlap_intensity']:.2f}")
        print(f"\nResource competition:")
        print(f"  System count     : {rc['system_count']}")
        print(f"  Competition      : {rc['competition_intensity']:.2f}")
        print(f"  Utilization      : {rc['utilization_estimate']:.0%}")
        print(f"\nCoordination signals:")
        print(f"  Trust links      : {cs['active_trust_links']}")
        print(f"  Avg trust        : {cs['avg_trust']:.3f}")
        print(f"  Coordination     : {cs['coordination_level']}")

    elif args.cmd == "roles":
        systems = state.get("systems") or enumerate_systems(state)
        roles   = classify_ecological_roles(systems)
        state["role_assignments"] = roles
        _save_state(state)

        role_counts = Counter(roles.values())
        print(f"Ecological role assignments ({len(systems)} systems):")
        for role, count in role_counts.most_common():
            sids = [sid for sid, r in roles.items() if r == role]
            print(f"\n  {role.upper()} ({count})")
            for sid in sids:
                s = systems[sid]
                print(f"    {sid[:28]:<30} SR={s.get('sr', 0):.2f}  "
                      f"strengths={s.get('strengths', [])}")

        # Role descriptions
        print(f"\nRole definitions:")
        print(f"  core_contributor  — high SR + many shared patterns")
        print(f"  specialist        — deep competency in 1-2 clusters")
        print(f"  explorer          — frequent exploration, drives divergence bursts")
        print(f"  generalist        — broad but not dominant anywhere")

    elif args.cmd == "events":
        events = state.get("events", [])
        if not events:
            print("No ecosystem events recorded yet — run 'observe' first")
            return
        print(f"Ecosystem events (last {min(len(events), 20)}):")
        print(f"\n{'Type':<25} {'Severity':<10} {'Description':<55} {'Time'}")
        print("-" * 100)
        for e in events[-20:]:
            print(f"{e.get('type', '?'):<25} {e.get('severity', '?'):<10} "
                  f"{e.get('description', '')[:54]:<55} {e.get('ts', '')[:19]}")

    elif args.cmd == "observe":
        obs = run_observation_cycle(state)
        _save_state(state)

        m = obs["metrics"]
        print(f"Ecosystem Observation  {_now()[:19]}")
        print("=" * 60)
        print(f"Systems          : {m['system_count']}")
        print(f"Avg SR           : {m['avg_system_sr']:.3f}  (variance={m['sr_variance']:.4f})")
        print(f"Diversity index  : {m['diversity_index']:.3f}  "
              f"({'healthy' if m['diversity_index'] > 0.4 else 'low'})")
        print(f"Innovation rate  : {m['innovation_rate']:.3f}")
        print(f"Stability score  : {m['stability_score']:.3f}")
        print(f"Coordination eff : {m['coordination_efficiency']:.3f}")
        print(f"Selection pres.  : {m['selection_pressure']}")
        print(f"Maturity         : {m['ecosystem_maturity']}")
        print(f"\nRoles: {m['role_counts']}")

        if obs["events"]:
            print(f"\nEvents this cycle:")
            for e in obs["events"]:
                marker = "+" if e["severity"] == "positive" else "!" if e["severity"] == "warning" else "-"
                print(f"  [{marker}] [{e['type']}] {e['description']}")

        if obs["recommendations"]:
            print(f"\nRecommendations:")
            for r in obs["recommendations"]:
                print(f"  -> {r}")

    elif args.cmd == "loop":
        print(f"Ecosystem orchestration loop: {args.cycles} cycles")
        for i in range(args.cycles):
            print(f"\n--- Cycle {i + 1}/{args.cycles}  {_now()[:19]} ---")
            obs = run_observation_cycle(state)
            _save_state(state)

            m = obs["metrics"]
            print(f"  Systems={m['system_count']}  SR={m['avg_system_sr']:.2f}  "
                  f"diversity={m['diversity_index']:.2f}  maturity={m['ecosystem_maturity']}")
            for e in obs["events"]:
                print(f"  EVENT [{e['type']}]: {e['description'][:60]}")
            for r in obs["recommendations"][:2]:
                print(f"  -> {r}")

        print(f"\nLoop complete. Total cycles: {state['cycles']}")


if __name__ == "__main__":
    main()
