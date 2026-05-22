#!/usr/bin/env python3
"""
knowledge-abstraction.py  —  Distill experience into reusable principles.

Goes beyond storing examples: groups them by cluster, extracts abstract principles
that apply across domains, and builds a hierarchy of reusable engineering knowledge.

Example abstraction:
  raw:  "if user == null → add guard"
        "if profile == null → add guard"
        "if agentStatus == null → add guard"
  →
  principle: "Always guard nullable references before property access"
  category:  "defensive_programming"
  domains:   ["backend", "frontend", "test"]

Principle schema:
  {
    "id":           "p_defensive_null",
    "principle":    "Always guard nullable references before dereferencing",
    "category":     "defensive_programming",
    "subcategory":  "null_checking",
    "domains":      ["backend", "frontend"],
    "evidence_ids": ["ep_001", "ep_047"],
    "clusters":     ["null_ref"],
    "usage_count":  0,
    "success_rate": 1.0,
    "weight":       1.0,
  }

Hierarchy:
  defensive_programming → null_checking, input_validation, error_handling
  performance           → avoid_blocking, caching, batching
  async_patterns        → await_discipline, error_propagation, cancellation
  type_safety           → type_guards, type_annotations, generic_constraints

Storage: .principles.json

Usage:
  python scripts/knowledge-abstraction.py extract  --limit 50
  python scripts/knowledge-abstraction.py list
  python scripts/knowledge-abstraction.py inject "Fix null ref in agent status"
  python scripts/knowledge-abstraction.py record --id p_defensive_null --success true
  python scripts/knowledge-abstraction.py hierarchy
"""

import argparse
import json
import math
import re
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

PRINCIPLES_FILE = Path(".principles.json")

HIERARCHY: dict[str, list[str]] = {
    "defensive_programming": ["null_checking", "input_validation", "error_handling", "bounds_checking"],
    "async_patterns":        ["await_discipline", "error_propagation", "cancellation", "backpressure"],
    "performance":           ["avoid_blocking", "caching", "batching", "lazy_loading"],
    "type_safety":           ["type_guards", "type_annotations", "narrowing", "generic_constraints"],
    "testing":               ["assertion_precision", "isolation", "coverage", "flakiness_prevention"],
    "architecture":          ["separation_of_concerns", "dependency_injection", "single_responsibility"],
}

# Map failure clusters to hierarchy categories
CLUSTER_CATEGORY: dict[str, str] = {
    "null_ref":       "defensive_programming",
    "async_await":    "async_patterns",
    "timeout":        "async_patterns",
    "race_condition": "async_patterns",
    "type_error":     "type_safety",
    "import_error":   "architecture",
    "test_assertion": "testing",
}

