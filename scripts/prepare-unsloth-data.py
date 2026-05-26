#!/usr/bin/env python3
"""
prepare-unsloth-data.py

Converts aider_dataset.jsonl (triplet format) into the ShareGPT conversation
format expected by ml/unsloth/train.py (ChatML via Qwen's <|im_start|> tokens).

Each output record:
  {
    "conversations": [
      {"role": "system",    "content": "<diff-agent system prompt>"},
      {"role": "user",      "content": "### Instruction:\n...\n\n### Context:\n..."},
      {"role": "assistant", "content": "<unified diff only>"}
    ]
  }

Usage:
  python scripts/prepare-unsloth-data.py [--input aider_dataset.jsonl] [--output ml/unsloth/data/train.jsonl]
"""

import json
import argparse
from pathlib import Path

SYSTEM_PROMPTS: dict[str, str] = {
    "developer": """\
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
     context""",

    "reviewer": """\
You are a code review agent. Your output is a structured list of review comments on the provided diff.

Rules:
- Output ONLY review comments in the format: `<file>:<line>: <severity>: <message>`
- Severity is one of: info, warning, error
- Focus on correctness, security, and maintainability — not style.
- If the change is correct with no issues, output: LGTM""",

    "qa": """\
You are a QA agent. Your only output is a unified diff that adds or updates tests for the described behaviour.

Rules:
- Output ONLY the diff. No explanation, no markdown fences, no commentary.
- Write the minimum tests needed to cover the acceptance criteria.
- Use the same test framework already present in the codebase.
- Tests must be deterministic and not depend on external services.""",
}

# Backwards-compatible alias used by existing callers that pass no --role
SYSTEM_PROMPT = SYSTEM_PROMPTS["developer"]


def build_user_message(instruction: str, files: dict[str, str]) -> str:
    context_parts = []
    for path, content in files.items():
        context_parts.append(f"### File: {path}\n```\n{content.rstrip()}\n```")
    context_block = "\n\n".join(context_parts)
    return f"### Instruction:\n{instruction}\n\n### Context:\n{context_block}"


def convert(input_path: str, output_path: str, max_seq_chars: int, role: "str | None" = None) -> int:
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    count = 0
    skipped = 0
    with open(input_path, encoding="utf-8") as f_in, \
         open(output_path, "w", encoding="utf-8") as f_out:
        for line in f_in:
            line = line.strip()
            if not line:
                continue
            ex = json.loads(line)
            instruction = ex.get("instruction", "").strip()
            files = ex.get("context", {}).get("files", {})
            response = ex.get("response", "").strip()

            if not instruction or not files or not response:
                skipped += 1
                continue

            # Role filter: skip examples that don't match requested role
            if role and role != "all":
                ex_role = ex.get("_meta", {}).get("role", "developer")
                if ex_role != role:
                    skipped += 1
                    continue

            user_msg = build_user_message(instruction, files)
            full_text = SYSTEM_PROMPT + user_msg + response
            if len(full_text) > max_seq_chars:
                skipped += 1
                continue

            sys_prompt = SYSTEM_PROMPTS.get(role or "developer", SYSTEM_PROMPT)
            record = {
                "conversations": [
                    {"role": "system",    "content": sys_prompt},
                    {"role": "user",      "content": user_msg},
                    {"role": "assistant", "content": response},
                ]
            }
            f_out.write(json.dumps(record, ensure_ascii=False) + "\n")
            count += 1

    return count, skipped


def main():
    parser = argparse.ArgumentParser(description="Convert aider dataset to Unsloth ShareGPT format")
    parser.add_argument("--input",  default="aider_dataset.jsonl",        help="Source JSONL (default: aider_dataset.jsonl)")
    parser.add_argument("--output", default="ml/unsloth/data/train.jsonl", help="Destination JSONL (default: ml/unsloth/data/train.jsonl)")
    parser.add_argument("--max-seq-chars", type=int, default=16000,        help="Skip examples whose total text exceeds this (default: 16000)")
    parser.add_argument("--role",   default=None,
                        choices=["developer", "reviewer", "qa", "all"],
                        help="Filter and specialize for a specific agent role (default: all)")
    args = parser.parse_args()

    print(f"Input  : {args.input}")
    print(f"Output : {args.output}")
    if args.role:
        print(f"Role   : {args.role}")

    count, skipped = convert(args.input, args.output, args.max_seq_chars, role=args.role)
    print(f"Written: {count} examples  ({skipped} skipped — too long, empty, or wrong role)")


if __name__ == "__main__":
    main()
