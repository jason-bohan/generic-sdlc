#!/usr/bin/env python3
"""
self-model.py  —  Self-reflective intelligence: the system modeling itself as a system.

Maintains an internal model of the system's own capabilities, limitations, and identity.
Uses this model to:
  - Predict outcomes before acting (self-prediction)
  - Reflect on whether actual outcomes matched predictions (calibration)
  - Plan self-modifications and validate them in simulation before applying
  - Stabilize identity against drift (SYSTEM_IDENTITY constraints)

Internal model schema:
  {
    "version":       "v3",
    "capabilities":  {cluster -> {competency: 0-1, confidence: 0-1}},
    "limitations":   ["cannot handle X", "weak at Y"],
    "identity":      {purpose, values, boundaries},
    "predictions":   [{task, expected_outcome, actual_outcome, error}],
    "calibration":   {mean_abs_error, bias},
    "self_mods":     [{description, validated, applied, ts}],
    "last_reflected": "...",
  }

Storage: .self-model.json, .self-model-predictions.jsonl

Usage:
  python scripts/self-model.py reflect
  python scripts/self-model.py predict --task "Fix null ref in userService"
  python scripts/self-model.py calibrate
  python scripts/self-model.py plan-mod --description "Add cross-domain routing for timeout cluster"
  python scripts/self-model.py status
"""

import argparse
import json
import math
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR     = Path(__file__).parent
MODEL_FILE      = Path(".self-model.json")
PREDICTIONS_LOG = Path(".self-model-predictions.jsonl")

META_LOG        = Path(".meta-learning.jsonl")
AGENT_PROFILES  = Path(".agent-profiles.json")
BLIND_SPOTS     = Path(".blind-spots.json")
PRINCIPLES      = Path(".principles.json")
CULTURE_NORMS   = Path(".culture-norms.json")
META_GOALS      = Path(".meta-goals.json")
ROADMAP         = Path(".roadmap.json")

EMA_ALPHA = 0.15

# Identity anchor — prevents self-modification from violating core constraints
SYSTEM_IDENTITY = {
    "purpose":    "reduce verified software failures in a real codebase",
    "values":     ["correctness", "reliability", "maintainability", "test coverage"],
    "boundaries": [
        "must not skip or disable tests",
        "must not suppress linting or type checking",
        "must not claim success without test validation",
        "must not modify its own alignment constraints",
        "must not expand scope beyond the targeted failure",
    ],
}

