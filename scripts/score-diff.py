#!/usr/bin/env python3
"""
score-diff.py  —  Confidence scoring for a proposed code diff before applying it.

Combines:
  1. Heuristics   — always available, zero-latency (format, size, file count)
  2. LLM self-eval — optional, calls the local model to rate its own output

Output JSON:
  {
    "score":          0.82,       # 0.0–1.0 composite
    "heuristic":      0.90,
    "llm":            0.75,       # null if --no-llm
    "recommendation": "apply",   # apply | retry | escalate
    "details":        { ... }
  }

Exit code: 0 if recommendation == "apply", 1 otherwise.

Usage (standalone):
  python scripts/score-diff.py --diff path/to/file.diff --instruction "Fix timeout"
  git diff HEAD | python scripts/score-diff.py --instruction "Fix timeout"

Importable:
  from scripts.score_diff import score_diff
  result = score_diff(diff_text, instruction, mesh_url, ollama_url, model)
"""

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

# ─── Heuristics ───────────────────────────────────────────────────────────────

_HEADER_RE  = re.compile(r"^(diff --git |--- a/|\+\+\+ b/|@@ )", re.MULTILINE)
_PATH_RE    = re.compile(r"^(?:---|\+\+\+) [ab]/(.+)$", re.MULTILINE)
_HUNK_RE    = re.compile(r"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@", re.MULTILINE)

SKIP_PATH_PATTERNS = [
    re.compile(p) for p in [
        r"package-lock\.json$", r"yarn\.lock$", r"\.snap$", r"dist/", r"node_modules/",
    ]
]


def _changed_line_count(diff: str) -> int:
    return sum(
        1 for l in diff.splitlines()
        if (l.startswith("+") or l.startswith("-"))
        and not l.startswith(("+++", "---"))
    )


def _file_paths(diff: str) -> list[str]:
    return [m.group(1) for m in _PATH_RE.finditer(diff)]


def heuristic_score(diff: str) -> tuple[float, dict]:
    details: dict = {}

    if not diff.strip():
        return 0.0, {"reason": "empty diff"}

    # Format validity
    has_header = bool(_HEADER_RE.search(diff))
    has_hunk   = bool(_HUNK_RE.search(diff))
    fmt_score  = 1.0 if (has_header and has_hunk) else (0.5 if has_header else 0.0)
    details["format"] = fmt_score

    # Changed-line count: 1-30 = ideal, 31-80 = ok, >80 = suspicious
    n_changed = _changed_line_count(diff)
    if n_changed == 0:
        size_score = 0.0
    elif n_changed <= 30:
        size_score = 1.0
    elif n_changed <= 80:
        size_score = 1.0 - (n_changed - 30) / 100
    else:
        size_score = 0.2
    details["size_score"] = round(size_score, 3)
    details["changed_lines"] = n_changed

    # File count: 1-3 = ideal, more = suspicious
    paths = _file_paths(diff)
    noisy = [p for p in paths if any(pat.search(p) for pat in SKIP_PATH_PATTERNS)]
    clean_paths = [p for p in paths if p not in noisy]
    n_files = len(clean_paths)
    if n_files == 0:
        file_score = 0.0
    elif n_files <= 3:
        file_score = 1.0
    else:
        file_score = max(0.0, 1.0 - (n_files - 3) * 0.15)
    details["file_score"]  = round(file_score, 3)
    details["files"]       = clean_paths[:5]
    details["noisy_files"] = noisy

    # Deletion ratio: if >60% of changed lines are deletions, suspicious (rewrite)
    plus_lines  = sum(1 for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++"))
    minus_lines = sum(1 for l in diff.splitlines() if l.startswith("-") and not l.startswith("---"))
    if plus_lines + minus_lines > 0:
        del_ratio = minus_lines / (plus_lines + minus_lines)
        rewrite_penalty = max(0.0, del_ratio - 0.7)  # penalty starts at 70% deletions
    else:
        rewrite_penalty = 0.0
    details["deletion_ratio"]   = round(del_ratio if plus_lines + minus_lines > 0 else 0.0, 3)
    details["rewrite_penalty"]  = round(rewrite_penalty, 3)

    composite = (
        0.30 * fmt_score
        + 0.35 * size_score
        + 0.25 * file_score
        - 0.40 * rewrite_penalty
    )
    return max(0.0, min(1.0, composite)), details


# ─── LLM self-evaluation ──────────────────────────────────────────────────────

_FLOAT_RE = re.compile(r"\b(0\.\d+|1\.0|0|1)\b")

INTROSPECT_PROMPT_TMPL = """\
Evaluate this proposed code change and respond with ONLY a decimal number from 0.0 to 1.0.

Scoring criteria:
  1.0  = minimal, correct, no side effects, clean diff format
  0.7  = correct but slightly over-edited
  0.4  = probably correct but changes unrelated code
  0.1  = rewrites too much or breaks format
  0.0  = clearly wrong or empty

### Instruction (what the change is supposed to do):
{instruction}

### Proposed diff:
{diff}

Respond with ONLY a single number like: 0.82"""


def _call_openai_compat(prompt: str, base_url: str, api_key: str, model: str) -> str:
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": 8,
    }).encode()
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        return data["choices"][0]["message"]["content"]


