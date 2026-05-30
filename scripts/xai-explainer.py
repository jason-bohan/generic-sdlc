#!/usr/bin/env python3
"""
xai-explainer.py  —  SHAP-based explainability engine for synthetic customer profiles.

Accepts JSON via stdin with:
  { "profiles": [ ... ], "featureNames": [...], "decisionFn": "string|json" }

The decisionFn can be:
  - A string expression like "income > 50000 and dti < 0.43"
  - A JSON list of rules: [{"feature": "income", "op": ">", "value": 50000}, ...]

Outputs JSON with per-profile SHAP values, feature importance, and reason codes.

Usage:
  echo '{"profiles":[...],"featureNames":[...],"decisionFn":"income > 50000"}' \\
    | python3 scripts/xai-explainer.py

  cat profiles.json | python3 scripts/xai-explainer.py
"""

import json
import sys
import traceback
from typing import Any


def parse_decision_fn(raw: Any):
    if callable(raw):
        return raw
    if isinstance(raw, str):
        def str_fn(p: dict) -> bool:
            try:
                safe: dict[str, float] = {k: float(v) for k, v in p.items()
                                          if isinstance(v, (int, float))}
                return bool(eval(raw, {"__builtins__": {}}, safe))
            except Exception:
                return False
        return str_fn
    if isinstance(raw, list):
        def rule_fn(p: dict) -> bool:
            try:
                for rule in raw:
                    fv = float(p.get(rule.get("feature", ""), 0))
                    op = rule.get("op", ">")
                    target = float(rule.get("value", 0))
                    if op == ">" and not (fv > target):
                        return False
                    if op == ">=" and not (fv >= target):
                        return False
                    if op == "<" and not (fv < target):
                        return False
                    if op == "<=" and not (fv <= target):
                        return False
                    if op == "==" and not (fv == target):
                        return False
                    if op == "!=" and not (fv != target):
                        return False
                return True
            except Exception:
                return False
        return rule_fn
    return lambda p: True


def compute_shap_values(feature_matrix: list[list[float]],
                        feature_names: list[str],
                        decision_fn,
                        n_samples: int = 100):
    import numpy as np
    from sklearn.preprocessing import StandardScaler
    import shap

    X = np.array(feature_matrix, dtype=np.float64)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    n = min(n_samples, len(X_scaled))
    sample = X_scaled[:n]
    background = X_scaled[:min(50, len(X_scaled))]

    def model_fn(x: np.ndarray) -> np.ndarray:
        out = np.zeros(x.shape[0])
        for i in range(x.shape[0]):
            profile = {fn: float(x[i, j]) for j, fn in enumerate(feature_names)}
            out[i] = 1.0 if decision_fn(profile) else 0.0
        return out

    explainer = shap.KernelExplainer(model_fn, background)
    shap_values = explainer.shap_values(sample, nsamples=100)
    expected_value = float(explainer.expected_value)

    return sample, shap_values, expected_value, scaler


def build_waterfall(feature_names: list[str],
                    base_value: float,
                    shap_row,
                    feature_row: list[float]) -> dict:
    contributions = list(zip(feature_names, shap_row, feature_row))
    contributions_sorted = sorted(contributions, key=lambda c: abs(c[1]), reverse=True)

    top_features = []
    for name, sv, fv in contributions_sorted[:5]:
        direction = "increases" if sv > 0 else "decreases"
        top_features.append({
            "feature": name,
            "shapValue": round(float(sv), 4),
            "featureValue": round(float(fv), 4),
            "impact": direction,
            "magnitude": abs(round(float(sv), 4)),
        })

    prediction = 1.0 if sum(shap_row) + base_value > 0.5 else 0.0

    reason_codes = []
    for item in top_features[:3]:
        code = f"{item['feature']}_{'HIGH' if item['impact'] == 'increases' else 'LOW'}"
        reason_codes.append({
            "code": code,
            "feature": item['feature'],
            "reason": (f"Customer {item['feature']} ({item['featureValue']}) "
                       f"{item['impact']} approval likelihood "
                       f"(SHAP: {item['shapValue']:+.4f})"),
        })

    return {
        "prediction": bool(prediction),
        "baseValue": round(float(base_value), 4),
        "topContributors": top_features,
        "reasonCodes": reason_codes,
    }


def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            print(json.dumps({"error": "No input provided", "status": "error"}))
            return 1

        data = json.loads(raw)
        profiles = data.get("profiles", [])
        feature_names = data.get("featureNames", [])
        decision_fn_raw = data.get("decisionFn", "true")
        n_samples = min(data.get("nSamples", 100), len(profiles))

        if not profiles:
            print(json.dumps({"error": "No profiles provided", "status": "error"}))
            return 1

        if not feature_names and profiles:
            feature_names = [k for k in profiles[0].keys()
                             if isinstance(profiles[0][k], (int, float))
                             and k != "id"]
            if not feature_names:
                print(json.dumps({"error": "No numeric features found",
                                  "status": "error"}))
                return 1

        decision_fn = parse_decision_fn(decision_fn_raw)
        feature_matrix = [[float(p.get(fn, 0)) for fn in feature_names]
                          for p in profiles]

        import numpy as np
        import shap  # noqa: F811

        X_scaled, shap_vals, base_value, _ = compute_shap_values(
            feature_matrix, feature_names, decision_fn, n_samples)

        explanations = []
        for i in range(min(n_samples, len(profiles))):
            sv_row = shap_vals[i] if shap_vals.ndim == 2 else shap_vals[0][i]
            fv_row = feature_matrix[i]
            water = build_waterfall(feature_names, base_value,
                                    sv_row, fv_row)
            explanations.append({
                "profileIndex": i,
                "profileId": profiles[i].get("id", i),
                **water,
            })

        shap_abs = np.abs(shap_vals).mean(axis=0)
        feature_importance = {}
        for j, fn in enumerate(feature_names):
            feature_importance[fn] = round(float(shap_abs[j]), 4)

        reason_code_map = {}
        sorted_features = sorted(feature_importance.items(),
                                 key=lambda x: x[1], reverse=True)
        for rank, (fn, _) in enumerate(sorted_features[:10]):
            reason_code_map[f"{fn}_HIGH"] = f"High {fn} increases approval score"
            reason_code_map[f"{fn}_LOW"] = f"Low {fn} decreases approval score"

        output = {
            "status": "ok",
            "modelType": "shap_kernel_explainer",
            "featureNames": feature_names,
            "featureImportance": feature_importance,
            "baseValue": round(base_value, 4),
            "explanations": explanations,
            "reasonCodeMap": reason_code_map,
            "nProfiles": len(profiles),
            "nExplained": len(explanations),
        }

        print(json.dumps(output))
        return 0

    except ImportError as e:
        missing = str(e).split("'")[1] if "'" in str(e) else str(e)
        print(json.dumps({
            "status": "missing_dependency",
            "error": f"Python package '{missing}' is not installed. "
                     f"Run: pip install -r scripts/requirements-xai.txt",
            "missingPackage": missing,
        }))
        return 0

    except Exception:
        print(json.dumps({
            "status": "error",
            "error": traceback.format_exc(),
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
