#!/usr/bin/env python3
"""
extract-aider-dataset.py

Mines the Meitheal git history and produces a JSONL training dataset for
fine-tuning a diff-producing coding agent with Unsloth + Aider.

Each record:
  {
    "instruction": "<commit-message, cleaned>",
    "context":     { "files": { "path": "<before content>" } },
    "response":    "<unified diff>"
  }

Usage:
  cd C:/repos/Meitheal
  python scripts/extract-aider-dataset.py [--output aider_dataset.jsonl] [--since 2024-01-01]
"""

import subprocess
import json
import re
import sys
import argparse
from pathlib import Path

# ─── Configuration ────────────────────────────────────────────────────────────

# Only extract diffs touching these extensions (the "coding brain" domain)
TARGET_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".css", ".sql"}

# Skip any commit whose message starts with or contains these (case-insensitive)
SKIP_MESSAGE_PREFIXES = ("merge", "wip", "wip:", "revert", "bump ", "release ")
SKIP_MESSAGE_CONTAINS = ("chore(deps", "auto-generated", "co-authored-by")

# Skip diffs touching these paths (generated, noisy, or config-only)
SKIP_PATH_PATTERNS = [
    re.compile(p) for p in [
        r"package-lock\.json$",
        r"yarn\.lock$",
        r"pnpm-lock\.yaml$",
        r"\.snap$",
        r"dist/",
        r"build/",
        r"\.min\.(js|css)$",
        r"coverage/",
        r"__pycache__/",
        r"\.pyc$",
        r"node_modules/",
    ]
]

# Diff size limits (in changed lines, counting + and - lines)
MIN_CHANGED_LINES = 1
MAX_CHANGED_LINES = 80   # >80 changed lines → usually a rewrite, skip it

# Per-file content limit sent as context (chars) — keeps context tight
MAX_FILE_CONTEXT_CHARS = 6000

# Max files whose before-content we include per commit
MAX_CONTEXT_FILES = 3

# Instruction prefix variations — randomly varied to teach the model
# to handle different instruction phrasings
INSTRUCTION_PREFIXES = [
    "Fix the following issue: {msg}",
    "{msg}. Make minimal changes only.",
    "Apply this targeted change: {msg}",
    "{msg}",
    "Implement the following with minimal diff: {msg}",
    "{msg}. Do not modify unrelated code.",
]

# ─── Helpers ──────────────────────────────────────────────────────────────────

def run(cmd: list[str], cwd: str = ".") -> str:
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=cwd,
    )
    return result.stdout if result.returncode == 0 else ""


def is_target_file(path: str) -> bool:
    if any(pat.search(path) for pat in SKIP_PATH_PATTERNS):
        return False
    return Path(path).suffix.lower() in TARGET_EXTENSIONS


def count_changed_lines(patch: str) -> int:
    return sum(
        1 for line in patch.splitlines()
        if line.startswith("+") or line.startswith("-")
        if not line.startswith("+++") and not line.startswith("---")
    )


def clean_message(msg: str) -> str:
    # Strip conventional commit prefixes for training variety
    # e.g. "fix(aider): ..." → "fix: ..." → "..."  keeps semantic type
    msg = msg.strip()
    # Remove scope: "fix(foo): bar" → "fix: bar"
    msg = re.sub(r"^(\w+)\([^)]+\):", r"\1:", msg)
    # Capitalise first letter
    if msg and not msg[0].isupper():
        msg = msg[0].upper() + msg[1:]
    return msg


def vary_instruction(msg: str, index: int) -> str:
    prefix = INSTRUCTION_PREFIXES[index % len(INSTRUCTION_PREFIXES)]
    return prefix.format(msg=msg)


def file_content_before(repo_dir: str, commit_hash: str, path: str) -> str:
    content = run(["git", "show", f"{commit_hash}^:{path}"], cwd=repo_dir)
    return content[:MAX_FILE_CONTEXT_CHARS]


def extract_diff_files(diff_text: str) -> list[str]:
    return re.findall(r"^diff --git a/(.+?) b/", diff_text, re.MULTILINE)


def split_per_file_diffs(diff_text: str) -> dict[str, str]:
    """Split a multi-file diff into per-file chunks."""
    chunks: dict[str, str] = {}
    current_file = None
    current_lines: list[str] = []

    for line in diff_text.splitlines(keepends=True):
        m = re.match(r"^diff --git a/(.+?) b/", line)
        if m:
            if current_file and current_lines:
                chunks[current_file] = "".join(current_lines)
            current_file = m.group(1)
            current_lines = [line]
        elif current_file is not None:
            current_lines.append(line)

    if current_file and current_lines:
        chunks[current_file] = "".join(current_lines)

    return chunks

# ─── Main extraction ──────────────────────────────────────────────────────────

