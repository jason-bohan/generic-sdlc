#!/usr/bin/env python3
"""
episodic-memory.py  —  Long-term experience storage and retrieval across tasks.

Unlike the skill library (semantic patterns) and pattern library (structural
similarity), episodic memory stores WHAT HAPPENED: the sequence of steps,
what files were touched, what the outcome was, and why it worked.

At runtime: retrieve the most relevant past episodes and inject them as
concrete examples of "here is what worked before for a similar problem."

Episode schema:
  {
    "id":            "ep_20260519_143022",
    "task":          "Fix null ref in spawn-agent.ts",
    "cluster":       "null_ref",
    "context_files": ["src/server/spawn-agent.ts"],
    "steps":         ["read file", "add null guard at line 94"],
    "diff":          "...",
    "result":        "tests_passed",
    "confidence":    0.82,
    "model_used":    "meitheal-tuned",
    "attempts":      1,
    "time_s":        8.4,
    "skills":        ["add_null_guard"],
    "timestamp":     "2026-05-19T14:30:22Z"
  }

Storage: .episodes.jsonl (append-only, one JSON per line)
Index:   .episode-index.json (rebuilt on demand for fast retrieval)

Usage:
  python scripts/episodic-memory.py add \\
      --task "Fix null ref" --cluster null_ref --result tests_passed \\
      --diff path/to/fix.diff --files "src/server/spawn-agent.ts" \\
      --model meitheal-tuned --time 8.4 --attempts 1

  python scripts/episodic-memory.py search "null reference in agent status"
  python scripts/episodic-memory.py inject "Fix timeout in API client" --top-k 2
  python scripts/episodic-memory.py chain null_ref --depth 3
  python scripts/episodic-memory.py stats
"""

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

EPISODES_FILE = Path(".episodes.jsonl")
INDEX_FILE    = Path(".episode-index.json")

# ─── I/O ──────────────────────────────────────────────────────────────────────

def _append(record: dict) -> None:
    with EPISODES_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _load_all() -> list[dict]:
    if not EPISODES_FILE.exists():
        return []
    episodes = []
    with EPISODES_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    episodes.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return episodes


# ─── TF-IDF retrieval (no external deps) ─────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    tokens = re.findall(r"[a-zA-Z_][a-zA-Z0-9_]+", text.lower())
    STOP = {"the", "and", "for", "from", "this", "that", "with", "have", "will",
            "fix", "add", "update", "change", "make", "use", "get", "set"}
    return [t for t in tokens if t not in STOP and len(t) > 2]


def _tf(tokens: list[str]) -> dict[str, float]:
    c = Counter(tokens)
    n = len(tokens) or 1
    return {t: v / n for t, v in c.items()}


def _idf(corpus: list[list[str]]) -> dict[str, float]:
    N = len(corpus)
    df: dict[str, int] = defaultdict(int)
    for doc in corpus:
        for t in set(doc):
            df[t] += 1
    return {t: math.log((N + 1) / (c + 1)) for t, c in df.items()}


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    shared = set(a) & set(b)
    dot   = sum(a[k] * b[k] for k in shared)
    mag_a = math.sqrt(sum(v**2 for v in a.values()))
    mag_b = math.sqrt(sum(v**2 for v in b.values()))
    if not mag_a or not mag_b:
        return 0.0
    return dot / (mag_a * mag_b)


def _ep_text(ep: dict) -> str:
    """Concatenate all searchable text from an episode."""
    parts = [ep.get("task", ""), ep.get("cluster", "")]
    parts += ep.get("context_files", [])
    parts += ep.get("steps", [])
    parts += ep.get("skills", [])
    return " ".join(parts)


