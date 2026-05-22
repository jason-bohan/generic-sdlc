#!/usr/bin/env python3
"""
pattern-library.py  —  Cross-repo bug pattern storage and retrieval.

Normalizes diffs into abstract patterns (variable names → VAR, literals → LIT)
and stores them in a local library. At fix time, retrieves similar patterns
as RAG context injected into the prompt.

Commands:
  add      Add a diff to the library (from file, git commit, or stdin)
  search   Find patterns similar to a query string
  inject   Build a context block to prepend to an Aider prompt
  stats    Show library statistics
  import   Bulk-import from an aider_dataset.jsonl

Pattern library stored at: .pattern-library.jsonl
"""

import argparse
import json
import math
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

LIBRARY_FILE = Path(".pattern-library.jsonl")

# ─── Normalisation ────────────────────────────────────────────────────────────

_IDENT_RE    = re.compile(r"\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b")
_STRING_RE   = re.compile(r'(["\'])(?:(?!\1).)*\1')
_NUMBER_RE   = re.compile(r"\b\d+(\.\d+)?\b")
_IMPORT_PATH = re.compile(r"from\s+['\"]([^'\"]+)['\"]")
_FILE_PATH   = re.compile(r"^(?:diff --git |--- a/|\+\+\+ b/).*$", re.MULTILINE)


def normalize_diff(diff: str) -> str:
    """
    Convert a concrete diff into an abstract pattern by replacing:
      - identifiers (3+ chars) with VAR
      - string literals with STR
      - numbers with NUM
      - import paths with IMPORT_PATH
    Keeps structural tokens: +, -, @@, =>, {, }, (, ), :, ;, etc.
    """
    # Keep only changed lines (+/-) and context lines, strip file headers
    lines = []
    for line in diff.splitlines():
        if line.startswith(("diff ", "index ", "--- ", "+++ ")):
            continue
        if line.startswith("@@"):
            lines.append("@@ context @@")
            continue
        lines.append(line)
    text = "\n".join(lines)

    # Replace import paths before ident mangling
    text = _IMPORT_PATH.sub(lambda m: f"from 'IMPORT_PATH'", text)
    # String literals
    text = _STRING_RE.sub("STR", text)
    # Numbers
    text = _NUMBER_RE.sub("NUM", text)
    # Identifiers (keep keywords and short tokens)
    KEEP = {
        "if", "else", "for", "while", "return", "const", "let", "var", "function",
        "class", "interface", "type", "import", "export", "from", "async", "await",
        "try", "catch", "throw", "new", "null", "undefined", "true", "false",
        "void", "any", "string", "number", "boolean", "never", "object",
    }
    def replace_ident(m: re.Match) -> str:
        word = m.group(0)
        return word if word in KEEP else "VAR"
    text = _IDENT_RE.sub(replace_ident, text)

    return text.strip()


def extract_keywords(text: str) -> list[str]:
    """Extract meaningful tokens for TF-IDF-style retrieval."""
    tokens = re.findall(r"[a-zA-Z_][a-zA-Z0-9_]+", text)
    stop = {"the", "and", "for", "from", "this", "that", "with", "have", "will",
            "VAR", "STR", "NUM", "IMPORT_PATH", "context"}
    return [t.lower() for t in tokens if t.lower() not in stop and len(t) > 2]


# ─── TF-IDF similarity ────────────────────────────────────────────────────────

def _tf(tokens: list[str]) -> dict[str, float]:
    counts = Counter(tokens)
    total = len(tokens) or 1
    return {t: c / total for t, c in counts.items()}


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    shared = set(a) & set(b)
    dot    = sum(a[k] * b[k] for k in shared)
    mag_a  = math.sqrt(sum(v**2 for v in a.values()))
    mag_b  = math.sqrt(sum(v**2 for v in b.values()))
    if not mag_a or not mag_b:
        return 0.0
    return dot / (mag_a * mag_b)


# ─── Library I/O ──────────────────────────────────────────────────────────────

