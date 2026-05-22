#!/usr/bin/env python3
"""
cluster-failures.py  —  Classify error logs into failure clusters.

Assigns each failure log to a semantic cluster so:
  1. Training data is tagged by cluster (models learn bug patterns, not just bugs)
  2. Fix routing can target specialized models per cluster type
  3. Repeated clusters surface as recurring patterns worth training harder on

Cluster taxonomy (TypeScript/Node.js focused):
  null_ref       — null/undefined dereference
  type_mismatch  — TS type errors, wrong shape
  import_error   — missing module, bad import
  async_error    — unhandled promise, missing await
  test_assertion — test expect() mismatch
  api_mismatch   — HTTP status/shape unexpected
  timeout        — operations exceeding time limit
  syntax_error   — parse / syntax failure
  build_error    — tsc / bundler failure
  unknown        — catch-all

Usage:
  # Classify a failure log and print cluster JSON
  python scripts/cluster-failures.py --log ci_failure.txt

  # Tag existing training dataset with cluster labels
  python scripts/cluster-failures.py --tag-dataset aider_dataset.jsonl

  # Show cluster frequency in history
  python scripts/cluster-failures.py --summary
"""

import argparse
import json
import re
import sys
from pathlib import Path
from collections import Counter, defaultdict

HISTORY_FILE = Path(".failure-clusters.json")
DATASET_DEFAULT = Path("aider_dataset.jsonl")

# ─── Signature patterns ───────────────────────────────────────────────────────
# Ordered — first match wins per log.
# Each entry: (cluster_id, compiled_regex, weight)
PATTERNS: list[tuple[str, re.Pattern, float]] = []

def _p(cluster: str, pattern: str, weight: float = 1.0) -> None:
    PATTERNS.append((cluster, re.compile(pattern, re.IGNORECASE | re.MULTILINE), weight))

# null / undefined
_p("null_ref",      r"cannot read propert\w+ of (null|undefined)")
_p("null_ref",      r"TypeError: (null|undefined) is not an? \w+")
_p("null_ref",      r"is possibly '(null|undefined)'")
_p("null_ref",      r"Object is possibly 'null'")
_p("null_ref",      r"cannot destructure property .+ of '(null|undefined)'")

# TypeScript type errors
_p("type_mismatch", r"TS\d+:")
_p("type_mismatch", r"Type '.+' is not assignable to type")
_p("type_mismatch", r"Argument of type '.+' is not assignable to parameter")
_p("type_mismatch", r"Property '.+' does not exist on type")
_p("type_mismatch", r"has no initializer and is not definitely assigned")

# Import / module
_p("import_error",  r"Cannot find module")
_p("import_error",  r"Module not found")
_p("import_error",  r"SyntaxError: The requested module")
_p("import_error",  r"ERR_MODULE_NOT_FOUND")
_p("import_error",  r"does not provide an export named")

# Async / promise
_p("async_error",   r"UnhandledPromiseRejection")
_p("async_error",   r"await.*outside.*async")
_p("async_error",   r"Promise.*rejected")
_p("async_error",   r"async function.*missing await")
_p("async_error",   r"Error: Timeout .+ exceeded")

# Test assertions
_p("test_assertion", r"AssertionError")
_p("test_assertion", r"expect\(received\)\.to")
_p("test_assertion", r"Expected.*Received")
_p("test_assertion", r"FAIL.*\.test\.\w+")
_p("test_assertion", r"✗|× \d+ test.* failed")

# API / HTTP
_p("api_mismatch",  r"(4\d\d|5\d\d) [A-Z]")
_p("api_mismatch",  r"fetch.*(failed|error|refused)")
_p("api_mismatch",  r"ECONNREFUSED")
_p("api_mismatch",  r"network request failed")
_p("api_mismatch",  r"response\.ok.*false")

# Timeout
_p("timeout",       r"(operation|request|connection) timed? ?out", 0.9)
_p("timeout",       r"ETIMEDOUT")
_p("timeout",       r"TimeoutError")
_p("timeout",       r"exceeded.*\d+\s*m?s")

# Syntax
_p("syntax_error",  r"SyntaxError")
_p("syntax_error",  r"Unexpected token")
_p("syntax_error",  r"Unexpected end of (input|JSON)")