def retrieve_similar(
    query: str,
    episodes: list[dict],
    top_k: int = 3,
    require_success: bool = True,
) -> list[dict]:
    """Return top_k most similar successful episodes."""
    pool = [e for e in episodes if not require_success or e.get("result") == "tests_passed"]
    if not pool:
        return []

    corpus = [_tokenize(_ep_text(e)) for e in pool]
    idf    = _idf(corpus)
    q_tokens = _tokenize(query)
    q_tf     = _tf(q_tokens)
    q_tfidf  = {t: q_tf.get(t, 0) * idf.get(t, 0) for t in q_tokens}

    scored = []
    for ep, tokens in zip(pool, corpus):
        ep_tf     = _tf(tokens)
        ep_tfidf  = {t: ep_tf.get(t, 0) * idf.get(t, 0) for t in tokens}
        sim       = _cosine(q_tfidf, ep_tfidf)
        scored.append((sim, ep))

    scored.sort(key=lambda x: -x[0])
    return [ep for _, ep in scored[:top_k] if scored[0][0] > 0]


# ─── Episode construction ─────────────────────────────────────────────────────

def make_episode(
    task: str,
    cluster: str,
    result: str,
    diff: str = "",
    context_files: list[str] | None = None,
    steps: list[str] | None = None,
    model_used: str = "",
    attempts: int = 1,
    time_s: float = 0.0,
    confidence: float = 0.0,
    skills: list[str] | None = None,
) -> dict:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return {
        "id":            f"ep_{ts}",
        "task":          task,
        "cluster":       cluster,
        "context_files": context_files or [],
        "steps":         steps or [],
        "diff":          diff[:2000],
        "result":        result,
        "confidence":    round(confidence, 3),
        "model_used":    model_used,
        "attempts":      attempts,
        "time_s":        round(time_s, 1),
        "skills":        skills or [],
        "timestamp":     datetime.now(timezone.utc).isoformat(),
    }


# ─── Temporal chaining ────────────────────────────────────────────────────────

def chain_episodes(cluster: str, episodes: list[dict], depth: int = 3) -> list[dict]:
    """
    Return the most recent successful episode chain for a cluster.
    Episodes within the same cluster that occurred in temporal order
    form a "learning trajectory" — useful context for "how did we get here".
    """
    matching = [e for e in episodes
                if e.get("cluster") == cluster and e.get("result") == "tests_passed"]
    matching.sort(key=lambda e: e.get("timestamp", ""))
    return matching[-depth:]


# ─── Injection ────────────────────────────────────────────────────────────────

