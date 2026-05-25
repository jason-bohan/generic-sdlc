#!/usr/bin/env python3
"""
collect-training-data.py

Continuous training data collector — runs after each PR merge or CI event.
Three collection modes:

  1. git   — extract new commits since last run (incremental, using a state file)
  2. ci    -- parse a CI failure log + a fix commit into a (failure→fix) example
  3. aider — parse an Aider session log (captured via tee) into examples

All modes APPEND to the target JSONL so you can merge sources freely.

Usage:
  # Collect new git commits (run from cron / post-merge hook):
  python scripts/collect-training-data.py git

  # Collect a CI failure + fix commit:
  python scripts/collect-training-data.py ci --log ci_failure.txt --fix-commit abc123

  # Collect from an Aider session log:
  python scripts/collect-training-data.py aider --log aider_session.txt

State file: .collect-state.json  (tracks last harvested commit hash for git mode)
"""

import subprocess
import json
import os
import re
import argparse
from pathlib import Path
from datetime import datetime

OUTPUT_FILE  = Path("aider_dataset.jsonl")
STATE_FILE   = Path(".collect-state.json")

# ─── Role detection ───────────────────────────────────────────────────────────

TEST_PATH_RE   = re.compile(r"(test|spec|__tests__)", re.IGNORECASE)
REVIEW_MSG_RE  = re.compile(r"^(review|feedback|comment)[\s(:)]", re.IGNORECASE)
QA_MSG_RE      = re.compile(r"^(test|qa|spec|chore\(tests?\))[\s(:)]", re.IGNORECASE)

def infer_role(commit_hash: str, message: str, changed_paths: list[str]) -> str:
    """Infer agent role from branch name, commit message, and changed files."""
    branch = run(["git", "name-rev", "--name-only", commit_hash]).strip().split("~")[0].split("^")[0]
    if "review" in branch:
        return "reviewer"
    if "test" in branch or "qa" in branch:
        return "qa"
    if REVIEW_MSG_RE.match(message):
        return "reviewer"
    if QA_MSG_RE.match(message):
        return "qa"
    # If ALL changed files are test files → qa
    if changed_paths and all(TEST_PATH_RE.search(p) for p in changed_paths):
        return "qa"
    return "developer"

TARGET_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".css", ".sql"}
SKIP_PATH_PATTERNS = [
    re.compile(p) for p in [
        r"package-lock\.json$", r"yarn\.lock$", r"pnpm-lock\.yaml$",
        r"\.snap$", r"dist/", r"build/", r"node_modules/",
    ]
]
SKIP_MSG_PREFIXES  = ("merge", "wip", "revert", "bump ", "release ", "chore(deps")
MAX_CHANGED_LINES  = 80
MAX_FILE_CHARS     = 6000

# ─── Helpers ──────────────────────────────────────────────────────────────────

def run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       text=True, encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else ""


def is_target(path: str) -> bool:
    if any(p.search(path) for p in SKIP_PATH_PATTERNS):
        return False
    return Path(path).suffix.lower() in TARGET_EXTENSIONS


def count_changes(diff: str) -> int:
    return sum(1 for l in diff.splitlines()
               if (l.startswith("+") or l.startswith("-"))
               and not l.startswith(("+++", "---")))


def file_before(commit_hash: str, path: str) -> str:
    return run(["git", "show", f"{commit_hash}^:{path}"])[:MAX_FILE_CHARS]


def split_per_file(diff_text: str) -> dict[str, str]:
    chunks: dict[str, str] = {}
    current, lines = None, []
    for line in diff_text.splitlines(keepends=True):
        m = re.match(r"^diff --git a/(.+?) b/", line)
        if m:
            if current and lines:
                chunks[current] = "".join(lines)
            current, lines = m.group(1), [line]
        elif current is not None:
            lines.append(line)
    if current and lines:
        chunks[current] = "".join(lines)
    return chunks


def append_example(ex: dict) -> None:
    with OUTPUT_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(ex, ensure_ascii=False) + "\n")


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


# ─── Mode: git ────────────────────────────────────────────────────────────────

COMMIT_SEP = "|||COMMIT|||"

def collect_git(since_hash):
    """Extract new commits since `since_hash`. Returns (count, latest_hash)."""
    fmt = f"{COMMIT_SEP}%H\x1f%s"
    cmd = ["git", "log", "--no-merges", f"--pretty=format:{fmt}", "-p",
           "--diff-filter=M", "--"]
    if since_hash:
        cmd.insert(2, f"{since_hash}..HEAD")

    raw = run(cmd)
    if not raw:
        return 0, since_hash

    count = 0
    latest_hash = since_hash

    blocks = [b.strip() for b in raw.split(COMMIT_SEP) if b.strip()]
    for idx, block in enumerate(blocks):
        header, _, diff = block.partition("\n")
        parts = header.split("\x1f")
        if len(parts) < 2:
            continue
        commit_hash, message = parts[0].strip(), parts[1].strip()

        if latest_hash is None:
            latest_hash = commit_hash

        msg_lower = message.lower()
        if any(msg_lower.startswith(p) for p in SKIP_MSG_PREFIXES):
            continue
        if len(message) < 8:
            continue

        per_file = {p: d for p, d in split_per_file(diff).items() if is_target(p)}
        if not per_file:
            continue
        if count_changes("".join(per_file.values())) > MAX_CHANGED_LINES:
            continue

        context_files = {p: file_before(commit_hash, p) for p in list(per_file.keys())[:3]}
        context_files = {p: c for p, c in context_files.items() if c.strip()}
        if not context_files:
            continue

        response_diff = "".join(per_file.values()).strip()
        role = infer_role(commit_hash, message.strip(), list(per_file.keys()))
        append_example({
            "instruction": message.strip(),
            "context": {"files": context_files},
            "response": response_diff,
            "_meta": {"source": "git", "commit": commit_hash, "role": role,
                      "collected_at": datetime.utcnow().isoformat()},
        })
        count += 1

    return count, latest_hash