# Build
_p("build_error",   r"error TS\d+")
_p("build_error",   r"npm ERR!")
_p("build_error",   r"Build failed")
_p("build_error",   r"tsc.*(error|failed)")


# ─── Classification ───────────────────────────────────────────────────────────

def classify(log_text: str) -> dict:
    """Return cluster label + confidence for a failure log."""
    scores: dict[str, float] = defaultdict(float)

    for cluster, pattern, weight in PATTERNS:
        matches = pattern.findall(log_text)
        if matches:
            scores[cluster] += weight * min(len(matches), 5)  # cap multi-match boost

    if not scores:
        return {"cluster": "unknown", "confidence": 0.0, "scores": {}}

    total = sum(scores.values())
    best_cluster = max(scores, key=scores.__getitem__)
    confidence   = scores[best_cluster] / total if total else 0.0

    return {
        "cluster":    best_cluster,
        "confidence": round(confidence, 3),
        "scores":     {k: round(v / total, 3) for k, v in sorted(scores.items(), key=lambda x: -x[1])},
    }


# ─── History ──────────────────────────────────────────────────────────────────

def load_history() -> dict:
    if HISTORY_FILE.exists():
        try:
            return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"entries": [], "counts": {}}


def save_history(h: dict) -> None:
    HISTORY_FILE.write_text(json.dumps(h, indent=2), encoding="utf-8")


def record(result: dict, log_snippet: str) -> None:
    h = load_history()
    h["entries"].append({
        "cluster":    result["cluster"],
        "confidence": result["confidence"],
        "snippet":    log_snippet[:200],
    })
    counts = Counter(e["cluster"] for e in h["entries"])
    h["counts"] = dict(counts.most_common())
    save_history(h)


# ─── Dataset tagging ──────────────────────────────────────────────────────────

def tag_dataset(dataset_path: Path) -> int:
    """
    Re-read aider_dataset.jsonl and write a tagged version (.tagged.jsonl).
    Tags are added as _meta.cluster if the instruction text contains error signals.
    """
    tagged_path = dataset_path.with_suffix(".tagged.jsonl")
    count = 0
    with open(dataset_path, encoding="utf-8") as fin, \
         open(tagged_path, "w", encoding="utf-8") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            ex = json.loads(line)
            instruction = ex.get("instruction", "")
            result = classify(instruction)
            if result["cluster"] != "unknown":
                meta = ex.setdefault("_meta", {})
                meta["cluster"] = result["cluster"]
                meta["cluster_confidence"] = result["confidence"]
                count += 1
            fout.write(json.dumps(ex, ensure_ascii=False) + "\n")
    return count


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Classify failure logs into training clusters")
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--log",         help="Path to failure log file (or - for stdin)")
    grp.add_argument("--tag-dataset", metavar="JSONL", help="Tag all examples in a training dataset")
    grp.add_argument("--summary",     action="store_true", help="Print cluster frequency from history")

    parser.add_argument("--no-record", action="store_true", help="Do not save result to .failure-clusters.json")
    parser.add_argument("--quiet",     action="store_true", help="Print only cluster label")
    args = parser.parse_args()

    if args.summary:
        h = load_history()
        counts = h.get("counts", {})
        if not counts:
            print("No history yet.")
            return
        print(f"Failure cluster history ({sum(counts.values())} total):")
        for cluster, n in counts.items():
            bar = "█" * min(n, 40)
            pct = 100 * n // sum(counts.values())
            print(f"  {cluster:<18} {n:>4} ({pct:>2}%)  {bar}")
        return

    if args.tag_dataset:
        path = Path(args.tag_dataset)
        tagged = tag_dataset(path)
        print(f"Tagged {tagged} examples with cluster labels → {path.with_suffix('.tagged.jsonl')}")
        return

    # Classify a single log
    if args.log == "-" or not args.log:
        log_text = sys.stdin.read()
    else:
        log_text = Path(args.log).read_text(encoding="utf-8", errors="replace")

    result = classify(log_text)

    if args.quiet:
        print(result["cluster"])
    else:
        print(json.dumps(result, indent=2))

    if not args.no_record:
        record(result, log_text[:500])


if __name__ == "__main__":
    main()
