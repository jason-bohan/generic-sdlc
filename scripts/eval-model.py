#!/usr/bin/env python3
"""
eval-model.py  —  Evaluate meitheal-tuned vs Claude on held-out Aider diff examples.

Metrics (per example):
  format_ok   — output starts with valid diff header (--- / +++ / @@)
  file_match  — file paths in output match expected
  line_f1     — F1 on changed lines (stripped of +/- prefix)
  size_ratio  — output lines / expected lines (1.0 = perfect size, >1 = verbose)

The last N% of aider_dataset.jsonl is used as the eval set (not seen during training).

Usage:
  python scripts/eval-model.py [--n 20] [--eval-fraction 0.2] [--no-claude]
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

DATASET_FILE = Path("aider_dataset.jsonl")
RESULTS_FILE = Path("ml/unsloth/output/eval_results.jsonl")

SYSTEM_PROMPT = """\
You are a deterministic coding agent. Your only output is a unified diff in git format.
Output ONLY the diff. No explanation, no markdown fences, no commentary.
Make the smallest possible change that satisfies the instruction."""

# ─── Prompt builder ───────────────────────────────────────────────────────────

def build_prompt(instruction: str, files: dict) -> str:
    parts = [f"### Instruction:\n{instruction}\n\n### Context:"]
    for path, content in files.items():
        parts.append(f"\n### File: {path}\n```\n{content.rstrip()}\n```")
    parts.append("\n### Response:")
    return "\n".join(parts)


# ─── Scoring ──────────────────────────────────────────────────────────────────

_DIFF_HEADER_RE = re.compile(r"^diff --git |^--- a/|^\+\+\+ b/|^@@ -\d", re.MULTILINE)
_FILE_PATH_RE   = re.compile(r"^(?:---|\+\+\+) [ab]/(.+)$", re.MULTILINE)


def score_format(output: str) -> float:
    """1.0 if output looks like a valid unified diff, else 0.0."""
    if not output.strip():
        return 0.0
    has_header = bool(_DIFF_HEADER_RE.search(output))
    return 1.0 if has_header else 0.0


def score_file_match(output: str, expected: str) -> float:
    """Fraction of expected file paths that appear in output."""
    def extract_paths(text: str) -> set[str]:
        return {m.group(1) for m in _FILE_PATH_RE.finditer(text)}

    exp_paths = extract_paths(expected)
    if not exp_paths:
        return 1.0
    out_paths = extract_paths(output)
    matches = exp_paths & out_paths
    return len(matches) / len(exp_paths)


def _changed_lines(diff: str) -> set[str]:
    """Extract the content of +/- lines, stripped of prefix."""
    lines = set()
    for line in diff.splitlines():
        if (line.startswith("+") or line.startswith("-")) and \
           not line.startswith(("+++", "---")):
            lines.add(line[1:].strip())
    return lines


def score_line_f1(output: str, expected: str) -> float:
    """F1 score on changed-line content."""
    out_lines = _changed_lines(output)
    exp_lines = _changed_lines(expected)
    if not exp_lines:
        return 1.0
    if not out_lines:
        return 0.0
    tp = len(out_lines & exp_lines)
    precision = tp / len(out_lines) if out_lines else 0.0
    recall    = tp / len(exp_lines) if exp_lines else 0.0
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def score_size_ratio(output: str, expected: str) -> float:
    """How close in size the output is to expected (0–1, closer to 1 = better)."""
    out_c = len(_changed_lines(output))
    exp_c = len(_changed_lines(expected))
    if exp_c == 0:
        return 1.0
    ratio = out_c / exp_c if out_c else 0.0
    return 1.0 / (1.0 + abs(ratio - 1.0))


def score_all(output: str, expected: str) -> dict:
    fmt   = score_format(output)
    fmatch = score_file_match(output, expected)
    f1    = score_line_f1(output, expected)
    size  = score_size_ratio(output, expected)
    # Composite: weight correctness (f1) most heavily
    composite = 0.15 * fmt + 0.15 * fmatch + 0.55 * f1 + 0.15 * size
    return {
        "format_ok":   round(fmt, 3),
        "file_match":  round(fmatch, 3),
        "line_f1":     round(f1, 3),
        "size_ratio":  round(size, 3),
        "composite":   round(composite, 3),
    }


# ─── Model callers ────────────────────────────────────────────────────────────

def call_ollama(model: str, prompt: str, base_url: str = "http://localhost:11434") -> str:
    import urllib.request
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 1024},
    }).encode()
    req = urllib.request.Request(
        f"{base_url}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            return data.get("message", {}).get("content", "")
    except Exception as e:
        return f"[ERROR: {e}]"


def call_openai_compat(model: str, prompt: str, base_url: str, api_key: str) -> str:
    import urllib.request
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        "temperature": 0.1,
        "max_tokens": 1024,
    }).encode()
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"[ERROR: {e}]"


# ─── Main ─────────────────────────────────────────────────────────────────────

def load_eval_set(dataset: Path, fraction: float, max_n: int) -> list[dict]:
    examples = []
    with open(dataset, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                examples.append(json.loads(line))
    cutoff = max(1, int(len(examples) * (1.0 - fraction)))
    eval_set = examples[cutoff:][:max_n]
    return eval_set


def main():
    parser = argparse.ArgumentParser(description="Evaluate meitheal-tuned vs Claude on held-out examples")
    parser.add_argument("--n",             type=int,   default=20,           help="Max examples to evaluate")
    parser.add_argument("--eval-fraction", type=float, default=0.2,          help="Fraction of dataset held out for eval")
    parser.add_argument("--our-model",     default="meitheal-tuned",         help="Ollama model name for 'our' model")
    parser.add_argument("--ollama-url",    default="http://localhost:11434",  help="Ollama base URL")
    parser.add_argument("--mesh-url",      default=None,                     help="If set, use MeshLLM at this URL instead of Ollama")
    parser.add_argument("--no-claude",     action="store_true",              help="Skip Claude comparison")
    parser.add_argument("--openrouter-key", default=None,                    help="OpenRouter API key (or set OPENROUTER_API_KEY env)")
    parser.add_argument("--claude-model",  default="anthropic/claude-sonnet-4", help="Claude model via OpenRouter")
    parser.add_argument("--output",        default=str(RESULTS_FILE),        help="Results output file")
    args = parser.parse_args()

    if not DATASET_FILE.exists():
        print(f"Dataset not found: {DATASET_FILE}")
        sys.exit(1)

    eval_set = load_eval_set(DATASET_FILE, args.eval_fraction, args.n)
    print(f"Evaluating {len(eval_set)} held-out examples")
    print(f"Our model : {args.our_model}")
    print(f"Claude    : {'enabled' if not args.no_claude else 'disabled'}")
    print()

    openrouter_key = args.openrouter_key or os.environ.get("OPENROUTER_API_KEY", "")
    run_claude = not args.no_claude and bool(openrouter_key)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    our_scores: list[float] = []
    claude_scores: list[float] = []

    with open(out_path, "w", encoding="utf-8") as f_out:
        for i, ex in enumerate(eval_set):
            instruction = ex.get("instruction", "")
            files = ex.get("context", {}).get("files", {})
            expected = ex.get("response", "")
            prompt = build_prompt(instruction, files)

            print(f"[{i+1}/{len(eval_set)}] {instruction[:60]}...")

            # Our model
            t0 = time.time()
            if args.mesh_url:
                our_out = call_openai_compat(args.our_model, prompt, args.mesh_url + "/v1", "mesh")
            else:
                our_out = call_ollama(args.our_model, prompt, args.ollama_url)
            our_ms = int((time.time() - t0) * 1000)
            our_s = score_all(our_out, expected)
            our_scores.append(our_s["composite"])

            result: dict = {
                "instruction": instruction,
                "our": {**our_s, "latency_ms": our_ms, "output": our_out[:500]},
            }

            # Claude comparison
            if run_claude:
                t0 = time.time()
                claude_out = call_openai_compat(
                    args.claude_model, prompt,
                    "https://openrouter.ai/api/v1", openrouter_key,
                )
                claude_ms = int((time.time() - t0) * 1000)
                claude_s = score_all(claude_out, expected)
                claude_scores.append(claude_s["composite"])
                result["claude"] = {**claude_s, "latency_ms": claude_ms, "output": claude_out[:500]}

                delta = our_s["composite"] - claude_s["composite"]
                print(f"  our={our_s['composite']:.3f}  claude={claude_s['composite']:.3f}  Δ={delta:+.3f}")
            else:
                print(f"  our={our_s['composite']:.3f}  f1={our_s['line_f1']:.3f}  fmt={our_s['format_ok']:.0f}")

            f_out.write(json.dumps(result, ensure_ascii=False) + "\n")

    # Summary
    print()
    print("=" * 50)
    n = len(our_scores)
    if n:
        print(f"Our model  avg composite: {sum(our_scores)/n:.3f}  (n={n})")
        if claude_scores:
            print(f"Claude     avg composite: {sum(claude_scores)/n:.3f}")
            wins = sum(1 for o, c in zip(our_scores, claude_scores) if o >= c)
            print(f"Our model wins: {wins}/{n} ({100*wins//n}%)")
    print(f"Results → {out_path.resolve()}")


if __name__ == "__main__":
    main()