COMMIT_SEP = "|||COMMIT|||"

def get_commits(repo_dir: str, since: str | None) -> list[dict]:
    fmt = f"{COMMIT_SEP}%H\x1f%s"
    cmd = ["git", "log", "--no-merges", f"--pretty=format:{fmt}", "-p",
           "--diff-filter=M",   # only Modified files (not Added/Deleted mass changes)
           "--"]
    if since:
        cmd.insert(2, f"--since={since}")

    raw = run(cmd, cwd=repo_dir)
    if not raw:
        print("No git output — are you in the right directory?", file=sys.stderr)
        return []

    commits = []
    for block in raw.split(COMMIT_SEP):
        block = block.strip()
        if not block:
            continue

        header, _, diff = block.partition("\n")
        parts = header.split("\x1f")
        if len(parts) < 2:
            continue

        commit_hash = parts[0].strip()
        message = parts[1].strip()

        # Filter by message
        msg_lower = message.lower()
        if any(msg_lower.startswith(p) for p in SKIP_MESSAGE_PREFIXES):
            continue
        if any(s in msg_lower for s in SKIP_MESSAGE_CONTAINS):
            continue
        if not message or len(message) < 8:
            continue

        commits.append({"hash": commit_hash, "message": message, "diff": diff})

    return commits


def process_commit(repo_dir: str, idx: int, commit: dict) -> list[dict]:
    """Return 0-N training examples from a single commit."""
    per_file = split_per_file_diffs(commit["diff"])

    # Only keep target files
    target_files = {path: diff for path, diff in per_file.items() if is_target_file(path)}
    if not target_files:
        return []

    # Changed-line budget for the whole commit
    total_changed = sum(count_changed_lines(d) for d in target_files.values())
    if total_changed < MIN_CHANGED_LINES or total_changed > MAX_CHANGED_LINES:
        return []

    # Build context from before-state of up to MAX_CONTEXT_FILES
    context_files: dict[str, str] = {}
    for path in list(target_files.keys())[:MAX_CONTEXT_FILES]:
        content = file_content_before(repo_dir, commit["hash"], path)
        if content.strip():
            context_files[path] = content

    if not context_files:
        return []

    # Concatenate only the target-file diffs into the response
    response_diff = "".join(target_files.values()).strip()
    if not response_diff:
        return []

    clean_msg = clean_message(commit["message"])
    instruction = vary_instruction(clean_msg, idx)

    return [{
        "instruction": instruction,
        "context": {"files": context_files},
        "response": response_diff,
    }]


def main():
    parser = argparse.ArgumentParser(description="Extract Aider diff training data from git history")
    parser.add_argument("--repo", default=".", help="Path to git repo (default: cwd)")
    parser.add_argument("--output", default="aider_dataset.jsonl", help="Output JSONL file")
    parser.add_argument("--since", default=None, help="Only commits after this date, e.g. 2024-01-01")
    parser.add_argument("--stats", action="store_true", help="Print category breakdown after run")
    args = parser.parse_args()

    repo_dir = str(Path(args.repo).resolve())
    print(f"Repo   : {repo_dir}")
    print(f"Output : {args.output}")
    if args.since:
        print(f"Since  : {args.since}")
    print()

    commits = get_commits(repo_dir, args.since)
    print(f"Found {len(commits)} candidate commits (after message filters)")

    examples = []
    skipped_size = 0
    skipped_no_context = 0

    for idx, commit in enumerate(commits):
        results = process_commit(repo_dir, idx, commit)
        if not results:
            # rough reason tracking
            per_file = split_per_file_diffs(commit["diff"])
            target = {p: d for p, d in per_file.items() if is_target_file(p)}
            if not target:
                pass  # non-target files only
            else:
                total = sum(count_changed_lines(d) for d in target.values())
                if total < MIN_CHANGED_LINES or total > MAX_CHANGED_LINES:
                    skipped_size += 1
                else:
                    skipped_no_context += 1
        examples.extend(results)

    print(f"Extracted   : {len(examples)} training examples")
    print(f"Skipped (diff too large/small) : {skipped_size}")
    print(f"Skipped (no before-context)    : {skipped_no_context}")

    if args.stats and examples:
        sizes = [count_changed_lines(e["response"]) for e in examples]
        print(f"\nDiff size distribution:")
        print(f"  min={min(sizes)}  max={max(sizes)}  avg={sum(sizes)/len(sizes):.1f}")
        file_counts = [len(e["context"]["files"]) for e in examples]
        print(f"Files per example: avg={sum(file_counts)/len(file_counts):.1f}")

    out_path = Path(args.output)
    with out_path.open("w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    print(f"\nWritten to {out_path.resolve()}")


if __name__ == "__main__":
    main()
