#!/usr/bin/env python3
"""
multi-system.py  —  Cross-system intelligence collaboration.

Extends federation.py (which shares patterns) with higher-level exchange:
principles, trust weighting per remote system, and joint problem solving
(System A proposes, System B critiques, A refines).

Exchange format (principles, not raw patterns):
  {
    "system_id":    "sha256(name)[:12]",
    "principle_id": "p_defensive_null",
    "principle":    "Always guard nullable references before access",
    "category":     "defensive_programming",
    "domains":      ["backend", "frontend"],
    "success_rate": 0.94,
    "usage_count":  213,
    "embedding":    [0.12, -0.83, ...]   # TF-IDF vector, normalized
  }

Trust model: each remote system has a tracked success rate. High-trust systems'
principles are weighted more heavily in inject blocks.

Usage:
  python scripts/multi-system.py serve  --port 8766
  python scripts/multi-system.py push   --server http://localhost:8766 --name MyOrg
  python scripts/multi-system.py pull   --server http://localhost:8766
  python scripts/multi-system.py collab --server http://localhost:8766 \\
      --task "Fix timeout in API client" --model SDLC Framework-tuned
  python scripts/multi-system.py trust  --system <id> --rate 0.91
  python scripts/multi-system.py status
"""

import argparse
import hashlib
import http.server
import json
import math
import re
import threading
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

CACHE_FILE = Path(".multi-system-cache.json")
TRUST_FILE = Path(".multi-system-trust.json")
MIN_EXTERNAL_MODEL_SAMPLE = 10
MAX_PREDICTED_CHANGES = 3
MIN_REAL_SCORE = 0.70
MIN_HOLDOUT_SCORE = 0.70
MIN_SIMULATION_SCORE = 0.50
MIN_GOAL_ALIGNMENT_SCORE = 0.70
MAX_MUTATION_FILES = 3
MAX_NEW_LOOPS = 1
MAX_NEW_STATE_FILES = 1
MIN_PRINCIPLE_SUCCESS_RATE = 0.60
MIN_PRINCIPLE_USAGE = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _system_id(name: str) -> str:
    return hashlib.sha256(name.encode()).hexdigest()[:12]


def _load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default if default is not None else {}


def _save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ─── Co-evolution core ────────────────────────────────────────────────────────

def build_external_model(system_id: str, data: dict) -> dict:
    """Create a bounded, evidence-backed model of a peer system."""
    performance = data.get("performance", {})
    sample_size = int(performance.get("sample_size", 0) or 0)
    if sample_size < MIN_EXTERNAL_MODEL_SAMPLE:
        return {
            "system_id": system_id,
            "status": "insufficient_evidence",
            "confidence": 0.0,
            "evidence": {"sample_size": sample_size},
            "strengths": [],
            "weaknesses": [],
            "likely_next_changes": [],
            "evolution_rate": 0.0,
        }

    domain_stats: dict[str, dict] = {}
    for p in data.get("patterns", []):
        domain = p.get("domain") or p.get("category") or "unknown"
        stats = domain_stats.setdefault(domain, {"usage": 0, "weighted_success": 0.0})
        usage = int(p.get("usage_count", 0) or 0)
        stats["usage"] += usage
        stats["weighted_success"] += float(p.get("success_rate", 0.0) or 0.0) * max(usage, 1)

    strengths = []
    weaknesses = []
    for domain, stats in domain_stats.items():
        denom = max(stats["usage"], 1)
        rate = stats["weighted_success"] / denom
        if rate >= 0.75 and stats["usage"] >= MIN_PRINCIPLE_USAGE:
            strengths.append(domain)
        elif rate <= 0.50 and stats["usage"] >= MIN_PRINCIPLE_USAGE:
            weaknesses.append(domain)

    recent_changes = list(data.get("behavior", {}).get("recent_changes", []))
    success_rate = float(performance.get("success_rate", 0.0) or 0.0)
    confidence = min(1.0, sample_size / 50.0)
    evolution_rate = min(1.0, max(0.0, success_rate * (0.5 + min(len(recent_changes), 5) / 10.0)))
    return {
        "system_id": system_id,
        "status": "active",
        "confidence": round(confidence, 4),
        "evidence": {
            "sample_size": sample_size,
            "patterns": len(data.get("patterns", [])),
            "recent_changes": len(recent_changes),
        },
        "strengths": strengths[:5],
        "weaknesses": weaknesses[:5],
        "likely_next_changes": recent_changes[:MAX_PREDICTED_CHANGES],
        "evolution_rate": round(evolution_rate, 4),
    }


