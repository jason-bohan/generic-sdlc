#!/usr/bin/env python3
"""
ecosystem.py  —  Ecosystem-level coordination: multiple orgs/systems evolving together.

Runs an HTTP coordination server that lets multiple instances of the Meitheal
system publish abstracted state snapshots and receive global trend signals.
No raw code or diffs are shared — only statistical aggregates and normalized patterns.

Coordination server API:
  POST /publish      — publish this system's abstracted state
  GET  /trends       — retrieve global trends across all publishers
  POST /experiment   — register a shared experiment
  GET  /experiment   — retrieve results from a shared experiment

State published (abstracted, no PII or raw code):
  {
    "system_id":         "sha256-of-org-id",
    "top_failure_types": ["null_ref", "async_await"],
    "emerging_patterns": ["defensive_null_check", "explicit_await"],
    "performance_trend": +0.12,   -- delta success rate vs last publish
    "model_in_use":      "qwen3:8b",
    "ts":                "...",
  }

Storage: .ecosystem-state.json, .ecosystem-cache.json, .ecosystem-experiments.json

Usage:
  python scripts/ecosystem.py serve --port 8767
  python scripts/ecosystem.py publish --ecosystem-url http://localhost:8767
  python scripts/ecosystem.py trends  --ecosystem-url http://localhost:8767
  python scripts/ecosystem.py experiment register --name "sparse_attention_routing" --hypothesis "..."
  python scripts/ecosystem.py experiment results  --name "sparse_attention_routing"
  python scripts/ecosystem.py status
"""

import argparse
import hashlib
import json
import math
import threading
import urllib.request
from collections import defaultdict, Counter
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPTS_DIR    = Path(__file__).parent
STATE_FILE     = Path(".ecosystem-state.json")
CACHE_FILE     = Path(".ecosystem-cache.json")
EXPERIMENTS_FILE = Path(".ecosystem-experiments.json")

META_LOG       = Path(".meta-learning.jsonl")
AGENT_PROFILES = Path(".agent-profiles.json")
MODEL_POOL     = Path(".model-pool.json")
BLIND_SPOTS    = Path(".blind-spots.json")

