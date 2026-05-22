#!/usr/bin/env python3
"""
negotiate.py  —  Multi-agent negotiation for diff generation.

Two models independently generate diffs, critique each other's output,
then a reconciler produces a final diff incorporating the best of both.

Pipeline:
  1. Agent A generates diff (low temperature, primary model)
  2. Agent B generates diff (higher temperature or alternate model)
  3. Critique: each agent reviews the other's diff
  4. Reconcile: final model call merges both with critique context
  5. Scoring: score all candidates, return best

Usage:
  python scripts/negotiate.py --task "Fix null ref in spawn-agent.ts" \\
      --model-a SDLC Framework-tuned --model-b qwen3:8b --reconciler qwen3:14b

  python scripts/negotiate.py --task "..." --score-only
"""

import argparse
import json
import urllib.request
from pathlib import Path

MAX_CONTEXT = 6000  # chars per diff fed into critique


def _call_model(
    messages: list[dict],
    url: str,
    model: str,
    temperature: float = 0.1,
    max_tokens: int = 2048,
) -> str:
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
    req = urllib.request.Request(
        f"{url}/v1/chat/completions", data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"[LLM ERROR: {e}]"


# ─── Generation ───────────────────────────────────────────────────────────────

_GEN_SYSTEM = "Output ONLY a unified diff. No explanation, no markdown fences, no commentary."

_GEN_USER = """\
Fix the following issue with a minimal unified diff:

{task}

Requirements:
- Output only the diff, nothing else
- Keep changes minimal and targeted
- Use proper unified diff format (--- a/file, +++ b/file, @@ ... @@)
"""


def generate_diff(task: str, url: str, model: str, temperature: float = 0.1) -> str:
    return _call_model(
        [{"role": "system", "content": _GEN_SYSTEM},
         {"role": "user",   "content": _GEN_USER.format(task=task)}],
        url, model, temperature=temperature,
    )


# ─── Critique ─────────────────────────────────────────────────────────────────

_CRITIQUE_SYSTEM = "You are a code reviewer. Be concise and specific."

_CRITIQUE_USER = """\
Review this diff for the task: {task}

```diff
{diff}
```

Identify (max 5 bullets, start with + for good, - for bad):
- bugs or incorrect logic
- missing edge cases
- changes that are too broad or too narrow
- format issues (missing headers, wrong paths)
"""


def critique_diff(task: str, diff: str, url: str, model: str) -> str:
    return _call_model(
        [{"role": "system", "content": _CRITIQUE_SYSTEM},
         {"role": "user",   "content": _CRITIQUE_USER.format(task=task, diff=diff[:MAX_CONTEXT])}],
        url, model, temperature=0.1, max_tokens=512,
    )


# ─── Reconciliation ───────────────────────────────────────────────────────────

_RECONCILE_SYSTEM = "Output ONLY a unified diff. No explanation, no markdown fences, no commentary."

_RECONCILE_USER = """\
Two agents proposed different fixes. Produce the best single diff.

Task: {task}

Agent A diff:
```diff
{diff_a}
```

Agent A's critique of B:
{critique_ab}

Agent B diff:
```diff
{diff_b}
```

Agent B's critique of A:
{critique_ba}

Produce one minimal, correct unified diff incorporating the best of both and addressing the critiques.
"""


def reconcile(
    task: str,
    diff_a: str, diff_b: str,
    critique_ab: str, critique_ba: str,
    url: str, model: str,
) -> str:
    return _call_model(
        [{"role": "system", "content": _RECONCILE_SYSTEM},
         {"role": "user",   "content": _RECONCILE_USER.format(
             task=task,
             diff_a=diff_a[:MAX_CONTEXT], diff_b=diff_b[:MAX_CONTEXT],
             critique_ab=critique_ab[:1000], critique_ba=critique_ba[:1000],
         )}],
        url, model, temperature=0.05, max_tokens=2048,
    )


# ─── Scoring ──────────────────────────────────────────────────────────────────

def _score(diff: str) -> float:
    lines = diff.splitlines()
    if not lines:
        return 0.0
    score = 0.0
    if any(l.startswith("---") for l in lines):
        score += 0.25
    if any(l.startswith("+++") for l in lines):
        score += 0.05
    if any(l.startswith("@@") for l in lines):
        score += 0.20
    added   = sum(1 for l in lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))
    total   = added + removed
    if 1 <= total <= 50:
        score += 0.30
    elif total > 50:
        score += 0.10
    if total > 0:
        score += 0.20 * (min(added, removed) / total)
    return round(score, 3)