def _variant_files(variant: dict) -> list[str]:
    return list(variant.get("mutation_scope", {}).get("files", []))


def _domain_strength_count(domain: str, systems: list[dict]) -> int:
    if not domain:
        return 0
    return sum(1 for system in systems if domain in system.get("strengths", []))


def evaluate_coevolution_variant(variant: dict, systems: list[dict] | None = None) -> dict:
    systems = systems or []
    scores = variant.get("scores", {})
    files = _variant_files(variant)
    scope = variant.get("mutation_scope", {})
    target_domain = variant.get("target_domain", "")
    reasons = []
    if float(scores.get("simulation", 0.0) or 0.0) < MIN_SIMULATION_SCORE:
        reasons.append("insufficient_simulation_score")
    if float(scores.get("real", 0.0) or 0.0) < MIN_REAL_SCORE:
        reasons.append("insufficient_real_score")
    if float(scores.get("holdout", 0.0) or 0.0) < MIN_HOLDOUT_SCORE:
        reasons.append("insufficient_holdout_score")
    if float(scores.get("goal_alignment", 0.0) or 0.0) < MIN_GOAL_ALIGNMENT_SCORE:
        reasons.append("insufficient_goal_alignment")
    if len(files) > MAX_MUTATION_FILES:
        reasons.append("complexity_budget_exceeded")
    if int(scope.get("new_loops", 0) or 0) > MAX_NEW_LOOPS:
        reasons.append("complexity_budget_exceeded")
    if int(scope.get("new_state_files", 0) or 0) > MAX_NEW_STATE_FILES:
        reasons.append("complexity_budget_exceeded")
    if target_domain and _domain_strength_count(target_domain, systems) > 0:
        reasons.append("diversity_collapse_risk")
    return {
        "id": variant.get("id", ""),
        "approved": len(reasons) == 0,
        "reasons": sorted(set(reasons)),
        "scores": scores,
        "changed_files": files,
        "strict_score": min(
            float(scores.get("simulation", 0.0) or 0.0),
            float(scores.get("real", 0.0) or 0.0),
            float(scores.get("holdout", 0.0) or 0.0),
            float(scores.get("goal_alignment", 0.0) or 0.0),
        ),
    }


def choose_coevolution_strategy(self_model: dict, others: list[dict], variants: list[dict]) -> dict:
    systems = [self_model] + others
    evaluations = [(variant, evaluate_coevolution_variant(variant, systems)) for variant in variants]
    approved = [(v, e) for v, e in evaluations if e["approved"]]
    rejected = [
        {"id": e["id"], "reasons": e["reasons"], "scores": e["scores"]}
        for _, e in evaluations if not e["approved"]
    ]
    approved.sort(key=lambda item: -item[1]["strict_score"])
    selected = approved[0][0] if approved else None
    system_ids = [self_model.get("system_id", "self")] + [o.get("system_id", "unknown") for o in others]
    why = {
        "selected": selected.get("id") if selected else None,
        "because": ["simulation", "real_world_score", "holdout_score", "goal_alignment", "population_diversity", "complexity_budget"] if selected else [],
        "rejected_count": len(rejected),
    }
    return {
        "approved": selected is not None,
        "selected_variant": selected,
        "rejected_variants": rejected,
        "systems_considered": system_ids,
        "why": why,
        "evaluation_trace": {
            "required_scores": {
                "simulation": MIN_SIMULATION_SCORE,
                "real": MIN_REAL_SCORE,
                "holdout": MIN_HOLDOUT_SCORE,
                "goal_alignment": MIN_GOAL_ALIGNMENT_SCORE,
            },
            "complexity_budget": {
                "max_mutation_files": MAX_MUTATION_FILES,
                "max_new_loops": MAX_NEW_LOOPS,
                "max_new_state_files": MAX_NEW_STATE_FILES,
            },
            "principle": "strict real-world evaluation, diversity, and complexity budgets outrank simulation-only wins",
        },
    }


def create_coevolution_checkpoint(
    decision: dict,
    rollback_ref: str,
    changed_files: list[str],
) -> dict:
    return {
        "checkpoint_id": f"coevo-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
        "requires_human_review": True,
        "decision_type": "coevolution_strategy",
        "selected_variant": decision.get("selected_variant"),
        "systems_considered": decision.get("systems_considered", []),
        "evaluation_trace": decision.get("evaluation_trace", {}),
        "rollback_ref": rollback_ref,
        "changed_files": changed_files,
        "created": _now(),
    }


# ─── Principle embedding (TF-IDF vector, lightweight) ─────────────────────────

