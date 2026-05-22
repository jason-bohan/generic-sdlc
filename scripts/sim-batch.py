#!/usr/bin/env python3
"""
sim-batch.py  —  Simulated training environment: generate, apply, test, record.

Loads tasks from aider_dataset.jsonl, generates diffs via local model API,
applies each diff to a sandboxed git state (stash -> apply -> test -> restore),
and records the pass/fail result as new labeled training data.

This creates a feedback loop without touching real code: every run produces
labelled examples that the trainer service can pick up on its next cycle.

Usage:
  python scripts/sim-batch.py --limit 20
  python scripts/sim-batch.py --adversarial --limit 10
  python scripts/sim-batch.py --generate-tasks --cluster null_ref --limit 5
  python scripts/sim-batch.py --model qwen3:8b --test "npx vitest run --reporter=verbose"
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUTPUT_FILE = Path("aider_dataset.jsonl")

# ─── Adversarial mutations ────────────────────────────────────────────────────

_MUTATIONS = [
    lambda s: s.replace("Fix", "Handle the case where") if "Fix" in s else s,
    lambda s: s + " without breaking existing tests",
    lambda s: s + " (note: the value may be null or undefined)",
    lambda s: ("Under high load: " + s) if not s.startswith("Under") else s,
    lambda s: s.replace(" the ", " a potentially missing ") if " the " in s else s,
]


def _mutate(instruction: str) -> str:
    import random
    return random.choice(_MUTATIONS)(instruction)


# ─── Diff generation ──────────────────────────────────────────────────────────

_GEN_SYSTEM = "Output ONLY a unified diff. No explanation, no markdown fences, no commentary."
_GEN_USER   = """\
Apply a minimal fix for the following task:

{instruction}