CLUSTER_SUBCATEGORY: dict[str, str] = {
    "null_ref":       "null_checking",
    "async_await":    "await_discipline",
    "timeout":        "error_propagation",
    "race_condition": "cancellation",
    "type_error":     "type_guards",
    "import_error":   "separation_of_concerns",
    "test_assertion": "assertion_precision",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict:
    if PRINCIPLES_FILE.exists():
        try:
            return json.loads(PRINCIPLES_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save(principles: dict) -> None:
    PRINCIPLES_FILE.write_text(json.dumps(principles, indent=2, ensure_ascii=False), encoding="utf-8")


def _principle_id(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower())[:40].strip("_")
    return f"p_{slug}"


# ─── Extraction ───────────────────────────────────────────────────────────────

_EXTRACT_PROMPT = """\
You are distilling software engineering experience into reusable principles.

Given these fix examples for cluster "{cluster}":

{examples}

Extract ONE concise, broadly applicable engineering principle.
The principle should apply across multiple contexts, not just these specific fixes.

Output ONLY a JSON object:
{{
  "principle": "one clear actionable sentence",
  "category":  "defensive_programming | async_patterns | performance | type_safety | testing | architecture",
  "subcategory": "specific subcategory (e.g. null_checking, await_discipline)",
  "domains":   ["backend", "frontend", "test", "infra"],
  "confidence": 0.0 to 1.0
}}
"""


def call_model(prompt: str, url: str, model: str) -> str:
    payload = json.dumps({
        "model": model, "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2, "max_tokens": 512,
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
    req = urllib.request.Request(
        f"{url}/v1/chat/completions", data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"[LLM ERROR: {e}]"


def _load_evidence_by_cluster(limit: int) -> dict[str, list[str]]:
    """Load example instructions grouped by cluster from multiple sources."""
    evidence: dict[str, list[str]] = {}

    # From episodes
    ep_file = Path(".episodes.jsonl")
    if ep_file.exists():
        with ep_file.open(encoding="utf-8") as f:
            for line in f:
                try:
                    ep = json.loads(line.strip())
                    c  = ep.get("cluster", "unknown")
                    if ep.get("result") == "tests_passed":
                        evidence.setdefault(c, []).append(ep.get("task", ""))
                except Exception:
                    pass

    # From aider_dataset
    ds_file = Path("aider_dataset.jsonl")
    if ds_file.exists():
        count = 0
        with ds_file.open(encoding="utf-8") as f:
            for line in f:
                if count >= limit:
                    break
                try:
                    ex   = json.loads(line.strip())
                    meta = ex.get("_meta", {})
                    c    = meta.get("cluster", "unknown")
                    if ex.get("instruction") and meta.get("result", "") != "tests_failed":
                        evidence.setdefault(c, []).append(ex["instruction"])
                        count += 1
                except Exception:
                    pass

    return evidence


def extract_principles_for_cluster(
    cluster: str,
    examples: list[str],
    url: str,
    model: str,
    principles: dict,
) -> dict | None:
    if len(examples) < 2:
        return None

    examples_text = "\n".join(f"- {e[:120]}" for e in examples[:8])
    raw = call_model(_EXTRACT_PROMPT.format(cluster=cluster, examples=examples_text), url, model)
    m   = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except Exception:
        return None

    principle_text = data.get("principle", "").strip()
    if not principle_text:
        return None

    pid = _principle_id(principle_text)
    if pid in principles:
        # Merge evidence
        existing = principles[pid]
        existing["usage_count"] += len(examples)
        if cluster not in existing["clusters"]:
            existing["clusters"].append(cluster)
        return existing

    # Fallback category from taxonomy if LLM gave bad value
    category    = data.get("category",    CLUSTER_CATEGORY.get(cluster, "defensive_programming"))
    subcategory = data.get("subcategory", CLUSTER_SUBCATEGORY.get(cluster, ""))

    entry = {
        "id":           pid,
        "principle":    principle_text,
        "category":     category,
        "subcategory":  subcategory,
        "domains":      data.get("domains", ["backend", "frontend"]),
        "clusters":     [cluster],
        "evidence_ids": [],
        "usage_count":  len(examples),
        "success_rate": 1.0,
        "weight":       round(data.get("confidence", 0.8), 3),
        "extracted":    _now(),
    }
    principles[pid] = entry
    return entry


# ─── Retrieval ────────────────────────────────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    stop = {"the", "and", "for", "from", "this", "that", "with", "always", "before", "after"}
    return [t.lower() for t in re.findall(r"[a-zA-Z_]+", text)
            if len(t) > 2 and t.lower() not in stop]


def _tf(tokens: list[str]) -> dict[str, float]:
    c = Counter(tokens)
    n = len(tokens) or 1
    return {t: v / n for t, v in c.items()}


def _cosine(a: dict, b: dict) -> float:
    shared = set(a) & set(b)
    dot    = sum(a[k] * b[k] for k in shared)
    ma     = math.sqrt(sum(v**2 for v in a.values()))
    mb     = math.sqrt(sum(v**2 for v in b.values()))
    return dot / (ma * mb) if ma and mb else 0.0


def find_principles(query: str, principles: dict, top_k: int = 3) -> list[dict]:
    q_tf   = _tf(_tokenize(query))
    scored = []
    for p in principles.values():
        p_tf  = _tf(_tokenize(f"{p['principle']} {p['category']} {' '.join(p['clusters'])}"))
        sim   = _cosine(q_tf, p_tf)
        score = sim * (0.5 + 0.5 * p["success_rate"]) * p["weight"]
        if score > 0:
            scored.append((score, p))
    scored.sort(key=lambda x: -x[0])
    return [p for _, p in scored[:top_k]]


def build_inject_block(query: str, principles: dict, top_k: int = 3) -> str:
    relevant = find_principles(query, principles, top_k)
    if not relevant:
        return ""
    lines = ["### Engineering principles from accumulated experience:\n"]
    for p in relevant:
        lines.append(f"**{p['principle']}**")
        lines.append(f"  Category: {p['category']} / {p['subcategory']}  "
                     f"SR={p['success_rate']:.0%}  uses={p['usage_count']}")
        lines.append("")
    return "\n".join(lines)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Knowledge abstraction: extract reusable principles")
    sub = parser.add_subparsers(dest="cmd", required=True)

    ext = sub.add_parser("extract", help="Extract principles from accumulated evidence")
    ext.add_argument("--limit",    type=int, default=200, help="Max evidence items to read")
    ext.add_argument("--mesh-url", default="http://localhost:9337")
    ext.add_argument("--model",    default="qwen3:14b")

    sub.add_parser("list",      help="List all principles by success rate")

    inj = sub.add_parser("inject", help="Build inject block for a prompt")
    inj.add_argument("query")
    inj.add_argument("--top-k", type=int, default=3)

    rec = sub.add_parser("record", help="Record outcome for a principle usage")
    rec.add_argument("--id",      required=True)
    rec.add_argument("--success", type=lambda x: x.lower() == "true", required=True)

    sub.add_parser("hierarchy", help="Show principle hierarchy")

    args = parser.parse_args()
    principles = _load()

    if args.cmd == "extract":
        evidence = _load_evidence_by_cluster(args.limit)
        if not evidence:
            print("No evidence found — run fix-pipeline.py or collect-training-data.py first")
            return
        print(f"Evidence loaded: {sum(len(v) for v in evidence.values())} items "
              f"across {len(evidence)} clusters")
        added = 0
        for cluster, examples in evidence.items():
            if len(examples) < 2:
                continue
            print(f"  Extracting principle for '{cluster}' ({len(examples)} examples)...")
            p = extract_principles_for_cluster(cluster, examples, args.mesh_url, args.model, principles)
            if p:
                print(f"    -> [{p['category']}] {p['principle'][:70]}")
                added += 1
        _save(principles)
        print(f"\nExtracted/updated {added} principles -> {PRINCIPLES_FILE}")

    elif args.cmd == "list":
        if not principles:
            print("No principles yet — run 'extract' first")
            return
        print(f"{'ID':<36} {'SR':>5} {'Uses':>5} {'Category':<22}  Principle")
        print("-" * 90)
        for p in sorted(principles.values(), key=lambda x: -x["success_rate"] * x["weight"]):
            print(f"{p['id']:<36} {p['success_rate']:>5.2f} {p['usage_count']:>5} "
                  f"{p['category']:<22}  {p['principle'][:50]}")

    elif args.cmd == "inject":
        block = build_inject_block(args.query, principles, args.top_k)
        print(block if block else "(no relevant principles found)")

    elif args.cmd == "record":
        p = principles.get(args.id)
        if not p:
            print(f"Not found: {args.id}")
            return
        ALPHA = 0.1
        p["success_rate"] = (1 - ALPHA) * p["success_rate"] + ALPHA * float(args.success)
        p["usage_count"]  += 1
        p["weight"]        = round(0.5 + 0.5 * p["success_rate"], 3)
        _save(principles)
        print(f"Updated {args.id}: sr={p['success_rate']:.3f}  weight={p['weight']:.3f}")

    elif args.cmd == "hierarchy":
        if not principles:
            print("No principles yet")
            return
        by_cat: dict[str, list] = {}
        for p in principles.values():
            by_cat.setdefault(p["category"], []).append(p)
        for category, children in sorted(HIERARCHY.items()):
            cat_principles = by_cat.get(category, [])
            print(f"{category} ({len(cat_principles)} principles)")
            for sub_cat in children:
                sub_ps = [p for p in cat_principles if p.get("subcategory") == sub_cat]
                if sub_ps:
                    for p in sub_ps:
                        print(f"  [{sub_cat}] {p['principle'][:70]}")
                        print(f"    SR={p['success_rate']:.2f}  uses={p['usage_count']}  "
                              f"clusters={p['clusters']}")
            print()


if __name__ == "__main__":
    main()