def _call_ollama(prompt: str, base_url: str, model: str) -> str:
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0.0, "num_predict": 8},
    }).encode()
    req = urllib.request.Request(
        f"{base_url}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        return data.get("message", {}).get("content", "")


def llm_score(diff: str, instruction: str, mesh_url: str, ollama_url: str, model: str) -> float | None:
    prompt = INTROSPECT_PROMPT_TMPL.format(
        instruction=instruction[:500],
        diff=diff[:2000],
    )
    try:
        if mesh_url:
            raw = _call_openai_compat(prompt, f"{mesh_url}/v1", "mesh", model)
        elif ollama_url:
            raw = _call_ollama(prompt, ollama_url, model)
        else:
            return None
        m = _FLOAT_RE.search(raw.strip())
        if m:
            return min(1.0, max(0.0, float(m.group(1))))
    except Exception as e:
        print(f"  [score] LLM introspection failed: {e}", file=sys.stderr)
    return None


# ─── Composite scoring ────────────────────────────────────────────────────────

def score_diff(
    diff: str,
    instruction: str,
    mesh_url: str = "http://localhost:9337",
    ollama_url: str = "http://localhost:11434",
    model: str = "meitheal-tuned",
    use_llm: bool = True,
    apply_threshold: float = 0.60,
    escalate_threshold: float = 0.35,
) -> dict:
    h_score, h_details = heuristic_score(diff)
    l_score: float | None = None

    if use_llm and diff.strip():
        l_score = llm_score(diff, instruction, mesh_url, ollama_url, model)

    if l_score is not None:
        composite = 0.40 * h_score + 0.60 * l_score
    else:
        composite = h_score

    if composite >= apply_threshold:
        recommendation = "apply"
    elif composite >= escalate_threshold:
        recommendation = "retry"
    else:
        recommendation = "escalate"

    return {
        "score":          round(composite, 3),
        "heuristic":      round(h_score, 3),
        "llm":            round(l_score, 3) if l_score is not None else None,
        "recommendation": recommendation,
        "details":        h_details,
    }


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Score a code diff before applying it")
    parser.add_argument("--diff",        default=None,                    help="Path to diff file (stdin if omitted)")
    parser.add_argument("--instruction", default="",                      help="What the diff is supposed to do")
    parser.add_argument("--mesh-url",    default="http://localhost:9337",  help="MeshLLM base URL")
    parser.add_argument("--ollama-url",  default="http://localhost:11434", help="Ollama base URL")
    parser.add_argument("--model",       default="meitheal-tuned",        help="Model for LLM introspection")
    parser.add_argument("--no-llm",      action="store_true",             help="Skip LLM self-evaluation (heuristics only)")
    parser.add_argument("--threshold",   type=float, default=0.60,        help="Minimum score to recommend apply (default: 0.60)")
    parser.add_argument("--quiet",       action="store_true",             help="Print only the score number")
    args = parser.parse_args()

    if args.diff:
        diff_text = Path(args.diff).read_text(encoding="utf-8", errors="replace")
    elif not sys.stdin.isatty():
        diff_text = sys.stdin.read()
    else:
        parser.error("Provide --diff <file> or pipe diff on stdin")

    result = score_diff(
        diff_text,
        args.instruction,
        mesh_url=args.mesh_url,
        ollama_url=args.ollama_url,
        model=args.model,
        use_llm=not args.no_llm,
        apply_threshold=args.threshold,
    )

    if args.quiet:
        print(result["score"])
    else:
        print(json.dumps(result, indent=2))

    sys.exit(0 if result["recommendation"] == "apply" else 1)


if __name__ == "__main__":
    main()