Output only a proper unified diff (--- a/file, +++ b/file, @@ lines @@).
"""


def generate_diff(instruction: str, url: str, model: str) -> str:
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": _GEN_SYSTEM},
            {"role": "user",   "content": _GEN_USER.format(instruction=instruction)},
        ],
        "temperature": 0.2,
        "max_tokens":  1024,
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
    req = urllib.request.Request(
        f"{url}/v1/chat/completions", data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"[LLM ERROR: {e}]"


def _is_valid_diff(diff: str) -> bool:
    lines = diff.splitlines()
    return (
        any(l.startswith("---") for l in lines) and
        any(l.startswith("+++") for l in lines) and
        any(l.startswith("@@")  for l in lines)
    )


# ─── Sandboxed apply + test ───────────────────────────────────────────────────

def _run(cmd: list[str], cwd: str, timeout: int = 30) -> tuple[int, str]:
    r = subprocess.run(
        cmd, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )
    return r.returncode, r.stdout


def apply_and_test(diff: str, test_cmd: str, cwd: str) -> tuple[bool, str]:
    """
    Sandbox:
      1. git stash (save working tree)
      2. git apply --check (validate)
      3. git apply
      4. run tests
      5. git checkout -- . + git stash pop (restore)
    """
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".diff", encoding="utf-8", delete=False, dir=cwd
    ) as tf:
        tf.write(diff)
        diff_path = tf.name

    stashed = False
    applied = False
    try:
        rc, _ = _run(["git", "stash", "--include-untracked", "-m", "sim-batch"], cwd)
        stashed = (rc == 0)

        rc, out = _run(["git", "apply", "--check", diff_path], cwd)
        if rc != 0:
            return False, f"[apply --check failed]\n{out}"

        rc, out = _run(["git", "apply", diff_path], cwd)
        if rc != 0:
            return False, f"[apply failed]\n{out}"
        applied = True

        result = subprocess.run(
            test_cmd, shell=True, cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=300,
        )
        passed   = result.returncode == 0
        test_out = result.stdout[-2000:]
        return passed, test_out

    except subprocess.TimeoutExpired:
        return False, "[test timeout]"
    finally:
        if applied:
            _run(["git", "checkout", "--", "."], cwd)
        if stashed:
            _run(["git", "stash", "pop"], cwd)
        Path(diff_path).unlink(missing_ok=True)


# ─── Task loading ─────────────────────────────────────────────────────────────

_CLUSTER_TEMPLATES: dict[str, list[str]] = {
    "null_ref": [
        "Add null guard before accessing status property on agent object",
        "Fix null reference when agent config is not initialized",
        "Handle undefined case in fetchAgentStatus handler",
    ],
    "async_await": [
        "Add missing await to fetchAgentData async call",
        "Fix promise not being awaited in agentRunner service",
        "Handle async error in meshllm provider",
    ],
    "test_assertion": [
        "Fix failing test assertion for AgentCard component",
        "Update test expectation to match new handler return type",
        "Fix test that expects true but receives undefined",
    ],
    "timeout": [
        "Increase timeout for /api/agents endpoint",
        "Fix request timeout in agentRunner after retry",
    ],
    "import_error": [
        "Fix broken import path for meshllm module",
        "Add missing export from agent-drivers file",
    ],
}


def generate_synthetic_tasks(cluster: str, limit: int) -> list[dict]:
    templates = _CLUSTER_TEMPLATES.get(cluster, [f"Fix {cluster} issue in codebase"])
    return [
        {
            "instruction": templates[i % len(templates)],
            "response":    "",
            "_meta":       {"source": "generated", "cluster": cluster},
        }
        for i in range(limit)
    ]


def load_tasks(path: str, limit: int, cluster: str = "") -> list[dict]:
    p = Path(path)
    if not p.exists():
        return []
    tasks: list[dict] = []
    with p.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ex = json.loads(line)
            except json.JSONDecodeError:
                continue
            if cluster and ex.get("_meta", {}).get("cluster") != cluster:
                continue
            if ex.get("instruction"):
                tasks.append(ex)
            if len(tasks) >= limit:
                break
    return tasks


# ─── Result recording ─────────────────────────────────────────────────────────

def _append_result(
    output_file: Path,
    instruction: str,
    diff: str,
    result: str,
    model: str,
    source_task: dict,
) -> None:
    record = {
        "instruction": instruction,
        "response":    diff,
        "_meta": {
            "source":    "sim-batch",
            "model":     model,
            "result":    result,
            "cluster":   source_task.get("_meta", {}).get("cluster", ""),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    }
    with output_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# ─── Batch loop ───────────────────────────────────────────────────────────────

def run_batch(
    tasks: list[dict],
    url: str,
    model: str,
    test_cmd: str,
    cwd: str,
    adversarial: bool,
    output_file: Path,
    verbose: bool,
) -> dict:
    stats: dict[str, int] = {"total": 0, "passed": 0, "failed": 0, "invalid": 0}

    for i, task in enumerate(tasks):
        instruction = task["instruction"]
        if adversarial:
            instruction = _mutate(instruction)

        print(f"[{i+1}/{len(tasks)}] {instruction[:70]}")

        diff = generate_diff(instruction, url, model)

        if not _is_valid_diff(diff):
            print("  -> invalid diff (skipped)")
            stats["invalid"] += 1
            stats["total"]   += 1
            _append_result(output_file, instruction, diff, "invalid_diff", model, task)
            continue

        try:
            passed, test_out = apply_and_test(diff, test_cmd, cwd)
        except Exception as e:
            print(f"  -> error: {e}")
            stats["failed"] += 1
            stats["total"]  += 1
            continue

        result = "tests_passed" if passed else "tests_failed"
        stats["total"]  += 1
        stats["passed" if passed else "failed"] += 1
        print(f"  -> {result}")
        if verbose and not passed:
            print(f"     {test_out[-300:]}")

        _append_result(output_file, instruction, diff, result, model, task)

    return stats


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Simulated batch training environment")
    parser.add_argument("--tasks",          default="aider_dataset.jsonl")
    parser.add_argument("--output",         default="aider_dataset.jsonl")
    parser.add_argument("--limit",          type=int, default=20)
    parser.add_argument("--cluster",        default="",              help="Filter by cluster")
    parser.add_argument("--generate-tasks", action="store_true",     help="Synthesize tasks for --cluster")
    parser.add_argument("--adversarial",    action="store_true",     help="Mutate tasks with edge cases")
    parser.add_argument("--model",          default="SDLC Framework-tuned")
    parser.add_argument("--mesh-url",       default="http://localhost:9337")
    parser.add_argument("--test",           default="npx vitest run")
    parser.add_argument("--repo",           default=".")
    parser.add_argument("--verbose",        action="store_true")
    args = parser.parse_args()

    cwd         = str(Path(args.repo).resolve())
    output_file = Path(args.output)

    if args.generate_tasks:
        if not args.cluster:
            print("--generate-tasks requires --cluster")
            sys.exit(1)
        tasks = generate_synthetic_tasks(args.cluster, args.limit)
        print(f"Generated {len(tasks)} synthetic tasks for cluster '{args.cluster}'")
    else:
        tasks = load_tasks(args.tasks, args.limit, args.cluster)
        if not tasks:
            print(f"No tasks found in {args.tasks}")
            sys.exit(1)

    print(f"Model      : {args.model}")
    print(f"Tasks      : {len(tasks)}")
    print(f"Test cmd   : {args.test}")
    print(f"Adversarial: {args.adversarial}")
    print()

    stats = run_batch(
        tasks=tasks, url=args.mesh_url, model=args.model,
        test_cmd=args.test, cwd=cwd, adversarial=args.adversarial,
        output_file=output_file, verbose=args.verbose,
    )

    print(f"\nResults : {stats['passed']}/{stats['total']} passed, "
          f"{stats['failed']} failed, {stats['invalid']} invalid")
    print(f"Appended: {output_file}")


if __name__ == "__main__":
    main()