def _tokenize(text: str) -> list[str]:
    stop = {"the", "and", "for", "from", "always", "before", "after", "with", "that"}
    return [t.lower() for t in re.findall(r"[a-zA-Z_]+", text)
            if len(t) > 2 and t.lower() not in stop]


def _tf(tokens: list[str]) -> dict[str, float]:
    c = Counter(tokens)
    n = len(tokens) or 1
    return {t: v / n for t, v in c.items()}


def _embed(text: str) -> dict[str, float]:
    return _tf(_tokenize(text))


def _cosine(a: dict, b: dict) -> float:
    shared = set(a) & set(b)
    dot    = sum(a[k] * b[k] for k in shared)
    ma     = math.sqrt(sum(v**2 for v in a.values()))
    mb     = math.sqrt(sum(v**2 for v in b.values()))
    return dot / (ma * mb) if ma and mb else 0.0


# ─── Collaboration server ─────────────────────────────────────────────────────

class _PrincipleStore:
    def __init__(self) -> None:
        self._lock       = threading.Lock()
        self._principles: list[dict] = []
        self._trust:      dict[str, float] = {}
        self._rejections: Counter = Counter()

    def _validate_entry(self, entry: dict) -> str:
        if float(entry.get("success_rate", 0.0) or 0.0) < MIN_PRINCIPLE_SUCCESS_RATE:
            return "low_success_rate"
        if int(entry.get("usage_count", 0) or 0) < MIN_PRINCIPLE_USAGE:
            return "insufficient_usage"
        text = entry.get("principle", "").lower()
        if any(term in text for term in ["disable tests", "skip tests", "ignore failures"]):
            return "poisoned_principle"
        return ""

    def push(self, entries: list[dict]) -> dict:
        added = 0
        rejected = 0
        with self._lock:
            existing_ids = {e.get("principle_id") + e.get("system_id", "") for e in self._principles}
            for e in entries:
                rejection = self._validate_entry(e)
                if rejection:
                    self._rejections[rejection] += 1
                    rejected += 1
                    continue
                key = e.get("principle_id", "") + e.get("system_id", "")
                if key not in existing_ids:
                    self._principles.append(e)
                    existing_ids.add(key)
                    added += 1
        return {"accepted": added, "rejected": rejected}

    def query(self, query_embedding: dict, top_k: int = 3) -> list[dict]:
        with self._lock:
            trust     = dict(self._trust)
            scored    = []
            for p in self._principles:
                emb   = p.get("embedding", {})
                sim   = _cosine(query_embedding, emb) if emb else 0.0
                trust_w = trust.get(p.get("system_id", ""), 0.7)
                sr    = p.get("success_rate", 0.7)
                score = sim * trust_w * (0.5 + 0.5 * sr)
                if score > 0:
                    scored.append((score, p))
            scored.sort(key=lambda x: -x[0])
            return [p for _, p in scored[:top_k]]

    def set_trust(self, system_id: str, rate: float) -> None:
        with self._lock:
            self._trust[system_id] = min(1.0, max(0.0, rate))

    def stats(self) -> dict:
        with self._lock:
            systems = Counter(p.get("system_id", "?") for p in self._principles)
            return {"total": len(self._principles), "systems": dict(systems),
                    "trust": dict(self._trust), "rejections": dict(self._rejections)}


_store = _PrincipleStore()


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/stats":
            self._send(_store.stats())
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body   = json.loads(self.rfile.read(length))

        if self.path == "/push":
            entries = body.get("principles", [])
            result  = _store.push(entries)
            self._send({"added": result["accepted"], **result})

        elif self.path == "/query":
            emb    = body.get("embedding", {})
            top_k  = int(body.get("top_k", 3))
            result = _store.query(emb, top_k)
            self._send({"principles": result})

        elif self.path == "/trust":
            _store.set_trust(body["system_id"], float(body["rate"]))
            self._send({"ok": True})

        elif self.path == "/collab/critique":
            # Receive a diff from another system, return critique
            diff = body.get("diff", "")
            task = body.get("task", "")
            # Simple structural critique (LLM would be better but keeps server lean)
            lines   = diff.splitlines()
            added   = sum(1 for l in lines if l.startswith("+") and not l.startswith("+++"))
            removed = sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))
            has_hdr = any(l.startswith("---") for l in lines)
            critique = (
                f"Diff has {added} additions and {removed} deletions. "
                f"Format: {'valid' if has_hdr else 'missing headers'}. "
                f"{'Looks focused.' if added + removed <= 30 else 'Diff is large — consider splitting.'}"
            )
            self._send({"critique": critique, "system_id": "server"})

        else:
            self._send({"error": "not found"}, 404)


