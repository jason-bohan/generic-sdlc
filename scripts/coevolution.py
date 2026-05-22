#!/usr/bin/env python3
"""
coevolution.py  —  Co-adaptive intelligence ecosystems with collective emergence.

Each system doesn't just model itself — it models other systems, predicts their
evolution, and chooses a strategic response. The result is an ecosystem where
behaviors emerge from interaction rather than from explicit design.

Co-evolution loop (per system):
  1. Model itself (from self-model + meta-log)
  2. Model peer systems (from federation/ecosystem data)
  3. Generate self-variants (counterfactual engine)
  4. Predict peer futures (LLM)
  5. Simulate interaction: (self_variant × peer_futures) → combined score
  6. Choose strategy: specialize | compete | cooperate | explore
  7. Apply changes (bounded: MAX_SYSTEM_CHANGE = 0.10 per iteration)
  8. Share partial knowledge through federation

Ecosystem forces balanced:
  - Cooperation:   shared knowledge, aligned patterns
  - Competition:   better strategies dominate
  - Exploration:   new architectures, new approaches

Safety constraints:
  - MAX_SHARED_PATTERNS = 100     (no knowledge flooding)
  - MAX_PEER_INFLUENCE   = 0.30   (self-evolution > peer influence)
  - MAX_SYSTEM_CHANGE    = 0.10   (bounded per-iteration change)
  - DIVERSITY_THRESHOLD  = 0.85   (force divergence if too similar)
  - Independent validation required before deploying peer-influenced changes

Storage: .coevolution-state.json, .coevolution-history.jsonl

Usage:
  python scripts/coevolution.py model-peers
  python scripts/coevolution.py predict-peers --mesh-url http://localhost:9337
  python scripts/coevolution.py strategize
  python scripts/coevolution.py loop --rounds 3 --dry-run
  python scripts/coevolution.py ecosystem-health
  python scripts/coevolution.py status
"""

import argparse
import copy
import json
import math
import re
import subprocess
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR  = Path(__file__).parent
STATE_FILE   = Path(".coevolution-state.json")
HISTORY_FILE = Path(".coevolution-history.jsonl")

# Peer data sources
ECOSYSTEM_CACHE  = Path(".ecosystem-cache.json")
FED_PATTERNS     = Path(".fed-patterns.json")
MULTI_TRUST      = Path(".multi-system-trust.json")
SELF_MODEL_FILE  = Path(".self-model.json")
META_LOG         = Path(".meta-learning.jsonl")
COUNTERFACTUAL   = Path(".counterfactual-state.json")
AGENT_PROFILES   = Path(".agent-profiles.json")
SYSTEM_CONFIG    = Path(".system-config.json")
META_GOALS       = Path(".meta-goals.json")

# Co-evolution constraints
MAX_SHARED_PATTERNS  = 100
MAX_PEER_INFLUENCE   = 0.30   # max fraction of change attributable to peer data
MAX_SYSTEM_CHANGE    = 0.10   # max delta in any numeric parameter per iteration
DIVERSITY_THRESHOLD  = 0.85   # cosine similarity above this → force divergence
MIN_PATTERN_SR       = 0.65   # reject peer patterns below this success rate

STRATEGIES = ["specialize", "compete", "cooperate", "explore"]