def pick_best(candidates: list[tuple[str, str]]) -> tuple[str, str, float]:
    scored = sorted([(label, diff, _score(diff)) for label, diff in candidates], key=lambda x: -x[2])
    return scored[0]


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Multi-agent diff negotiation")
    parser.add_argument("--task",        required=True)
    parser.add_argument("--model-a",     default="SDLC Framework-tuned",       help="Primary agent model")
    parser.add_argument("--model-b",     default="qwen3:8b",             help="Secondary agent model")
    parser.add_argument("--reconciler",  default="",                     help="Reconciler model (default: model-b)")
    parser.add_argument("--temp-a",      type=float, default=0.1)
    parser.add_argument("--temp-b",      type=float, default=0.5)
    parser.add_argument("--mesh-url",    default="http://localhost:9337")
    parser.add_argument("--score-only",  action="store_true",            help="Return best candidate without reconciling")
    parser.add_argument("--output",      default="",                     help="Write winning diff to file")
    parser.add_argument("--verbose",     action="store_true")
    args = parser.parse_args()

    url        = args.mesh_url
    reconciler = args.reconciler or args.model_b
    task       = args.task

    print(f"[negotiate] task    : {task[:80]}")
    print(f"[negotiate] agent-a : {args.model_a}  temp={args.temp_a}")
    print(f"[negotiate] agent-b : {args.model_b}  temp={args.temp_b}")
    print()

    print("[1/4] Agent A generating diff...")
    diff_a = generate_diff(task, url, args.model_a, args.temp_a)
    print(f"      {len(diff_a.splitlines())} lines  score={_score(diff_a):.3f}")

    print("[2/4] Agent B generating diff...")
    diff_b = generate_diff(task, url, args.model_b, args.temp_b)
    print(f"      {len(diff_b.splitlines())} lines  score={_score(diff_b):.3f}")

    if args.score_only:
        label, best, score = pick_best([("A", diff_a), ("B", diff_b)])
        print(f"\n[score-only] Best: Agent {label} (score={score:.3f})")
        _output(best, args.output)
        return

    print("[3/4] Cross-critique...")
    critique_ab = critique_diff(task, diff_b, url, args.model_a)  # A critiques B
    critique_ba = critique_diff(task, diff_a, url, args.model_b)  # B critiques A

    if args.verbose:
        print(f"\n  A's critique of B:\n{critique_ab}\n")
        print(f"  B's critique of A:\n{critique_ba}\n")

    print(f"[4/4] Reconciling with {reconciler}...")
    final = reconcile(task, diff_a, diff_b, critique_ab, critique_ba, url, reconciler)

    label, best, score = pick_best([("A", diff_a), ("B", diff_b), ("reconciled", final)])
    print(f"\n[result] Best: {label} (score={score:.3f})")

    if args.verbose:
        for lbl, d in [("A", diff_a), ("B", diff_b), ("reconciled", final)]:
            print(f"  {lbl}: score={_score(d):.3f}  lines={len(d.splitlines())}")

    _output(best, args.output)


def _output(diff: str, path: str) -> None:
    if path:
        Path(path).write_text(diff, encoding="utf-8")
        print(f"Written to {path}")
    else:
        print("\n" + diff)


if __name__ == "__main__":
    main()