def build_inject_block(query: str, episodes: list[dict], top_k: int = 2) -> str:
    similar = retrieve_similar(query, episodes, top_k=top_k)
    if not similar:
        return ""

    lines = ["### Relevant past fixes from episodic memory:\n"]
    for i, ep in enumerate(similar, 1):
        lines.append(f"Episode {i}: {ep['task']}")
        lines.append(f"  Cluster    : {ep['cluster']}")
        lines.append(f"  Steps taken: {' -> '.join(ep['steps']) if ep['steps'] else 'n/a'}")
        lines.append(f"  Files      : {', '.join(ep['context_files'][:3])}")
        lines.append(f"  Result     : {ep['result']} ({ep['attempts']} attempt(s), {ep['time_s']}s)")
        if ep.get("skills"):
            lines.append(f"  Skills used: {', '.join(ep['skills'])}")
        if ep.get("diff"):
            diff_preview = [
                l for l in ep["diff"].splitlines()
                if (l.startswith("+") or l.startswith("-")) and not l.startswith(("+++", "---"))
            ][:8]
            if diff_preview:
                lines.append("  Diff excerpt:")
                lines.append("  ```diff")
                for dl in diff_preview:
                    lines.append(f"  {dl}")
                lines.append("  ```")
        lines.append("")

    return "\n".join(lines)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Episodic memory for fix task experience")
    sub = parser.add_subparsers(dest="cmd", required=True)

    add = sub.add_parser("add", help="Store a new episode")
    add.add_argument("--task",     required=True)
    add.add_argument("--cluster",  default="unknown")
    add.add_argument("--result",   default="tests_passed",
                     choices=["tests_passed", "tests_failed", "partial"])
    add.add_argument("--diff",     default="",     help="Diff file path or inline diff")
    add.add_argument("--files",    default="",     help="Comma-separated context files")
    add.add_argument("--steps",    default="",     help="Comma-separated steps taken")
    add.add_argument("--model",    default="")
    add.add_argument("--time",     type=float, default=0.0)
    add.add_argument("--attempts", type=int, default=1)
    add.add_argument("--confidence", type=float, default=0.0)
    add.add_argument("--skills",   default="",     help="Comma-separated skill names used")

    srch = sub.add_parser("search", help="Find similar past episodes")
    srch.add_argument("query")
    srch.add_argument("--top-k", type=int, default=5)
    srch.add_argument("--all", action="store_true", help="Include failed episodes")

    inj = sub.add_parser("inject", help="Build inject block for Aider prompt")
    inj.add_argument("query")
    inj.add_argument("--top-k", type=int, default=2)

    ch = sub.add_parser("chain", help="Show episode chain for a cluster")
    ch.add_argument("cluster")
    ch.add_argument("--depth", type=int, default=3)

    sub.add_parser("stats", help="Memory statistics")

    args = parser.parse_args()
    episodes = _load_all()

    if args.cmd == "add":
        diff_text = ""
        if args.diff:
            p = Path(args.diff)
            diff_text = p.read_text(encoding="utf-8", errors="replace") if p.exists() else args.diff

        ep = make_episode(
            task=args.task,
            cluster=args.cluster,
            result=args.result,
            diff=diff_text,
            context_files=[f.strip() for f in args.files.split(",") if f.strip()],
            steps=[s.strip() for s in args.steps.split(",") if s.strip()],
            model_used=args.model,
            attempts=args.attempts,
            time_s=args.time,
            confidence=args.confidence,
            skills=[s.strip() for s in args.skills.split(",") if s.strip()],
        )
        _append(ep)
        print(f"Stored episode: {ep['id']}")

    elif args.cmd == "search":
        results = retrieve_similar(args.query, episodes, args.top_k, require_success=not args.all)
        if not results:
            print("No similar episodes found")
            return
        for ep in results:
            print(f"[{ep['id']}] {ep['task']}")
            print(f"  cluster={ep['cluster']} result={ep['result']} t={ep['time_s']}s att={ep['attempts']}")
            print()

    elif args.cmd == "inject":
        block = build_inject_block(args.query, episodes, args.top_k)
        print(block if block else "(no relevant episodes found)")

    elif args.cmd == "chain":
        chain = chain_episodes(args.cluster, episodes, args.depth)
        if not chain:
            print(f"No successful episodes for cluster '{args.cluster}'")
            return
        print(f"Episode chain for cluster '{args.cluster}' (last {args.depth}):")
        for ep in chain:
            ts = ep["timestamp"][:10]
            print(f"  {ts}  {ep['task'][:60]}  att={ep['attempts']} t={ep['time_s']}s")

    elif args.cmd == "stats":
        if not episodes:
            print("No episodes yet")
            return
        passed = sum(1 for e in episodes if e.get("result") == "tests_passed")
        clusters = Counter(e.get("cluster", "?") for e in episodes)
        models   = Counter(e.get("model_used", "?") for e in episodes)
        avg_att  = sum(e.get("attempts", 1) for e in episodes) / len(episodes)
        avg_t    = sum(e.get("time_s", 0) for e in episodes) / len(episodes)
        print(f"Total episodes : {len(episodes)}  ({passed} passed, {len(episodes)-passed} failed)")
        print(f"Avg attempts   : {avg_att:.1f}")
        print(f"Avg time       : {avg_t:.1f}s")
        print(f"\nBy cluster:")
        for c, n in clusters.most_common():
            print(f"  {c:<20} {n}")
        print(f"\nBy model:")
        for m, n in models.most_common():
            print(f"  {m:<30} {n}")


if __name__ == "__main__":
    main()