def load_library() -> list[dict]:
    if not LIBRARY_FILE.exists():
        return []
    entries = []
    with open(LIBRARY_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return entries


def save_entry(entry: dict) -> None:
    with open(LIBRARY_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ─── Commands ──────────────────────────────────────────────────────────────────

def cmd_add(diff_source: str, instruction: str, source_repo: str) -> None:
    if diff_source == "-" or not diff_source:
        diff = sys.stdin.read()
    else:
        path = Path(diff_source)
        if path.exists():
            diff = path.read_text(encoding="utf-8", errors="replace")
        else:
            # Treat as git commit hash
            r = subprocess.run(["git", "show", diff_source, "-p", "--diff-filter=M"],
                               capture_output=True, text=True, encoding="utf-8")
            diff = r.stdout

    if not diff.strip():
        print("Empty diff — nothing added")
        return

    pattern = normalize_diff(diff)
    keywords = extract_keywords(f"{instruction} {pattern}")
    entry = {
        "instruction": instruction,
        "pattern":     pattern,
        "diff":        diff[:3000],
        "keywords":    keywords[:50],
        "source_repo": source_repo,
    }
    save_entry(entry)
    print(f"Added pattern ({len(pattern)} chars, {len(keywords)} keywords)")


def cmd_search(query: str, top_k: int) -> list[dict]:
    library = load_library()
    if not library:
        print("Library is empty — run: python scripts/pattern-library.py import")
        return []

    query_kw = extract_keywords(query)
    query_tf  = _tf(query_kw)

    scored = []
    for entry in library:
        entry_tf = _tf(entry.get("keywords", []))
        sim = _cosine(query_tf, entry_tf)
        scored.append((sim, entry))

    scored.sort(key=lambda x: -x[0])
    results = [e for _, e in scored[:top_k] if scored]

    for i, (sim, entry) in enumerate(scored[:top_k], 1):
        print(f"[{i}] score={sim:.3f}  instruction: {entry['instruction'][:70]}")
        print(f"     repo: {entry.get('source_repo', '?')}")
        print()

    return results


def cmd_inject(query: str, top_k: int = 3) -> str:
    """
    Return a context block ready to prepend to an Aider prompt.
    Call like:  python scripts/pattern-library.py inject "Fix null reference" --quiet
    """
    library = load_library()
    if not library:
        return ""

    query_kw = extract_keywords(query)
    query_tf  = _tf(query_kw)

    scored = []
    for entry in library:
        entry_tf = _tf(entry.get("keywords", []))
        sim = _cosine(query_tf, entry_tf)
        if sim > 0.1:
            scored.append((sim, entry))

    scored.sort(key=lambda x: -x[0])
    top = scored[:top_k]

    if not top:
        return ""

    lines = ["### Known patterns from similar past fixes:\n"]
    for i, (sim, entry) in enumerate(top, 1):
        lines.append(f"Pattern {i} (similarity={sim:.2f}): {entry['instruction']}")
        lines.append("```diff")
        # Show abstract pattern, not raw diff (teaches form, not content)
        for line in entry["pattern"].splitlines()[:15]:
            lines.append(line)
        lines.append("```\n")

    return "\n".join(lines)


def cmd_import(dataset_path: str, source_repo: str, limit: int) -> None:
    path = Path(dataset_path)
    if not path.exists():
        print(f"Not found: {dataset_path}")
        return

    count = 0
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= limit:
                break
            line = line.strip()
            if not line:
                continue
            ex = json.loads(line)
            diff    = ex.get("response", "")
            instr   = ex.get("instruction", "")
            if not diff or not instr:
                continue
            pattern = normalize_diff(diff)
            keywords = extract_keywords(f"{instr} {pattern}")
            entry = {
                "instruction": instr,
                "pattern":     pattern,
                "diff":        diff[:3000],
                "keywords":    keywords[:50],
                "source_repo": source_repo,
            }
            save_entry(entry)
            count += 1

    print(f"Imported {count} patterns from {dataset_path} → {LIBRARY_FILE}")


def cmd_stats() -> None:
    library = load_library()
    if not library:
        print("Library is empty")
        return
    repos = Counter(e.get("source_repo", "?") for e in library)
    print(f"Total patterns : {len(library)}")
    print(f"Library file   : {LIBRARY_FILE.resolve()}")
    print(f"By source repo :")
    for repo, n in repos.most_common():
        print(f"  {repo:<40} {n}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Cross-repo bug pattern library")
    sub = parser.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="Add a diff to the library")
    a.add_argument("--diff",        default="-",           help="Diff file path, git commit hash, or '-' for stdin")
    a.add_argument("--instruction", default="",            help="What the change is supposed to do")
    a.add_argument("--repo",        default="Meitheal",    help="Source repo name tag")

    s = sub.add_parser("search", help="Find similar patterns")
    s.add_argument("query",         help="Search query (failure description or instruction)")
    s.add_argument("--top-k", type=int, default=5, help="Number of results (default: 5)")

    inj = sub.add_parser("inject", help="Output context block for Aider prompt")
    inj.add_argument("query",         help="Query describing the current task")
    inj.add_argument("--top-k", type=int, default=3, help="Patterns to include (default: 3)")

    imp = sub.add_parser("import", help="Bulk-import from aider_dataset.jsonl")
    imp.add_argument("dataset",       help="Path to aider_dataset.jsonl")
    imp.add_argument("--repo",        default="Meitheal",  help="Source repo name tag")
    imp.add_argument("--limit", type=int, default=10000,   help="Max examples to import")

    sub.add_parser("stats", help="Library statistics")

    args = parser.parse_args()

    if args.cmd == "add":
        cmd_add(args.diff, args.instruction, args.repo)
    elif args.cmd == "search":
        cmd_search(args.query, args.top_k)
    elif args.cmd == "inject":
        block = cmd_inject(args.query, args.top_k)
        print(block if block else "(no relevant patterns found)")
    elif args.cmd == "import":
        cmd_import(args.dataset, args.repo, args.limit)
    elif args.cmd == "stats":
        cmd_stats()


if __name__ == "__main__":
    main()