# ─── Mode: ci ─────────────────────────────────────────────────────────────────

def collect_ci(log_path: str, fix_commit: str) -> int:
    """
    Turn a CI failure log + the commit that fixed it into a training example.
    The model learns: "given this failure output → produce this diff".
    """
    log_text = Path(log_path).read_text(encoding="utf-8", errors="replace")

    # Trim to last 80 lines of output (signal-dense part)
    trimmed = "\n".join(log_text.splitlines()[-80:])

    instruction = f"Fix the CI pipeline failure shown below:\n\n{trimmed}"

    # Get the fix diff
    diff_text = run(["git", "show", fix_commit, "--diff-filter=M", "-p", "--"])
    per_file = {p: d for p, d in split_per_file(diff_text).items() if is_target(p)}
    if not per_file:
        print("No target-language files changed in fix commit — skipping")
        return 0

    response_diff = "".join(per_file.values()).strip()

    context_files = {}
    for path in list(per_file.keys())[:3]:
        content = file_before(fix_commit, path)
        if content.strip():
            context_files[path] = content

    append_example({
        "instruction": instruction,
        "context": {"files": context_files},
        "response": response_diff,
        "_meta": {"source": "ci", "fix_commit": fix_commit, "log": log_path,
                  "collected_at": datetime.utcnow().isoformat()},
    })
    return 1


# ─── Mode: aider ──────────────────────────────────────────────────────────────

def collect_aider(log_path: str) -> int:
    """
    Parse an Aider session log (written by tee or --output-chat-history-file).
    Extracts (user message → applied diff) pairs.

    Aider log format (simplified):
      > <user message>
      ...
      Applied edit to <file>
      --- a/file
      +++ b/file
      ...
    """
    text = Path(log_path).read_text(encoding="utf-8", errors="replace")
    count = 0

    # Split on user messages (lines starting with ">")
    segments = re.split(r"\n> ", "\n" + text)
    for seg in segments[1:]:
        lines = seg.splitlines()
        if not lines:
            continue
        user_msg = lines[0].strip()
        rest = "\n".join(lines[1:])

        # Find all diff blocks in the remainder
        diffs = re.findall(r"(diff --git .*?)(?=diff --git |\Z)", rest, re.DOTALL)
        if not diffs:
            continue

        per_file = {}
        for diff in diffs:
            m = re.match(r"diff --git a/(.+?) b/", diff)
            if m and is_target(m.group(1)):
                per_file[m.group(1)] = diff

        if not per_file or count_changes("".join(per_file.values())) > MAX_CHANGED_LINES:
            continue

        response_diff = "".join(per_file.values()).strip()
        append_example({
            "instruction": user_msg,
            "context": {"files": {}},  # no before-state available from log alone
            "response": response_diff,
            "_meta": {"source": "aider", "log": log_path,
                      "collected_at": datetime.utcnow().isoformat()},
        })
        count += 1

    return count


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Collect Aider training data from git / CI / Aider logs")
    parser.add_argument("--repo", default=None,
                        help="Path to an external repo to collect from (default: cwd)")
    sub = parser.add_subparsers(dest="mode", required=True)

    sub.add_parser("git", help="Incremental git commit harvest")

    ci_p = sub.add_parser("ci", help="CI failure + fix commit pair")
    ci_p.add_argument("--log",        required=True, help="Path to CI failure log file")
    ci_p.add_argument("--fix-commit", required=True, help="Commit SHA that fixed the failure")

    ai_p = sub.add_parser("aider", help="Aider session log")
    ai_p.add_argument("--log", required=True, help="Path to Aider session log file")

    args = parser.parse_args()

    if args.repo:
        os.chdir(args.repo)

    if args.mode == "git":
        state = load_state()
        since = state.get("last_commit")
        print(f"Collecting git commits since: {since or 'beginning'}")
        count, latest = collect_git(since)
        if latest:
            state["last_commit"] = latest
            save_state(state)
        print(f"Added {count} examples → {OUTPUT_FILE}")

    elif args.mode == "ci":
        count = collect_ci(args.log, args.fix_commit)
        print(f"Added {count} CI example(s) → {OUTPUT_FILE}")

    elif args.mode == "aider":
        count = collect_aider(args.log)
        print(f"Added {count} Aider example(s) → {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
