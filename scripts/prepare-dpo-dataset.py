#!/usr/bin/env python3
"""
prepare-dpo-dataset.py

Builds a DPO (Direct Preference Optimization) dataset from aider_dataset.jsonl.

Each record has:
  - prompt:   the user instruction + file context (same as SFT)
  - chosen:   the real minimal diff from the commit (the "good" behavior)
  - rejected: a synthetically degraded version (teaching what NOT to do)

Rejection strategies (cycled across examples to create diverse negative signal):
  1. Rewrite — replaces the diff with a full-file rewrite (the #1 failure mode)
  2. Verbose — wraps the diff in a chat-style explanation (kills Aider loop)
  3. Over-edit — adds spurious unrelated changes to the diff
  4. Wrong format — strips the --- / +++ / @@ header so Aider can't parse it

Output format (trl DPOTrainer messages format):
  {
    "prompt":   [{"role": "system", ...}, {"role": "user", ...}],
    "chosen":   [{"role": "assistant", "content": "<good diff>"}],
    "rejected": [{"role": "assistant", "content": "<bad output>"}]
  }

Usage:
  python scripts/prepare-dpo-dataset.py [--input aider_dataset.jsonl] [--output ml/unsloth/data/dpo.jsonl]
"""

import json
import re
import argparse
from pathlib import Path

SYSTEM_PROMPT = """\
You are a deterministic coding agent. Your only output is a unified diff in git format.

Rules:
- Output ONLY the diff. No explanation, no markdown fences, no commentary.
- Make the smallest possible change that satisfies the instruction.
- Never rewrite entire files. Surgical edits only.
- Preserve whitespace, indentation, and coding style of the surrounding code.
- Use standard unified diff format:
    --- a/path/to/file
    +++ b/path/to/file
    @@ -N,n +N,n @@
     context
    -removed
    +added
     context
"""


def build_user_message(instruction: str, files: dict[str, str]) -> str:
    parts = []
    for path, content in files.items():
        parts.append(f"### File: {path}\n```\n{content.rstrip()}\n```")
    context = "\n\n".join(parts)
    return f"### Instruction:\n{instruction}\n\n### Context:\n{context}"


# ─── Rejection generators ─────────────────────────────────────────────────────

def _reject_rewrite(diff: str, files: dict[str, str]) -> str:
    """Simulate a model that rewrites the entire first file instead of patching."""
    first_path = next(iter(files))
    first_content = files[first_path]
    lines = first_content.splitlines()
    # Produce a fake full-file replace diff
    minus = "\n".join(f"-{l}" for l in lines[:30])
    plus  = "\n".join(f"+{l}" for l in lines[:30])
    return (
        f"--- a/{first_path}\n+++ b/{first_path}\n@@ -1,{len(lines)} +1,{len(lines)} @@\n"
        + minus + "\n" + plus
    )


def _reject_verbose(diff: str, files: dict[str, str]) -> str:
    """Simulate a chatbot-style response that wraps the diff in explanation."""
    return (
        "Here is the fix for your issue:\n\n"
        "I've identified the problem and made the following change:\n\n"
        f"```diff\n{diff}\n```\n\n"
        "This should resolve the issue. Let me know if you need anything else!"
    )


def _reject_over_edit(diff: str, files: dict[str, str]) -> str:
    """Add spurious unrelated changes after the real diff."""
    noise = (
        "\n--- a/package.json\n+++ b/package.json\n@@ -1,3 +1,4 @@\n"
        ' {\n+  "description": "updated",\n   "version": "1.0.0"\n }'
    )
    return diff + noise


def _reject_wrong_format(diff: str, files: dict[str, str]) -> str:
    """Strip the diff header so it looks like raw code output."""
    lines = diff.splitlines()
    # Remove --- / +++ / @@ header lines
    body = [l for l in lines if not l.startswith(("---", "+++", "@@", "diff "))]
    return "\n".join(body)


REJECTION_STRATEGIES = [
    _reject_rewrite,
    _reject_verbose,
    _reject_over_edit,
    _reject_wrong_format,
]


def generate_rejected(diff: str, files: dict[str, str], strategy_index: int) -> str:
    strategy = REJECTION_STRATEGIES[strategy_index % len(REJECTION_STRATEGIES)]
    return strategy(diff, files)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Build DPO dataset from aider_dataset.jsonl")
    parser.add_argument("--input",  default="aider_dataset.jsonl",       help="Source JSONL")
    parser.add_argument("--output", default="ml/unsloth/data/dpo.jsonl", help="Output JSONL")
    parser.add_argument("--max-seq-chars", type=int, default=16000,       help="Skip examples exceeding this total char count")
    args = parser.parse_args()

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)

    count = 0
    skipped = 0

    with open(args.input, encoding="utf-8") as f_in, \
         open(args.output, "w", encoding="utf-8") as f_out:
        for idx, line in enumerate(f_in):
            line = line.strip()
            if not line:
                continue
            ex = json.loads(line)
            instruction = ex.get("instruction", "").strip()
            files = ex.get("context", {}).get("files", {})
            chosen_diff = ex.get("response", "").strip()

            if not instruction or not files or not chosen_diff:
                skipped += 1
                continue

            user_msg = build_user_message(instruction, files)
            if len(SYSTEM_PROMPT + user_msg + chosen_diff) > args.max_seq_chars:
                skipped += 1
                continue

            rejected_diff = generate_rejected(chosen_diff, files, idx)

            record = {
                "prompt": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user",   "content": user_msg},
                ],
                "chosen":   [{"role": "assistant", "content": chosen_diff}],
                "rejected": [{"role": "assistant", "content": rejected_diff}],
            }
            f_out.write(json.dumps(record, ensure_ascii=False) + "\n")
            count += 1

    print(f"Written: {count} DPO pairs  ({skipped} skipped)")
    print(f"Output : {Path(args.output).resolve()}")

    # Print strategy distribution
    strat_names = [f.__name__.replace("_reject_", "") for f in REJECTION_STRATEGIES]
    print("\nRejection strategy distribution:")
    for i, name in enumerate(strat_names):
        share = count // len(REJECTION_STRATEGIES)
        print(f"  {name:<15} ~{share} examples")


if __name__ == "__main__":
    main()
