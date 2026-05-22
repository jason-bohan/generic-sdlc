#!/usr/bin/env python3
"""
knowledge-graph.py  —  Org-level cross-repo knowledge graph.

Maps bug patterns to fix strategies and tracks which repos applied each fix
successfully. This creates transferable institutional knowledge: a fix that
worked in billing is automatically suggested for a similar bug in dashboard.

Node schema:
  {
    "null_ref::add_null_guard": {
      "pattern":       "null_ref",
      "fix":           "add_null_guard",
      "repos":         ["SDLC Framework", "billing-service"],
      "success_count": 14,
      "total_count":   15,
      "success_rate":  0.933,
      "examples":      [{instruction, diff_excerpt, repo, success}],
    }
  }

Storage: .knowledge-graph.json

Usage:
  python scripts/knowledge-graph.py add --pattern null_ref --fix add_null_guard \\
      --repo SDLC Framework --success true --instruction "Fix null ref in agent status"
  python scripts/knowledge-graph.py query "null reference in agent"
  python scripts/knowledge-graph.py inject "Fix null ref" --top-k 3
  python scripts/knowledge-graph.py promote --threshold 0.95
  python scripts/knowledge-graph.py stats
"""

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

GRAPH_FILE = Path(".knowledge-graph.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict:
    if GRAPH_FILE.exists():
        try:
            return json.loads(GRAPH_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save(graph: dict) -> None:
    GRAPH_FILE.write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")


def _key(pattern: str, fix: str) -> str:
    return f"{pattern}::{fix}"


# ─── Graph operations ─────────────────────────────────────────────────────────

def add_node(
    graph: dict,
    pattern: str,
    fix: str,
    repo: str,
    success: bool,
    instruction: str = "",
    diff_excerpt: str = "",
) -> None:
    k = _key(pattern, fix)
    if k not in graph:
        graph[k] = {
            "pattern":       pattern,
            "fix":           fix,
            "repos":         [],
            "success_count": 0,
            "total_count":   0,
            "success_rate":  0.0,
            "examples":      [],
            "first_seen":    _now(),
            "last_updated":  _now(),
        }
    n = graph[k]
    if repo not in n["repos"]:
        n["repos"].append(repo)
    n["total_count"]   += 1
    n["success_count"] += int(success)
    n["success_rate"]   = round(n["success_count"] / n["total_count"], 3)
    n["last_updated"]   = _now()
    if len(n["examples"]) < 10 and instruction:
        n["examples"].append({
            "instruction":  instruction[:200],
            "diff_excerpt": diff_excerpt[:500],
            "repo":         repo,
            "success":      success,
        })


def query_graph(query: str, graph: dict, top_k: int = 3) -> list[dict]:
    """Find relevant nodes by token overlap against pattern + fix names."""
    query_tokens = set(re.findall(r"[a-z_]+", query.lower()))
    scored = []
    for node in graph.values():
        node_tokens = set(re.findall(r"[a-z_]+", f"{node['pattern']} {node['fix']}"))
        overlap = len(query_tokens & node_tokens)
        if overlap == 0:
            continue
        score = overlap * (0.5 + 0.5 * node["success_rate"])
        scored.append((score, node))
    scored.sort(key=lambda x: -x[0])
    return [n for _, n in scored[:top_k]]


def build_inject_block(query: str, graph: dict, top_k: int = 3) -> str:
    nodes = query_graph(query, graph, top_k)
    if not nodes:
        return ""
    lines = ["### Known solutions from org knowledge graph:\n"]
    for n in nodes:
        repos_str = ", ".join(n["repos"][:4])
        lines.append(f"**{n['pattern']} -> {n['fix']}** "
                     f"(success rate: {n['success_rate']:.0%}, repos: {repos_str})")
        if n["examples"]:
            lines.append(f"  Example: {n['examples'][0]['instruction']}")
        lines.append("")
    return "\n".join(lines)


def promote_candidates(graph: dict, threshold: float) -> list[str]:
    """Return keys of nodes ready for global promotion."""
    return [
        k for k, n in graph.items()
        if n["success_rate"] >= threshold and n["total_count"] >= 5
    ]


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Org-level knowledge graph")
    sub = parser.add_subparsers(dest="cmd", required=True)

    add = sub.add_parser("add", help="Record a fix in the graph")
    add.add_argument("--pattern",     required=True)
    add.add_argument("--fix",         required=True)
    add.add_argument("--repo",        default="SDLC Framework")
    add.add_argument("--success",     type=lambda x: x.lower() == "true", required=True)
    add.add_argument("--instruction", default="")
    add.add_argument("--diff",        default="", help="Diff file path or excerpt")

    q = sub.add_parser("query", help="Query relevant graph nodes")
    q.add_argument("query")
    q.add_argument("--top-k", type=int, default=5)

    inj = sub.add_parser("inject", help="Build inject block for a prompt")
    inj.add_argument("query")
    inj.add_argument("--top-k", type=int, default=3)

    prom = sub.add_parser("promote", help="List nodes above success-rate threshold")
    prom.add_argument("--threshold", type=float, default=0.95)

    sub.add_parser("stats", help="Graph statistics")

    args = parser.parse_args()
    graph = _load()

    if args.cmd == "add":
        diff_text = ""
        if args.diff:
            p = Path(args.diff)
            diff_text = p.read_text(encoding="utf-8", errors="replace")[:500] if p.exists() else args.diff[:500]
        add_node(graph, args.pattern, args.fix, args.repo, args.success, args.instruction, diff_text)
        _save(graph)
        print(f"Added: {_key(args.pattern, args.fix)}  success={args.success}  repo={args.repo}")

    elif args.cmd == "query":
        results = query_graph(args.query, graph, args.top_k)
        if not results:
            print("No relevant nodes found")
            return
        for n in results:
            print(f"  {n['pattern']} -> {n['fix']}  SR={n['success_rate']:.2f}  "
                  f"n={n['total_count']}  repos={n['repos']}")

    elif args.cmd == "inject":
        block = build_inject_block(args.query, graph, args.top_k)
        print(block if block else "(no relevant knowledge found)")

    elif args.cmd == "promote":
        candidates = promote_candidates(graph, args.threshold)
        if not candidates:
            print(f"No nodes above {args.threshold:.0%} threshold (need >=5 data points)")
            return
        print(f"Ready for global promotion ({args.threshold:.0%} threshold):")
        for k in candidates:
            n = graph[k]
            print(f"  {k}  SR={n['success_rate']:.2f}  n={n['total_count']}")

    elif args.cmd == "stats":
        if not graph:
            print("Graph is empty")
            return
        total_s = sum(n["success_count"] for n in graph.values())
        total_t = sum(n["total_count"]   for n in graph.values())
        all_repos: set[str] = set()
        for n in graph.values():
            all_repos.update(n["repos"])
        print(f"Nodes         : {len(graph)}")
        print(f"Total fixes   : {total_t}  ({total_s} successful, {total_s/max(total_t,1):.1%})")
        print(f"Repos covered : {len(all_repos)}  ({', '.join(sorted(all_repos)[:6])})")
        print(f"\nTop nodes by success rate:")
        for n in sorted(graph.values(), key=lambda x: -x["success_rate"])[:8]:
            print(f"  {n['pattern']:<18} -> {n['fix']:<22}  SR={n['success_rate']:.2f}  n={n['total_count']}")


if __name__ == "__main__":
    main()