MAX_PUBLISHERS = 100  # cap stored publisher snapshots


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_id(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _load_json(path: Path) -> dict | list:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_json(path: Path, data: dict | list) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


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


# ─── Local state abstraction ──────────────────────────────────────────────────

def build_local_abstract_state(system_id: str) -> dict:
    """Collect telemetry and reduce to a safe, abstracted state snapshot."""
    records = _load_meta_log()

    # Top failure types
    failure_clusters: Counter = Counter()
    for r in records[-200:]:  # last 200 records only
        if not r.get("success"):
            failure_clusters[r.get("cluster", "unknown")] += 1
    top_failures = [c for c, _ in failure_clusters.most_common(3)]

    # Emerging patterns from principles file
    principles_data = _load_json(PRINCIPLES_FILE if (PRINCIPLES_FILE := Path(".principles.json")).exists() else Path("/nonexistent"))
    principles = principles_data.get("principles", []) if isinstance(principles_data, dict) else []
    emerging_patterns = [
        p.get("name", "")[:40]
        for p in sorted(principles, key=lambda x: -x.get("weight", 0))[:3]
        if p.get("name")
    ]

    # Performance trend
    performance_trend = 0.0
    if len(records) >= 20:
        mid = len(records) // 2
        early_sr = sum(1 for r in records[:mid] if r.get("success")) / max(mid, 1)
        late_sr  = sum(1 for r in records[mid:] if r.get("success")) / max(len(records) - mid, 1)
        performance_trend = round(late_sr - early_sr, 3)

    # Model in use
    model_pool = _load_json(Path(".model-pool.json"))
    candidates = model_pool.get("candidates", []) if isinstance(model_pool, dict) else []
    model_in_use = candidates[0].get("model", "unknown") if candidates else "unknown"

    return {
        "system_id":         system_id,
        "top_failure_types": top_failures,
        "emerging_patterns": emerging_patterns,
        "performance_trend": performance_trend,
        "model_in_use":      model_in_use,
        "record_count":      len(records),
        "ts":                _now(),
    }


# ─── Trend analysis ───────────────────────────────────────────────────────────

def compute_global_trends(publishers: list[dict]) -> dict:
    """Aggregate published states into global trend signals."""
    if not publishers:
        return {"publishers": 0}

    # Global failure distribution
    all_failures: Counter = Counter()
    for p in publishers:
        for f in p.get("top_failure_types", []):
            all_failures[f] += 1

    # Global emerging patterns
    all_patterns: Counter = Counter()
    for p in publishers:
        for pat in p.get("emerging_patterns", []):
            all_patterns[pat] += 1

    # Average performance trend
    trends = [p.get("performance_trend", 0.0) for p in publishers]
    avg_trend = sum(trends) / len(trends) if trends else 0.0

    # Model adoption
    models: Counter = Counter(p.get("model_in_use", "unknown") for p in publishers)

    # Consensus failures (seen by >= 50% of publishers)
    threshold = max(2, len(publishers) // 2)
    consensus_failures = [f for f, n in all_failures.most_common() if n >= threshold]

    return {
        "publishers":          len(publishers),
        "global_failure_freq": dict(all_failures.most_common(5)),
        "global_patterns":     dict(all_patterns.most_common(5)),
        "avg_performance_trend": round(avg_trend, 4),
        "model_adoption":      dict(models.most_common()),
        "consensus_failures":  consensus_failures,
        "computed_at":         _now(),
    }


def build_coordinated_adaptation(trends: dict) -> list[str]:
    """Generate ecosystem-level adaptation recommendations."""
    recommendations = []
    avg = trends.get("avg_performance_trend", 0)
    if avg < -0.05:
        recommendations.append(
            "Ecosystem-wide performance regressing — consider rolling back recent model changes"
        )
    if avg > 0.10:
        recommendations.append(
            "Ecosystem performance improving — promote current strategy to principle library"
        )
    consensus = trends.get("consensus_failures", [])
    if consensus:
        recommendations.append(
            f"Consensus failures across {trends['publishers']} systems: {consensus} — prioritize these clusters"
        )
    top_pattern = next(iter(trends.get("global_patterns", {})), None)
    if top_pattern:
        recommendations.append(
            f"Dominant emerging pattern: '{top_pattern}' — integrate into local principle library"
        )
    return recommendations


# ─── Experiment coordination ──────────────────────────────────────────────────

def register_experiment(experiments: dict, name: str, hypothesis: str, system_id: str) -> dict:
    if name in experiments:
        return experiments[name]
    exp = {
        "name":        name,
        "hypothesis":  hypothesis,
        "registered_by": system_id,
        "participants": [],
        "results":     [],
        "status":      "open",
        "created":     _now(),
    }
    experiments[name] = exp
    return exp


def submit_experiment_result(experiments: dict, name: str, system_id: str,
                              outcome: float, notes: str = "") -> bool:
    if name not in experiments:
        return False
    exp = experiments[name]
    exp["participants"].append(system_id)
    exp["results"].append({
        "system_id": system_id,
        "outcome":   outcome,
        "notes":     notes[:200],
        "ts":        _now(),
    })
    if len(exp["results"]) >= 3:
        avg = sum(r["outcome"] for r in exp["results"]) / len(exp["results"])
        exp["consensus_outcome"] = round(avg, 3)
        exp["status"] = "concluded" if avg > 0.6 else "inconclusive"
    return True


# ─── HTTP Server ──────────────────────────────────────────────────────────────

class _EcosystemStore:
    def __init__(self) -> None:
        self._lock       = threading.Lock()
        self._publishers: list[dict] = []
        self._experiments: dict      = {}

    def publish(self, snapshot: dict) -> dict:
        with self._lock:
            # Remove existing entry for this system_id (keep latest)
            sid = snapshot.get("system_id", "")
            self._publishers = [p for p in self._publishers if p.get("system_id") != sid]
            self._publishers.append(snapshot)
            if len(self._publishers) > MAX_PUBLISHERS:
                self._publishers = self._publishers[-MAX_PUBLISHERS:]
            trends = compute_global_trends(self._publishers)
            return trends

    def get_trends(self) -> dict:
        with self._lock:
            return compute_global_trends(self._publishers)

    def register_experiment(self, name: str, hypothesis: str, system_id: str) -> dict:
        with self._lock:
            return register_experiment(self._experiments, name, hypothesis, system_id)

    def submit_result(self, name: str, system_id: str, outcome: float, notes: str) -> bool:
        with self._lock:
            return submit_experiment_result(self._experiments, name, system_id, outcome, notes)

    def get_experiment(self, name: str) -> dict | None:
        with self._lock:
            return self._experiments.get(name)

    def list_experiments(self) -> list[dict]:
        with self._lock:
            return list(self._experiments.values())


_STORE = _EcosystemStore()


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence request logs
        pass

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def _send(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self._read_body()
        if self.path == "/publish":
            trends = _STORE.publish(body)
            self._send({"ok": True, "trends": trends})
        elif self.path == "/experiment/register":
            exp = _STORE.register_experiment(
                body.get("name", ""),
                body.get("hypothesis", ""),
                body.get("system_id", "unknown"),
            )
            self._send(exp)
        elif self.path == "/experiment/result":
            ok = _STORE.submit_result(
                body.get("name", ""),
                body.get("system_id", "unknown"),
                float(body.get("outcome", 0.5)),
                body.get("notes", ""),
            )
            self._send({"ok": ok})
        else:
            self._send({"error": "not found"}, 404)

    def do_GET(self):
        if self.path == "/trends":
            self._send(_STORE.get_trends())
        elif self.path.startswith("/experiment?"):
            name = self.path.split("name=")[-1].split("&")[0]
            exp  = _STORE.get_experiment(name)
            self._send(exp or {"error": "not found"}, 200 if exp else 404)
        elif self.path == "/experiments":
            self._send({"experiments": _STORE.list_experiments()})
        elif self.path == "/health":
            self._send({"status": "ok", "publishers": len(_STORE._publishers)})
        else:
            self._send({"error": "not found"}, 404)


# ─── Client helpers ───────────────────────────────────────────────────────────

def _post(url: str, data: dict) -> dict:
    payload = json.dumps(data).encode()
    req = urllib.request.Request(url, data=payload,
                                  headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read())


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Ecosystem-level coordination server and client")
    sub = parser.add_subparsers(dest="cmd", required=True)

    srv = sub.add_parser("serve", help="Run coordination server")
    srv.add_argument("--port", type=int, default=8767)

    pub = sub.add_parser("publish", help="Publish local state to ecosystem")
    pub.add_argument("--ecosystem-url", default="http://localhost:8767")
    pub.add_argument("--system-id",     default="")

    sub.add_parser("status", help="Show local ecosystem cache")

    trn = sub.add_parser("trends", help="Retrieve global trends")
    trn.add_argument("--ecosystem-url", default="http://localhost:8767")

    exp_p = sub.add_parser("experiment", help="Manage shared experiments")
    exp_sub = exp_p.add_subparsers(dest="exp_cmd", required=True)

    reg = exp_sub.add_parser("register")
    reg.add_argument("--name",       required=True)
    reg.add_argument("--hypothesis", required=True)
    reg.add_argument("--ecosystem-url", default="http://localhost:8767")
    reg.add_argument("--system-id",     default="")

    res = exp_sub.add_parser("results")
    res.add_argument("--name",          required=True)
    res.add_argument("--ecosystem-url", default="http://localhost:8767")

    sub_result = exp_sub.add_parser("submit")
    sub_result.add_argument("--name",          required=True)
    sub_result.add_argument("--outcome",        type=float, required=True)
    sub_result.add_argument("--notes",          default="")
    sub_result.add_argument("--ecosystem-url",  default="http://localhost:8767")
    sub_result.add_argument("--system-id",      default="")

    args = parser.parse_args()

    if args.cmd == "serve":
        server = HTTPServer(("0.0.0.0", args.port), _Handler)
        print(f"Ecosystem coordination server on port {args.port}")
        print("  POST /publish          — publish system state")
        print("  GET  /trends           — global trends")
        print("  POST /experiment/register — register experiment")
        print("  POST /experiment/result   — submit result")
        server.serve_forever()

    elif args.cmd == "publish":
        system_id = args.system_id or _hash_id(str(Path.cwd()))
        snapshot  = build_local_abstract_state(system_id)
        try:
            result = _post(f"{args.ecosystem_url}/publish", snapshot)
            trends = result.get("trends", {})
            _save_json(CACHE_FILE, {"snapshot": snapshot, "trends": trends, "ts": _now()})
            print(f"Published state to ecosystem (system_id={system_id[:8]}...)")
            if trends:
                print(f"  Global publishers     : {trends.get('publishers', 0)}")
                print(f"  Avg performance trend : {trends.get('avg_performance_trend', 0):+.3f}")
                print(f"  Consensus failures    : {trends.get('consensus_failures', [])}")
        except Exception as e:
            print(f"Could not reach ecosystem server: {e}")
            print(f"Local state: top_failures={snapshot['top_failure_types']}  "
                  f"trend={snapshot['performance_trend']:+.3f}")

    elif args.cmd == "trends":
        try:
            trends = _get(f"{args.ecosystem_url}/trends")
            print(json.dumps(trends, indent=2))
            recs = build_coordinated_adaptation(trends)
            if recs:
                print("\nAdaptation recommendations:")
                for r in recs:
                    print(f"  - {r}")
        except Exception as e:
            print(f"Could not reach ecosystem server: {e}")
            cached = _load_json(CACHE_FILE)
            if isinstance(cached, dict) and cached.get("trends"):
                print("Showing cached trends:")
                print(json.dumps(cached["trends"], indent=2))

    elif args.cmd == "status":
        cache = _load_json(CACHE_FILE)
        if not cache:
            print("No ecosystem cache — run 'publish' first")
            return
        snap   = cache.get("snapshot", {})
        trends = cache.get("trends", {})
        print(f"Last publish : {cache.get('ts', 'unknown')}")
        print(f"System ID    : {snap.get('system_id', '?')[:16]}...")
        print(f"Top failures : {snap.get('top_failure_types', [])}")
        print(f"Trend        : {snap.get('performance_trend', 0):+.3f}")
        if trends:
            print(f"\nGlobal trends (cached):")
            print(f"  Publishers   : {trends.get('publishers', 0)}")
            print(f"  Global avg   : {trends.get('avg_performance_trend', 0):+.3f}")
            print(f"  Consensus    : {trends.get('consensus_failures', [])}")

    elif args.cmd == "experiment":
        system_id = getattr(args, "system_id", "") or _hash_id(str(Path.cwd()))
        url = args.ecosystem_url

        if args.exp_cmd == "register":
            try:
                exp = _post(f"{url}/experiment/register", {
                    "name": args.name, "hypothesis": args.hypothesis, "system_id": system_id,
                })
                print(f"Registered experiment: {args.name}")
                print(f"  Status: {exp.get('status')}")
            except Exception as e:
                print(f"Error: {e}")

        elif args.exp_cmd == "results":
            try:
                exp = _get(f"{url}/experiment?name={args.name}")
                print(json.dumps(exp, indent=2))
            except Exception as e:
                print(f"Error: {e}")

        elif args.exp_cmd == "submit":
            try:
                result = _post(f"{url}/experiment/result", {
                    "name": args.name, "system_id": system_id,
                    "outcome": args.outcome, "notes": args.notes,
                })
                print(f"Submitted result: outcome={args.outcome}  ok={result.get('ok')}")
            except Exception as e:
                print(f"Error: {e}")


if __name__ == "__main__":
    main()