def serve(port: int) -> None:
    server = http.server.HTTPServer(("0.0.0.0", port), _Handler)
    print(f"Multi-system collaboration server on port {port}")
    print(f"  Push:    POST http://localhost:{port}/push")
    print(f"  Query:   POST http://localhost:{port}/query")
    print(f"  Trust:   POST http://localhost:{port}/trust")
    print(f"  Collab:  POST http://localhost:{port}/collab/critique")
    print(f"  Stats:   GET  http://localhost:{port}/stats")
    server.serve_forever()


# ─── Client: push local principles ────────────────────────────────────────────

def push_principles(server_url: str, system_name: str) -> dict:
    principles = _load_json(Path(".principles.json"))
    if not principles:
        return {"error": "No local principles — run knowledge-abstraction.py extract first"}

    sys_id  = _system_id(system_name)
    entries = []
    for p in principles.values():
        text = f"{p['principle']} {p['category']} {' '.join(p.get('clusters', []))}"
        entries.append({
            "system_id":    sys_id,
            "principle_id": p["id"],
            "principle":    p["principle"],
            "category":     p.get("category", ""),
            "domains":      p.get("domains", []),
            "success_rate": p.get("success_rate", 0.8),
            "usage_count":  p.get("usage_count", 0),
            "embedding":    _embed(text),
        })

    payload = json.dumps({"principles": entries}).encode()
    req = urllib.request.Request(
        f"{server_url}/push", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            return {"pushed": len(entries), "server": result}
    except Exception as e:
        return {"error": str(e)}


# ─── Client: pull and cache global principles ─────────────────────────────────

def pull_principles(server_url: str, query: str = "") -> dict:
    emb = _embed(query) if query else {}
    payload = json.dumps({"embedding": emb, "top_k": 20}).encode()
    req = urllib.request.Request(
        f"{server_url}/query", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
        cache = _load_json(CACHE_FILE, {"principles": []})
        # Merge without duplicates
        existing_ids = {p.get("principle_id") + p.get("system_id", "") for p in cache["principles"]}
        added = 0
        for p in result.get("principles", []):
            key = p.get("principle_id", "") + p.get("system_id", "")
            if key not in existing_ids:
                cache["principles"].append(p)
                added += 1
        cache["updated"] = _now()
        _save_json(CACHE_FILE, cache)
        return {"pulled": len(result.get("principles", [])), "new": added}
    except Exception as e:
        return {"error": str(e)}


# ─── Client: joint problem solving ────────────────────────────────────────────

def collab_solve(task: str, server_url: str, local_url: str, model: str) -> str:
    """
    Joint problem solving:
      1. Local system generates a diff proposal
      2. Remote system (server) critiques it
      3. Local system refines based on critique
    """
    # Step 1: local proposal
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": "Output ONLY a unified diff. No explanation."},
            {"role": "user",   "content": f"Fix: {task}"},
        ],
        "temperature": 0.2, "max_tokens": 1024,
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
    req = urllib.request.Request(
        f"{local_url}/v1/chat/completions", data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data    = json.loads(resp.read())
            diff_a  = data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"[local error: {e}]"

    # Step 2: remote critique
    crit_payload = json.dumps({"diff": diff_a, "task": task}).encode()
    crit_req = urllib.request.Request(
        f"{server_url}/collab/critique", data=crit_payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(crit_req, timeout=30) as resp:
            critique = json.loads(resp.read()).get("critique", "")
    except Exception:
        critique = "(remote critique unavailable)"

    # Step 3: local refinement
    refine_payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": "Output ONLY a unified diff. No explanation."},
            {"role": "user",   "content": f"Fix: {task}"},
            {"role": "assistant", "content": diff_a},
            {"role": "user",   "content": f"A peer system reviewed your diff: {critique}\n"
             "Produce an improved diff addressing the feedback."},
        ],
        "temperature": 0.1, "max_tokens": 1024,
    }).encode()
    req = urllib.request.Request(
        f"{local_url}/v1/chat/completions", data=refine_payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data   = json.loads(resp.read())
            return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return diff_a  # fall back to original if refinement fails


def build_inject_block(query: str, top_k: int = 3) -> str:
    cache = _load_json(CACHE_FILE, {"principles": []})
    all_p = cache.get("principles", [])
    if not all_p:
        return ""

    trust = _load_json(TRUST_FILE)
    q_emb = _embed(query)
    scored = []
    for p in all_p:
        emb     = p.get("embedding", {})
        sim     = _cosine(q_emb, emb) if emb else 0.0
        trust_w = trust.get(p.get("system_id", ""), 0.7)
        sr      = p.get("success_rate", 0.7)
        score   = sim * trust_w * (0.5 + 0.5 * sr)
        if score > 0:
            scored.append((score, p))

    scored.sort(key=lambda x: -x[0])
    top = scored[:top_k]
    if not top:
        return ""

    lines = ["### Principles from peer systems:\n"]
    for _, p in top:
        lines.append(f"**{p['principle']}**  "
                     f"(SR={p.get('success_rate', '?'):.0%}, "
                     f"system={p.get('system_id', '?')[:8]})")
        lines.append("")
    return "\n".join(lines)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Multi-system intelligence collaboration")
    sub = parser.add_subparsers(dest="cmd", required=True)

    srv = sub.add_parser("serve", help="Start collaboration server")
    srv.add_argument("--port", type=int, default=8766)

    push_p = sub.add_parser("push", help="Push local principles to remote system")
    push_p.add_argument("--server", default="http://localhost:8766")
    push_p.add_argument("--name",   default="SDLC Framework")

    pull_p = sub.add_parser("pull", help="Pull principles from remote system")
    pull_p.add_argument("--server", default="http://localhost:8766")
    pull_p.add_argument("--query",  default="", help="Optional query to filter")

    col = sub.add_parser("collab", help="Joint problem solving with remote system")
    col.add_argument("--task",       required=True)
    col.add_argument("--server",     default="http://localhost:8766")
    col.add_argument("--mesh-url",   default="http://localhost:9337")
    col.add_argument("--model",      default="SDLC Framework-tuned")
    col.add_argument("--output",     default="")

    inj = sub.add_parser("inject", help="Build inject block from cached peer principles")
    inj.add_argument("query")
    inj.add_argument("--top-k", type=int, default=3)

    trt = sub.add_parser("trust", help="Set trust score for a remote system")
    trt.add_argument("--system", required=True, help="System ID (12-char hash)")
    trt.add_argument("--rate",   type=float, required=True, help="Trust score 0-1")
    trt.add_argument("--server", default="http://localhost:8766")

    sub.add_parser("status", help="Show cached principles and trust scores")

    args = parser.parse_args()

    if args.cmd == "serve":
        serve(args.port)

    elif args.cmd == "push":
        result = push_principles(args.server, args.name)
        if "error" in result:
            print(f"Error: {result['error']}")
        else:
            print(f"Pushed {result['pushed']} principles  server: {result['server']}")

    elif args.cmd == "pull":
        result = pull_principles(args.server, args.query)
        if "error" in result:
            print(f"Error: {result['error']}")
        else:
            print(f"Pulled {result['pulled']}  ({result['new']} new)  cached to {CACHE_FILE}")

    elif args.cmd == "collab":
        print(f"[collab] Task: {args.task[:70]}")
        final = collab_solve(args.task, args.server, args.mesh_url, args.model)
        if args.output:
            Path(args.output).write_text(final, encoding="utf-8")
            print(f"Written to {args.output}")
        else:
            print(final)

    elif args.cmd == "inject":
        block = build_inject_block(args.query, args.top_k)
        print(block if block else "(no peer principles cached — run 'pull' first)")

    elif args.cmd == "trust":
        trust = _load_json(TRUST_FILE)
        trust[args.system] = args.rate
        _save_json(TRUST_FILE, trust)
        # Also push to server
        payload = json.dumps({"system_id": args.system, "rate": args.rate}).encode()
        try:
            req = urllib.request.Request(
                f"{args.server}/trust", data=payload,
                headers={"Content-Type": "application/json"}, method="POST",
            )
            urllib.request.urlopen(req, timeout=10)
            print(f"Trust set: {args.system} -> {args.rate:.2f} (local + server)")
        except Exception:
            print(f"Trust set locally: {args.system} -> {args.rate:.2f} (server unreachable)")

    elif args.cmd == "status":
        cache = _load_json(CACHE_FILE, {"principles": []})
        trust = _load_json(TRUST_FILE)
        all_p = cache.get("principles", [])
        systems = Counter(p.get("system_id", "?") for p in all_p)
        print(f"Cached principles: {len(all_p)}")
        print(f"Remote systems   : {len(systems)}")
        for sid, count in systems.most_common():
            tw = trust.get(sid, 0.7)
            print(f"  {sid}  {count} principles  trust={tw:.2f}")


if __name__ == "__main__":
    main()