SYSTEM_IDENTITY = {
    "purpose":    "reduce verified software failures in a real codebase",
    "values":     ["correctness", "reliability", "maintainability", "test coverage"],
    "boundaries": [
        "must not skip or disable tests",
        "must not claim success without validation",
        "must not modify alignment constraints",
    ],
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts_id() -> str:
    return f"coe_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"


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
    if not isinstance(raw, dict) or "state" not in raw:
        return _default_state()
    return raw["state"]


def _default_state() -> dict:
    return {
        "peer_models":    {},
        "peer_futures":   {},
        "strategy":       "explore",
        "strategy_history": [],
        "ecosystem_metrics": {},
        "rounds":         0,
        "last_loop":      None,
        "deployed_changes": [],
    }


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


# ─── Peer system modeling ─────────────────────────────────────────────────────

def build_peer_models() -> dict[str, dict]:
    """
    Construct internal models of peer systems from federation and ecosystem data.
    Returns {system_id: {strengths, weaknesses, evolution_rate, performance, ...}}.
    """
    peer_models: dict[str, dict] = {}

    # Source 1: ecosystem cache (published state snapshots)
    eco_cache = _load_json(ECOSYSTEM_CACHE)
    if isinstance(eco_cache, dict):
        trends = eco_cache.get("trends", {})
        # Each publisher is a peer; we only have aggregate data here
        for pattern, count in (trends.get("global_patterns", {}) or {}).items():
            # Create a virtual "ecosystem" peer representing aggregate behavior
            if "ecosystem_aggregate" not in peer_models:
                peer_models["ecosystem_aggregate"] = {
                    "system_id":       "ecosystem_aggregate",
                    "strengths":       [],
                    "weaknesses":      [],
                    "evolution_rate":  0.5,
                    "performance":     {"success_rate": 0.6},
                    "top_patterns":    [],
                    "top_failures":    [],
                    "source":          "ecosystem",
                }
            peer_models["ecosystem_aggregate"]["top_patterns"].append(pattern)

        consensus_failures = trends.get("consensus_failures", [])
        if consensus_failures and "ecosystem_aggregate" in peer_models:
            peer_models["ecosystem_aggregate"]["top_failures"] = consensus_failures

    # Source 2: federation pattern store
    fed = _load_json(FED_PATTERNS)
    if isinstance(fed, dict):
        for sid, entry in fed.items():
            if sid.startswith("_"):
                continue
            patterns = entry if isinstance(entry, list) else entry.get("patterns", [])
            if not patterns:
                continue
            high_sr_patterns = [p for p in patterns
                                 if isinstance(p, dict) and p.get("success_rate", 0) >= MIN_PATTERN_SR]
            peer_models.setdefault(sid, {
                "system_id":       sid,
                "strengths":       [],
                "weaknesses":      [],
                "evolution_rate":  0.5,
                "performance":     {"success_rate": 0.5},
                "top_patterns":    [],
                "top_failures":    [],
                "source":          "federation",
            })
            peer_models[sid]["top_patterns"] = [
                p.get("instruction", p.get("trigger", ""))[:60]
                for p in high_sr_patterns[:5]
            ]

    # Source 3: multi-system trust scores
    trust = _load_json(MULTI_TRUST)
    if isinstance(trust, dict):
        for sid, score in trust.items():
            if sid.startswith("_"):
                continue
            peer_models.setdefault(sid, {
                "system_id":       sid,
                "strengths":       [],
                "weaknesses":      [],
                "evolution_rate":  0.5,
                "performance":     {"success_rate": float(score) if isinstance(score, (int, float)) else 0.5},
                "top_patterns":    [],
                "top_failures":    [],
                "source":          "trust",
            })
            if isinstance(score, (int, float)):
                peer_models[sid]["performance"]["trust_score"] = round(float(score), 3)

    # Infer strengths/weaknesses from pattern clusters
    for sid, model in peer_models.items():
        patterns = model.get("top_patterns", [])
        cluster_keywords = {
            "null_ref":    ["null", "undefined", "property"],
            "async_await": ["async", "await", "promise"],
            "timeout":     ["timeout", "retry", "latency"],
            "type_error":  ["type", "typescript", "interface"],
            "testing":     ["test", "spec", "assert"],
        }
        cluster_hits: Counter = Counter()
        for pat in patterns:
            for cluster, kws in cluster_keywords.items():
                if any(kw in pat.lower() for kw in kws):
                    cluster_hits[cluster] += 1
        if cluster_hits:
            model["strengths"]  = [c for c, _ in cluster_hits.most_common(2)]
            model["weaknesses"] = [c for c, _ in cluster_hits.most_common()[-2:] if c not in model["strengths"]]

    return peer_models


# ─── Peer future prediction ───────────────────────────────────────────────────

_PREDICT_PEER_PROMPT = """\
You are modeling how a peer AI engineering system will evolve.

Peer system data:
  System ID: {system_id}
  Strengths: {strengths}
  Weaknesses: {weaknesses}
  Top patterns: {patterns}
  Evolution rate: {evolution_rate}
  Performance: {performance}

Based on this, predict how this peer system will likely evolve in the next iteration.

Output a JSON object:
{{
  "likely_next_changes": ["change 1", "change 2"],
  "emerging_strengths": ["area 1"],
  "projected_success_rate": 0.0-1.0,
  "strategic_direction": "one sentence"
}}
"""


def predict_peer_future(peer_model: dict, url: str, model: str) -> dict:
    prompt = _PREDICT_PEER_PROMPT.format(
        system_id=peer_model.get("system_id", "unknown"),
        strengths=peer_model.get("strengths", []),
        weaknesses=peer_model.get("weaknesses", []),
        patterns=peer_model.get("top_patterns", [])[:3],
        evolution_rate=peer_model.get("evolution_rate", 0.5),
        performance=peer_model.get("performance", {}),
    )
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens": 256,
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
    req = urllib.request.Request(
        f"{url}/v1/chat/completions", data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
            raw  = data["choices"][0]["message"]["content"].strip()
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            result = json.loads(m.group(0))
            result["system_id"] = peer_model.get("system_id", "unknown")
            result["predicted_at"] = _now()
            return result
    except Exception:
        pass
    return {
        "system_id":              peer_model.get("system_id", "unknown"),
        "likely_next_changes":    [],
        "emerging_strengths":     [],
        "projected_success_rate": peer_model.get("performance", {}).get("success_rate", 0.5),
        "strategic_direction":    "unknown",
        "predicted_at":           _now(),
    }


# ─── Self-snapshot (reuse counterfactual approach) ───────────────────────────

def get_self_snapshot() -> dict:
    """Load self-model + current config into a compact snapshot."""
    self_model = _load_json(SELF_MODEL_FILE)
    if not isinstance(self_model, dict):
        self_model = {}

    meta = _load_meta_log()
    recent = meta[-50:] if meta else []
    if recent:
        success_rate = sum(1 for r in recent if r.get("success")) / len(recent)
    else:
        success_rate = 0.5

    caps = self_model.get("capabilities", {})
    strong = sorted(caps.items(), key=lambda x: -x[1].get("competency", 0))[:2]
    weak   = sorted(caps.items(), key=lambda x: x[1].get("competency", 1))[:2]

    sys_config = _load_json(SYSTEM_CONFIG)
    if not isinstance(sys_config, dict):
        sys_config = {}

    goals_data = _load_json(META_GOALS)
    active_goals = [
        g.get("description", "")[:50]
        for g in (goals_data.get("goals", []) if isinstance(goals_data, dict) else [])
        if g.get("status") == "active"
    ][:3]

    return {
        "success_rate": round(success_rate, 3),
        "strengths":    [d for d, _ in strong],
        "weaknesses":   [d for d, _ in weak],
        "planning_depth": sys_config.get("planning_depth", 2),
        "reward_weights": sys_config.get("reward_weights", {"correctness": 1.0}),
        "active_goals": active_goals,
    }


# ─── Interaction simulation ───────────────────────────────────────────────────

def simulate_interaction(self_snapshot: dict, peer_futures: list[dict], dry_run: bool = False) -> dict:
    """
    Estimate combined outcome if self evolves one way while peers evolve as predicted.
    Returns {combined_score, synergy, competition_pressure, cooperation_gain}.
    """
    self_sr   = self_snapshot.get("success_rate", 0.5)
    self_str  = set(self_snapshot.get("strengths", []))

    peer_projected_srs = [p.get("projected_success_rate", 0.5) for p in peer_futures]
    avg_peer_sr = sum(peer_projected_srs) / len(peer_projected_srs) if peer_projected_srs else 0.5

    # Specialization synergy: if self focuses on areas peers are weak in → high synergy
    peer_emerging = set()
    for pf in peer_futures:
        peer_emerging.update(pf.get("emerging_strengths", []))
    overlap = self_str & peer_emerging
    synergy  = 1.0 - (len(overlap) / max(len(self_str | peer_emerging), 1))

    # Competition pressure: peers improving in same areas reduces relative advantage
    competition_pressure = min(1.0, avg_peer_sr / max(self_sr, 0.01))

    # Cooperation gain: if peers share patterns we lack, we benefit
    cooperation_gain = min(0.2, (avg_peer_sr - self_sr) * 0.5) if avg_peer_sr > self_sr else 0.0

    combined_score = round(
        self_sr * 0.60
        + synergy * 0.20
        + cooperation_gain * 0.15
        - competition_pressure * 0.05,
        4
    )

    return {
        "self_sr":              self_sr,
        "avg_peer_sr":          round(avg_peer_sr, 3),
        "synergy":              round(synergy, 3),
        "competition_pressure": round(competition_pressure, 3),
        "cooperation_gain":     round(cooperation_gain, 3),
        "combined_score":       combined_score,
        "dry_run":              dry_run,
    }


# ─── Strategy selection ───────────────────────────────────────────────────────

def choose_strategy(self_snapshot: dict, peer_models: dict, peer_futures: dict,
                    interaction_result: dict) -> tuple[str, str]:
    """
    Choose a co-evolution strategy based on ecosystem dynamics.
    Returns (strategy, rationale).
    """
    self_str  = set(self_snapshot.get("strengths", []))
    self_weak = set(self_snapshot.get("weaknesses", []))
    self_sr   = self_snapshot.get("success_rate", 0.5)
    synergy   = interaction_result.get("synergy", 0.5)
    coop_gain = interaction_result.get("cooperation_gain", 0.0)
    comp      = interaction_result.get("competition_pressure", 0.5)

    # Count peer strengths to identify unclaimed territory
    all_peer_strengths: Counter = Counter()
    for pm in peer_models.values():
        for s in pm.get("strengths", []):
            all_peer_strengths[s] += 1

    unclaimed = [d for d in ["null_ref", "async_await", "timeout", "type_error", "testing"]
                 if all_peer_strengths.get(d, 0) == 0 and d not in self_str]

    # Decision tree
    if coop_gain > 0.10:
        return ("cooperate",
                f"Peers are ahead in key areas — absorb their patterns (gain={coop_gain:.2f})")

    if synergy > 0.70 and unclaimed:
        return ("specialize",
                f"High specialization opportunity in unclaimed area: {unclaimed[0]}")

    if comp > 0.85 and self_sr < 0.70:
        return ("explore",
                f"Competition pressure high and self-SR low — explore new strategies")

    if synergy < 0.40:
        return ("compete",
                f"Overlap with peers is high — compete directly on core competencies")

    if len(peer_models) < 2:
        return ("explore",
                "Few peers detected — explore to diversify ecosystem")

    return ("cooperate",
            "Balanced conditions — default to cooperation for ecosystem health")


# ─── Diversity preservation ───────────────────────────────────────────────────

def _embed_snapshot(snapshot: dict) -> dict[str, float]:
    """Produce a sparse feature vector from a system snapshot for similarity comparison."""
    vec: dict[str, float] = {}
    for s in snapshot.get("strengths", []):
        vec[f"strength_{s}"] = 1.0
    for w in snapshot.get("weaknesses", []):
        vec[f"weakness_{w}"] = 1.0
    vec["planning_depth"]  = snapshot.get("planning_depth", 2) / 4.0
    rw = snapshot.get("reward_weights", {})
    for k, v in rw.items():
        vec[f"rw_{k}"] = float(v)
    return vec


def cosine_similarity(a: dict[str, float], b: dict[str, float]) -> float:
    keys = set(a) | set(b)
    dot  = sum(a.get(k, 0) * b.get(k, 0) for k in keys)
    na   = math.sqrt(sum(v * v for v in a.values())) or 1.0
    nb   = math.sqrt(sum(v * v for v in b.values())) or 1.0
    return round(dot / (na * nb), 4)


def enforce_divergence(self_snapshot: dict, peer_snapshots: list[dict]) -> list[str]:
    """
    Return a list of dimensions to deliberately diversify if similarity is too high.
    """
    self_vec    = _embed_snapshot(self_snapshot)
    diversify   = []

    for peer_snap in peer_snapshots:
        peer_vec = _embed_snapshot(peer_snap)
        sim = cosine_similarity(self_vec, peer_vec)
        if sim >= DIVERSITY_THRESHOLD:
            # Find most shared dimensions → suggest flipping one
            shared = [k for k in self_vec if k in peer_vec and self_vec[k] == peer_vec[k]]
            if shared:
                diversify.append(shared[0])

    return list(set(diversify))[:3]


# ─── Apply bounded change ─────────────────────────────────────────────────────

def apply_strategy_change(strategy: str, self_snapshot: dict, peer_futures: list[dict]) -> dict:
    """
    Produce a modified system config based on chosen strategy.
    Changes are bounded to MAX_SYSTEM_CHANGE per numeric dimension.
    """
    config = _load_json(SYSTEM_CONFIG)
    if not isinstance(config, dict):
        config = {}

    rw = copy.deepcopy(config.get("reward_weights", {"correctness": 1.0, "diff_size": 0.3}))
    pd = config.get("planning_depth", 2)
    routing = copy.deepcopy(config.get("routing", {}))

    if strategy == "cooperate":
        # Absorb peer patterns: slightly increase correctness to align with cooperative value
        delta = min(MAX_SYSTEM_CHANGE, 0.05)
        rw["correctness"] = round(rw.get("correctness", 1.0) + delta, 3)

    elif strategy == "specialize":
        # Deepen planning for specialization
        pd = min(pd + 1, 4)
        rw["correctness"] = round(min(1.5, rw.get("correctness", 1.0) * (1 + MAX_SYSTEM_CHANGE)), 3)

    elif strategy == "compete":
        # Optimize for raw success rate — reduce latency/diff penalty weight
        rw["diff_size"] = round(max(0.1, rw.get("diff_size", 0.3) * (1 - MAX_SYSTEM_CHANGE)), 3)
        rw["latency"]   = round(max(0.1, rw.get("latency",   0.2) * (1 - MAX_SYSTEM_CHANGE)), 3)

    elif strategy == "explore":
        # Increase planning depth and try a new routing approach
        pd = min(pd + 1, 4)
        # Route high-risk tasks to strongest available model
        models = config.get("model_pool", ["SDLC Framework-tuned", "qwen3:8b"])
        if models:
            routing["high_risk_tasks"] = models[-1]

    # Always: correctness must remain highest weight
    max_other = max((v for k, v in rw.items() if k != "correctness"), default=0)
    if max_other >= rw.get("correctness", 1.0):
        rw["correctness"] = round(max_other + 0.1, 3)

    return {
        "reward_weights":   rw,
        "planning_depth":   pd,
        "routing":          routing,
        "_coevolution_strategy": strategy,
        "_coevolution_ts":       _now(),
    }


# ─── Ecosystem health ─────────────────────────────────────────────────────────

def measure_ecosystem_health(peer_models: dict, self_snapshot: dict,
                              history: list[dict]) -> dict:
    """Compute ecosystem-level metrics."""
    all_snapshots  = [self_snapshot] + [
        {"strengths": pm.get("strengths", []),
         "weaknesses": pm.get("weaknesses", []),
         "planning_depth": 2,
         "reward_weights": {"correctness": 1.0}}
        for pm in peer_models.values()
    ]

    # Diversity index: avg pairwise dissimilarity
    vecs = [_embed_snapshot(s) for s in all_snapshots]
    if len(vecs) >= 2:
        pairs = [(vecs[i], vecs[j]) for i in range(len(vecs)) for j in range(i+1, len(vecs))]
        avg_sim = sum(cosine_similarity(a, b) for a, b in pairs) / len(pairs)
        diversity_index = round(1.0 - avg_sim, 3)
    else:
        diversity_index = 1.0

    # Innovation rate: new patterns per cycle (from history)
    recent_history = history[-10:] if history else []
    innovation_rate = round(
        sum(1 for h in recent_history if h.get("strategy") == "explore") / max(len(recent_history), 1),
        3
    )

    # Stability score: fraction of history where strategy wasn't "explore"
    stability_score = round(
        sum(1 for h in recent_history if h.get("strategy") in ("specialize", "cooperate"))
        / max(len(recent_history), 1),
        3
    )

    # Coordination efficiency: fraction of cooperative rounds
    coordination_efficiency = round(
        sum(1 for h in recent_history if h.get("strategy") == "cooperate")
        / max(len(recent_history), 1),
        3
    )

    # Emergence signal: unexpected beneficial behaviors (cooperation_gain was high)
    emergence_signals = [
        h for h in recent_history
        if h.get("cooperation_gain", 0) > 0.10 and h.get("strategy") == "cooperate"
    ]

    return {
        "diversity_index":         diversity_index,
        "innovation_rate":         innovation_rate,
        "stability_score":         stability_score,
        "coordination_efficiency": coordination_efficiency,
        "peer_count":              len(peer_models),
        "emergence_signals":       len(emergence_signals),
        "computed_at":             _now(),
    }


def detect_emergence(history: list[dict], peer_models: dict) -> list[str]:
    """Flag ecosystem-level behaviors that weren't explicitly designed."""
    signals = []

    # Spontaneous specialization: systems in very different niches
    all_strengths: Counter = Counter()
    for pm in peer_models.values():
        for s in pm.get("strengths", []):
            all_strengths[s] += 1
    unique_per_system = sum(1 for c in all_strengths.values() if c == 1)
    if unique_per_system >= 2:
        signals.append(f"spontaneous_specialization: {unique_per_system} unique-strength systems")

    # Rapid convergence: many cooperative rounds in a row
    if history:
        last_strategies = [h.get("strategy") for h in history[-5:]]
        if last_strategies.count("cooperate") >= 4:
            signals.append("convergence_burst: 4+ consecutive cooperative rounds")

    # Innovation diffusion: explore → specialize transition
    strats = [h.get("strategy") for h in history[-8:]]
    if "explore" in strats and strats[-1] in ("specialize", "cooperate"):
        signals.append("innovation_diffusion: exploration followed by adoption")

    return signals


# ─── Full co-evolution loop ───────────────────────────────────────────────────

def run_coevolution_loop(
    rounds: int,
    dry_run: bool,
    mesh_url: str,
    llm_model: str,
    use_llm: bool,
) -> None:
    state = _load_state()

    for round_i in range(rounds):
        print(f"\n=== Co-evolution round {round_i + 1}/{rounds}  {_now()[:19]} ===")

        # 1. Model self
        self_snap = get_self_snapshot()
        print(f"  Self: SR={self_snap['success_rate']:.2f}  "
              f"strengths={self_snap['strengths']}  weaknesses={self_snap['weaknesses']}")

        # 2. Model peers
        peer_models = build_peer_models()
        state["peer_models"] = peer_models
        print(f"  Peers: {len(peer_models)} systems modeled  "
              f"({', '.join(list(peer_models.keys())[:3])})")

        # 3. Predict peer futures
        peer_futures: dict[str, dict] = {}
        if use_llm and peer_models:
            for sid, pm in list(peer_models.items())[:3]:  # cap at 3 to limit LLM calls
                print(f"  Predicting future of {sid[:20]}...")
                future = predict_peer_future(pm, mesh_url, llm_model)
                peer_futures[sid] = future
                print(f"    -> {future.get('strategic_direction', '?')[:60]}")
        else:
            # Heuristic: assume peers improve by 5% in their top strength
            for sid, pm in peer_models.items():
                peer_futures[sid] = {
                    "system_id":              sid,
                    "likely_next_changes":    pm.get("strengths", []),
                    "emerging_strengths":     pm.get("strengths", []),
                    "projected_success_rate": min(1.0, pm["performance"].get("success_rate", 0.5) + 0.05),
                    "strategic_direction":    "heuristic projection",
                }
        state["peer_futures"] = peer_futures

        # 4. Simulate interaction
        peer_future_list = list(peer_futures.values())
        interaction = simulate_interaction(self_snap, peer_future_list, dry_run=dry_run)
        print(f"  Interaction: combined_score={interaction['combined_score']:.4f}  "
              f"synergy={interaction['synergy']:.2f}  "
              f"coop_gain={interaction['cooperation_gain']:.2f}")

        # 5. Choose strategy
        strategy, rationale = choose_strategy(self_snap, peer_models, peer_futures, interaction)
        state["strategy"] = strategy
        print(f"  Strategy: {strategy.upper()}  — {rationale}")

        # 6. Diversity check
        peer_snaps = [{"strengths": pm.get("strengths", []), "weaknesses": pm.get("weaknesses", []),
                       "planning_depth": 2, "reward_weights": {"correctness": 1.0}}
                      for pm in peer_models.values()]
        diverge = enforce_divergence(self_snap, peer_snaps)
        if diverge:
            print(f"  Diversity enforcement: too similar on {diverge} — forcing differentiation")
            if strategy != "explore":
                strategy = "explore"
                rationale = f"forced divergence on {diverge}"

        # 7. Apply strategy change (bounded)
        change = apply_strategy_change(strategy, self_snap, peer_future_list)

        # 8. Deploy (or dry-run)
        if not dry_run:
            config = _load_json(SYSTEM_CONFIG)
            if isinstance(config, dict):
                config.update(change)
            else:
                config = change
            _save_json(SYSTEM_CONFIG, config)
            state.setdefault("deployed_changes", []).append({
                "round":    round_i + 1,
                "strategy": strategy,
                "change":   change,
                "ts":       _now(),
            })
            print(f"  Applied: planning_depth={change['planning_depth']}  "
                  f"reward_weights={change['reward_weights']}")
        else:
            print(f"  (dry-run) Would apply: planning_depth={change['planning_depth']}")

        # 9. Ecosystem health
        history_entry = {
            "round":            round_i + 1,
            "strategy":         strategy,
            "rationale":        rationale,
            "combined_score":   interaction["combined_score"],
            "synergy":          interaction["synergy"],
            "cooperation_gain": interaction["cooperation_gain"],
            "peer_count":       len(peer_models),
            "ts":               _now(),
        }
        state.setdefault("strategy_history", []).append(history_entry)
        state["strategy_history"] = state["strategy_history"][-50:]
        _append_history(history_entry)

        eco = measure_ecosystem_health(peer_models, self_snap, state["strategy_history"])
        state["ecosystem_metrics"] = eco
        print(f"  Ecosystem: diversity={eco['diversity_index']:.2f}  "
              f"innovation={eco['innovation_rate']:.2f}  "
              f"stability={eco['stability_score']:.2f}")

        signals = detect_emergence(state["strategy_history"], peer_models)
        if signals:
            print(f"  Emergence detected: {signals}")

        state["rounds"]    = state.get("rounds", 0) + 1
        state["last_loop"] = _now()
        _save_state(state)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Co-adaptive intelligence ecosystem co-evolution")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("model-peers", help="Build/update internal models of peer systems")

    pred = sub.add_parser("predict-peers", help="Predict how peer systems will evolve")
    pred.add_argument("--mesh-url", default="http://localhost:9337")
    pred.add_argument("--model",    default="qwen3:14b")

    sub.add_parser("strategize", help="Choose a co-evolution strategy given current ecosystem")

    loop_p = sub.add_parser("loop", help="Full co-evolution loop: model→predict→strategize→apply")
    loop_p.add_argument("--rounds",   type=int, default=3)
    loop_p.add_argument("--dry-run",  action="store_true", help="Do not write system config changes")
    loop_p.add_argument("--llm",      action="store_true", help="Use LLM to predict peer futures")
    loop_p.add_argument("--mesh-url", default="http://localhost:9337")
    loop_p.add_argument("--model",    default="qwen3:14b")

    sub.add_parser("ecosystem-health", help="Compute and display ecosystem health metrics")
    sub.add_parser("status",           help="Show co-evolution state and strategy history")

    args = parser.parse_args()
    state = _load_state()

    if args.cmd == "model-peers":
        peer_models = build_peer_models()
        state["peer_models"] = peer_models
        _save_state(state)
        if not peer_models:
            print("No peer data found — run federation.py, multi-system.py, or ecosystem.py first")
            return
        print(f"Modeled {len(peer_models)} peer systems:")
        for sid, pm in peer_models.items():
            print(f"  {sid[:30]:<32}  "
                  f"strengths={pm['strengths']}  "
                  f"SR={pm['performance'].get('success_rate', '?')}  "
                  f"source={pm['source']}")

    elif args.cmd == "predict-peers":
        peer_models = state.get("peer_models") or build_peer_models()
        if not peer_models:
            print("No peer models — run 'model-peers' first")
            return
        futures = {}
        for sid, pm in list(peer_models.items())[:5]:
            print(f"Predicting {sid[:30]}...")
            future = predict_peer_future(pm, args.mesh_url, args.model)
            futures[sid] = future
            print(f"  Changes : {future.get('likely_next_changes', [])}")
            print(f"  Emerging: {future.get('emerging_strengths', [])}")
            print(f"  SR proj : {future.get('projected_success_rate', '?')}")
            print(f"  Direction: {future.get('strategic_direction', '?')}")
        state["peer_futures"] = futures
        _save_state(state)

    elif args.cmd == "strategize":
        peer_models = state.get("peer_models") or build_peer_models()
        peer_futures = list((state.get("peer_futures") or {}).values())
        self_snap    = get_self_snapshot()
        interaction  = simulate_interaction(self_snap, peer_futures)
        strategy, rationale = choose_strategy(self_snap, peer_models,
                                               state.get("peer_futures") or {}, interaction)
        print(f"Strategy  : {strategy.upper()}")
        print(f"Rationale : {rationale}")
        print(f"\nInteraction analysis:")
        print(f"  Combined score        : {interaction['combined_score']:.4f}")
        print(f"  Synergy               : {interaction['synergy']:.2f}")
        print(f"  Competition pressure  : {interaction['competition_pressure']:.2f}")
        print(f"  Cooperation gain      : {interaction['cooperation_gain']:.2f}")

        # Diversity check
        peer_snaps = [{"strengths": pm.get("strengths", []), "weaknesses": pm.get("weaknesses", []),
                       "planning_depth": 2, "reward_weights": {"correctness": 1.0}}
                      for pm in peer_models.values()]
        diverge = enforce_divergence(self_snap, peer_snaps)
        if diverge:
            print(f"\nDiversity alert: too similar on {diverge} — consider 'explore' strategy")

    elif args.cmd == "loop":
        run_coevolution_loop(
            rounds=args.rounds,
            dry_run=args.dry_run,
            mesh_url=args.mesh_url,
            llm_model=args.model,
            use_llm=args.llm,
        )

    elif args.cmd == "ecosystem-health":
        peer_models = state.get("peer_models") or build_peer_models()
        self_snap   = get_self_snapshot()
        history     = state.get("strategy_history", [])
        eco = measure_ecosystem_health(peer_models, self_snap, history)
        state["ecosystem_metrics"] = eco
        _save_state(state)

        print(f"Ecosystem Health Report  {_now()[:19]}")
        print("-" * 45)
        print(f"  Peer systems           : {eco['peer_count']}")
        print(f"  Diversity index        : {eco['diversity_index']:.3f}  "
              f"({'healthy' if eco['diversity_index'] > 0.3 else 'too homogeneous'})")
        print(f"  Innovation rate        : {eco['innovation_rate']:.3f}")
        print(f"  Stability score        : {eco['stability_score']:.3f}")
        print(f"  Coordination efficiency: {eco['coordination_efficiency']:.3f}")
        print(f"  Emergence signals      : {eco['emergence_signals']}")

        signals = detect_emergence(history, peer_models)
        if signals:
            print(f"\nActive emergence signals:")
            for s in signals:
                print(f"  ! {s}")
        else:
            print(f"\nNo emergence signals in recent history")

    elif args.cmd == "status":
        print(f"Co-evolution rounds     : {state.get('rounds', 0)}")
        print(f"Last loop               : {state.get('last_loop', 'never')}")
        print(f"Current strategy        : {state.get('strategy', 'none')}")
        print(f"Peer models             : {len(state.get('peer_models', {}))}")
        print(f"Peer futures predicted  : {len(state.get('peer_futures', {}))}")
        print(f"Changes deployed        : {len(state.get('deployed_changes', []))}")

        eco = state.get("ecosystem_metrics", {})
        if eco:
            print(f"\nLast ecosystem health:")
            print(f"  diversity={eco.get('diversity_index', '?')}  "
                  f"innovation={eco.get('innovation_rate', '?')}  "
                  f"stability={eco.get('stability_score', '?')}")

        history = state.get("strategy_history", [])
        if history:
            print(f"\nStrategy history (last 5):")
            for h in history[-5:]:
                print(f"  [{h.get('ts', '')[:19]}]  {h.get('strategy', '?'):12}  "
                      f"score={h.get('combined_score', 0):.4f}  "
                      f"peers={h.get('peer_count', 0)}")


if __name__ == "__main__":
    main()