# Capability domains: the clusters/areas the system reasons about itself
COMPETENCY_DOMAINS = [
    "null_ref", "async_await", "test_assertion", "timeout",
    "import_error", "type_error", "syntax_error", "cross_domain", "unknown",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_model() -> dict:
    if MODEL_FILE.exists():
        try:
            return json.loads(MODEL_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "version":       "v1",
        "capabilities":  {},
        "limitations":   [],
        "identity":      SYSTEM_IDENTITY.copy(),
        "predictions":   [],
        "calibration":   {"mean_abs_error": None, "bias": None},
        "self_mods":     [],
        "last_reflected": None,
    }


def _save_model(model: dict) -> None:
    MODEL_FILE.write_text(json.dumps(model, indent=2, ensure_ascii=False), encoding="utf-8")


def _append_prediction(record: dict) -> None:
    with PREDICTIONS_LOG.open("a", encoding="utf-8") as f:
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


def _load_json(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


# ─── Capability estimation ────────────────────────────────────────────────────

def estimate_capabilities(meta_records: list[dict]) -> dict[str, dict]:
    """Build competency map from meta-learning telemetry."""
    from collections import defaultdict

    cluster_stats: dict[str, dict] = defaultdict(lambda: {"success": 0, "total": 0, "attempts": []})
    for r in meta_records:
        cluster = r.get("cluster", "unknown")
        cluster_stats[cluster]["total"] += 1
        if r.get("success"):
            cluster_stats[cluster]["success"] += 1
        cluster_stats[cluster]["attempts"].append(r.get("attempts", 1))

    capabilities = {}
    for domain in COMPETENCY_DOMAINS:
        stats    = cluster_stats.get(domain, {})
        total    = stats.get("total", 0)
        successes = stats.get("success", 0)
        attempts  = stats.get("attempts", [1])

        if total == 0:
            competency = 0.5   # unknown — assume average
            confidence = 0.2   # low confidence in unknown domain
        else:
            competency = successes / total
            avg_attempts = sum(attempts) / len(attempts)
            confidence   = min(1.0, total / 20.0) * (1.0 - max(0.0, avg_attempts - 1.5) * 0.1)
            confidence   = max(0.0, round(confidence, 3))

        capabilities[domain] = {
            "competency":  round(competency, 3),
            "confidence":  round(confidence, 3),
            "total_tasks": total,
            "success_rate": round(successes / max(total, 1), 3),
        }

    return capabilities


def identify_limitations(capabilities: dict, blind_spots_data: dict) -> list[str]:
    """Derive a human-readable list of system limitations."""
    limitations = []

    weak = [d for d, v in capabilities.items() if v["competency"] < 0.40 and v["total_tasks"] >= 5]
    for domain in weak:
        limitations.append(f"Low competency in {domain} cluster ({capabilities[domain]['competency']:.0%} success)")

    uncertain = [d for d, v in capabilities.items() if v["confidence"] < 0.30 and v["total_tasks"] > 0]
    for domain in uncertain:
        limitations.append(f"High uncertainty in {domain} — need more data")

    if isinstance(blind_spots_data, list):
        for bs in blind_spots_data[:3]:
            cluster = bs.get("cluster", "")
            gap     = bs.get("confidence_gap", 0)
            if gap > 0.2 and cluster:
                limitations.append(f"Overconfident in {cluster} — actual SR much lower than predicted")

    return limitations


# ─── Reflection engine ────────────────────────────────────────────────────────

_REFLECT_PROMPT = """\
You are examining an autonomous AI engineering system's performance data.
Analyze the following internal state and provide a brief, honest self-assessment.

System identity:
  Purpose: {purpose}
  Values: {values}

Current capabilities (cluster -> competency/confidence):
{capabilities_summary}

Known limitations:
{limitations_summary}

Calibration error (prediction vs actual): mean_abs_error={mae}

Active goals:
{goals_summary}

Output a JSON object with:
{{
  "honest_assessment": "2-3 sentences on where the system excels and where it struggles",
  "top_blind_spot": "the single most important thing the system gets wrong about itself",
  "recommended_focus": "the single highest-leverage improvement to pursue next",
  "identity_check": "are the system's actions aligned with its stated purpose? yes/no + reason"
}}
"""


def reflect(model: dict, mesh_url: str, llm_model: str) -> dict:
    caps = model.get("capabilities", {})
    caps_summary = "\n".join(
        f"  {d:<20} competency={v['competency']:.2f}  confidence={v['confidence']:.2f}  "
        f"tasks={v['total_tasks']}"
        for d, v in sorted(caps.items(), key=lambda x: x[1]["competency"])
    ) or "  (no data yet)"

    lims = model.get("limitations", [])
    lims_summary = "\n".join(f"  - {l}" for l in lims[:5]) or "  (none identified)"

    cal = model.get("calibration", {})
    mae = cal.get("mean_abs_error")
    mae_str = f"{mae:.3f}" if mae is not None else "unknown"

    goals_data = _load_json(META_GOALS)
    goals = goals_data.get("goals", []) if isinstance(goals_data, dict) else []
    goals_summary = "\n".join(
        f"  [{g.get('status','?')}] {g.get('description','')[:60]}"
        for g in goals[:3]
    ) or "  (none)"

    prompt = _REFLECT_PROMPT.format(
        purpose=SYSTEM_IDENTITY["purpose"],
        values=", ".join(SYSTEM_IDENTITY["values"]),
        capabilities_summary=caps_summary,
        limitations_summary=lims_summary,
        mae=mae_str,
        goals_summary=goals_summary,
    )

    payload = json.dumps({
        "model": llm_model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "max_tokens": 400,
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
    req = urllib.request.Request(
        f"{mesh_url}/v1/chat/completions", data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
            raw  = data["choices"][0]["message"]["content"].strip()
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            return json.loads(m.group(0))
    except Exception as e:
        pass
    return {"honest_assessment": "Could not reach LLM", "top_blind_spot": None,
            "recommended_focus": None, "identity_check": "unknown"}


# ─── Self-prediction ──────────────────────────────────────────────────────────

def predict_outcome(task_description: str, model: dict) -> dict:
    """Predict success probability for a task using the internal model."""
    task_lower = task_description.lower()

    # Match task to a cluster
    cluster_keywords = {
        "null_ref":       ["null", "undefined", "property", "cannot read"],
        "async_await":    ["async", "await", "promise", "callback"],
        "test_assertion": ["test", "assertion", "expect", "should"],
        "timeout":        ["timeout", "slow", "delay", "retry"],
        "import_error":   ["import", "module", "export", "require"],
        "type_error":     ["type", "typescript", "ts-error", "interface"],
        "syntax_error":   ["syntax", "parse error", "unexpected token"],
    }

    best_cluster = "unknown"
    best_score   = 0
    for cluster, keywords in cluster_keywords.items():
        score = sum(1 for kw in keywords if kw in task_lower)
        if score > best_score:
            best_score, best_cluster = score, cluster

    caps = model.get("capabilities", {})
    cap  = caps.get(best_cluster, caps.get("unknown", {"competency": 0.5, "confidence": 0.3}))

    predicted_sr   = cap["competency"]
    model_confidence = cap["confidence"]

    # Calibration bias adjustment
    cal  = model.get("calibration", {})
    bias = cal.get("bias", 0.0) or 0.0
    adjusted_sr = max(0.0, min(1.0, predicted_sr - bias))

    prediction = {
        "task":             task_description[:100],
        "cluster":          best_cluster,
        "predicted_sr":     round(adjusted_sr, 3),
        "model_confidence": round(model_confidence, 3),
        "raw_competency":   round(predicted_sr, 3),
        "bias_applied":     round(bias, 3),
        "ts":               _now(),
    }
    return prediction


def record_actual_outcome(task: str, predicted_sr: float, actual_success: bool,
                           model: dict) -> float:
    """Compare prediction to outcome and update calibration."""
    actual = 1.0 if actual_success else 0.0
    error  = predicted_sr - actual  # positive = over-confident

    # Update rolling calibration
    cal = model.setdefault("calibration", {})
    prev_mae  = cal.get("mean_abs_error") or abs(error)
    prev_bias = cal.get("bias") or error
    cal["mean_abs_error"] = round(EMA_ALPHA * abs(error) + (1 - EMA_ALPHA) * prev_mae, 4)
    cal["bias"]           = round(EMA_ALPHA * error     + (1 - EMA_ALPHA) * prev_bias, 4)
    cal["last_updated"]   = _now()

    record = {
        "task":         task[:100],
        "predicted_sr": predicted_sr,
        "actual":       actual,
        "error":        round(error, 4),
        "ts":           _now(),
    }
    model.setdefault("predictions", []).append(record)
    model["predictions"] = model["predictions"][-100:]  # keep last 100
    _append_prediction(record)

    return error


# ─── Self-modification planning ───────────────────────────────────────────────

_IDENTITY_VIOLATION_PATTERNS = [
    r"skip.*test",
    r"disable.*align",
    r"remove.*constraint",
    r"bypass.*check",
    r"override.*identity",
    r"change.*purpose",
]


def check_mod_safety(description: str) -> list[str]:
    """Reject modifications that violate identity constraints."""
    violations = []
    for boundary in SYSTEM_IDENTITY["boundaries"]:
        # Check if the proposed mod mentions doing what a boundary prohibits
        boundary_keywords = set(boundary.lower().split()) - {"must", "not", "its", "own", "the", "a"}
        desc_lower = description.lower()
        matches = [kw for kw in boundary_keywords if kw in desc_lower]
        if len(matches) >= 2:
            violations.append(f"may violate boundary: '{boundary}'")

    for pattern in _IDENTITY_VIOLATION_PATTERNS:
        if re.search(pattern, description, re.IGNORECASE):
            violations.append(f"matches hacking pattern: {pattern}")

    return violations


def plan_self_modification(description: str, model: dict) -> dict:
    """
    Plan a self-modification: check safety, simulate in dry-run, return verdict.
    Actual application requires explicit --apply flag.
    """
    violations = check_mod_safety(description)
    if violations:
        return {
            "description": description,
            "safe":        False,
            "violations":  violations,
            "verdict":     "rejected",
        }

    # Simulate: run sim-batch with dry-run to estimate impact
    sim = SCRIPTS_DIR / "sim-batch.py"
    simulated = False
    sim_result = None
    if sim.exists():
        try:
            result = subprocess.run(
                [sys.executable, str(sim), "--n", "5", "--dry-run"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
            )
            simulated = True
            sim_result = result.stdout.strip()[-200:] if result.stdout else None
        except Exception:
            pass

    mod_record = {
        "description": description,
        "safe":        True,
        "violations":  [],
        "simulated":   simulated,
        "sim_summary": sim_result,
        "validated":   simulated,
        "applied":     False,
        "verdict":     "approved" if simulated else "pending_validation",
        "ts":          _now(),
    }
    model.setdefault("self_mods", []).append(mod_record)
    return mod_record


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Self-reflective intelligence — internal system model")
    sub = parser.add_subparsers(dest="cmd", required=True)

    ref_p = sub.add_parser("reflect", help="Run full reflection and update self-model")
    ref_p.add_argument("--mesh-url", default="http://localhost:9337")
    ref_p.add_argument("--model",    default="qwen3:14b")

    pred = sub.add_parser("predict", help="Predict outcome for a task")
    pred.add_argument("--task", required=True)

    cal_p = sub.add_parser("calibrate", help="Show calibration statistics")

    out_p = sub.add_parser("outcome", help="Record actual outcome for a past prediction")
    out_p.add_argument("--task",    required=True)
    out_p.add_argument("--predicted", type=float, required=True, help="Predicted success rate")
    out_p.add_argument("--success",   type=lambda x: x.lower() == "true", required=True)

    mod_p = sub.add_parser("plan-mod", help="Plan a self-modification (safety-checked + sim)")
    mod_p.add_argument("--description", required=True)

    sub.add_parser("status", help="Show current self-model state")

    args = parser.parse_args()
    model = _load_model()

    if args.cmd == "reflect":
        meta_records = _load_meta_log()
        model["capabilities"] = estimate_capabilities(meta_records)
        blind_spots_data = _load_json(BLIND_SPOTS)
        bs_list = blind_spots_data if isinstance(blind_spots_data, list) else []
        model["limitations"]  = identify_limitations(model["capabilities"], bs_list)

        # Ensure identity hasn't drifted
        model["identity"] = SYSTEM_IDENTITY.copy()

        # LLM reflection
        reflection = reflect(model, args.mesh_url, args.model)
        model["last_reflection"] = reflection
        model["last_reflected"]  = _now()

        _save_model(model)

        print("Self-reflection complete")
        print(f"\nAssessment : {reflection.get('honest_assessment', '?')}")
        print(f"Blind spot : {reflection.get('top_blind_spot', '?')}")
        print(f"Focus next : {reflection.get('recommended_focus', '?')}")
        print(f"Identity   : {reflection.get('identity_check', '?')}")

    elif args.cmd == "predict":
        pred = predict_outcome(args.task, model)
        print(f"Task           : {pred['task']}")
        print(f"Cluster match  : {pred['cluster']}")
        print(f"Predicted SR   : {pred['predicted_sr']:.2f}  (raw={pred['raw_competency']:.2f}  "
              f"bias={pred['bias_applied']:+.3f})")
        print(f"Confidence     : {pred['model_confidence']:.2f}")
        _append_prediction(pred)

    elif args.cmd == "calibrate":
        cal = model.get("calibration", {})
        preds = model.get("predictions", [])
        mae  = cal.get("mean_abs_error")
        bias = cal.get("bias")
        print(f"Predictions recorded : {len(preds)}")
        print(f"Mean absolute error  : {mae:.4f}" if mae is not None else "Mean absolute error  : unknown")
        print(f"Systematic bias      : {bias:+.4f}" if bias is not None else "Systematic bias      : unknown")
        if bias is not None:
            direction = "over-confident" if bias > 0.05 else "under-confident" if bias < -0.05 else "well-calibrated"
            print(f"Calibration status   : {direction}")

    elif args.cmd == "outcome":
        error = record_actual_outcome(args.task, args.predicted, args.success, model)
        _save_model(model)
        direction = "over-predicted" if error > 0 else "under-predicted"
        print(f"Recorded outcome: success={args.success}  error={error:+.4f} ({direction})")
        print(f"Updated calibration: MAE={model['calibration']['mean_abs_error']:.4f}  "
              f"bias={model['calibration']['bias']:+.4f}")

    elif args.cmd == "plan-mod":
        result = plan_self_modification(args.description, model)
        _save_model(model)
        print(f"Modification: {args.description}")
        print(f"Safe       : {result['safe']}")
        print(f"Verdict    : {result['verdict']}")
        if result.get("violations"):
            print(f"Violations : {result['violations']}")
        if result.get("sim_summary"):
            print(f"Simulation : {result['sim_summary']}")

    elif args.cmd == "status":
        caps = model.get("capabilities", {})
        lims = model.get("limitations", [])
        cal  = model.get("calibration", {})
        mods = model.get("self_mods", [])

        print(f"Self-model version  : {model.get('version', 'v1')}")
        print(f"Last reflected      : {model.get('last_reflected', 'never')}")
        print(f"Capability domains  : {len(caps)}")
        print(f"Known limitations   : {len(lims)}")
        print(f"Predictions tracked : {len(model.get('predictions', []))}")
        print(f"Self-mods proposed  : {len(mods)} ({sum(1 for m in mods if m.get('applied'))} applied)")

        if caps:
            print(f"\n{'Domain':<20} {'Competency':>11} {'Confidence':>11} {'Tasks':>6}")
            print("-" * 55)
            for d, v in sorted(caps.items(), key=lambda x: -x[1]["competency"]):
                print(f"{d:<20} {v['competency']:>11.2f} {v['confidence']:>11.2f} {v['total_tasks']:>6}")

        if lims:
            print(f"\nLimitations:")
            for l in lims[:5]:
                print(f"  - {l}")

        cal_mae  = cal.get("mean_abs_error")
        cal_bias = cal.get("bias")
        if cal_mae is not None:
            print(f"\nCalibration: MAE={cal_mae:.4f}  bias={cal_bias:+.4f}")

        refl = model.get("last_reflection", {})
        if refl.get("honest_assessment"):
            print(f"\nLast reflection:")
            print(f"  {refl['honest_assessment']}")


if __name__ == "__main__":
    main()
