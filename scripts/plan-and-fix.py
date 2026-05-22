#!/usr/bin/env python3
"""
plan-and-fix.py  —  Hierarchical planning + execution for complex multi-step fixes.

Unlike fix-pipeline.py (which loops on the same failing output), this script:
  1. Calls a model to decompose the goal into ordered micro-steps
  2. Executes each step via Aider --message-file
  3. After each step, checks a configurable condition (tests, tsc, etc.)
  4. On step failure: replans the remaining steps with full context
  5. Confidence-gates each step (optional) using score-diff.py

The planner outputs JSON so steps are structured, not free-form chat.

Usage:
  # Fix a failing test suite
  python scripts/plan-and-fix.py --goal "Fix all failing Vitest tests"

  # Multi-step feature from a description
  python scripts/plan-and-fix.py \\
      --goal "Add rate limiting to the /api/agents endpoints" \\
      --check "npx vitest run" \\
      --max-steps 8 --score-threshold 0.5

  # Use Claude for planning, local model for execution
  python scripts/plan-and-fix.py \\
      --goal "Refactor agent-drivers.ts to support the aider driver" \\
      --planner-url https://openrouter.ai/api/v1 \\
      --planner-key sk-... \\
      --planner-model anthropic/claude-sonnet-4
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime
from pathlib import Path

SCRIPTS_DIR    = Path(__file__).parent
REPO_ROOT      = SCRIPTS_DIR.parent
COLLECT_SCRIPT = SCRIPTS_DIR / "collect-training-data.py"
SCORE_SCRIPT   = SCRIPTS_DIR / "score-diff.py"

# ─── Prompt templates ─────────────────────────────────────────────────────────

PLAN_PROMPT = """\
You are a software engineering planner. Break the following goal into an ordered list of small, targeted code-change steps.

Requirements:
- Each step must be a concrete, actionable instruction for a code editing agent (Aider)
- Steps must be in execution order (later steps may depend on earlier ones)
- Keep each step focused on one thing (one function, one file, one concern)
- Maximum {max_steps} steps
- Output ONLY a JSON array of strings, no other text

Goal:
{goal}

Relevant context:
{context}

Output format (JSON array only):
["step 1 description", "step 2 description", ...]"""

REPLAN_PROMPT = """\
A step in a multi-step code fix has failed. Replan the remaining steps.

Original goal:
{goal}

Steps completed so far:
{completed}

Failed step:
{failed_step}

Failure output:
{failure_output}

Output ONLY a JSON array of the revised remaining steps (excluding completed ones), no other text:
["revised step 1", "revised step 2", ...]"""


# ─── LLM caller ───────────────────────────────────────────────────────────────

def _call_api(
    prompt: str,
    base_url: str,
    api_key: str,
    model: str,
    max_tokens: int = 1024,
) -> str:
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": max_tokens,
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
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
        return data["choices"][0]["message"]["content"]


def _call_ollama(prompt: str, base_url: str, model: str, max_tokens: int = 1024) -> str:
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": max_tokens},
    }).encode()
    req = urllib.request.Request(
        f"{base_url}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
        return data.get("message", {}).get("content", "")


def call_planner(
    prompt: str,
    planner_url: str,
    planner_key: str,
    planner_model: str,
    mesh_url: str,
    ollama_url: str,
    executor_model: str,
) -> str:
    """Call the planner model — prefers a dedicated planner, falls back to executor."""
    if planner_url and planner_key:
        return _call_api(prompt, planner_url, planner_key, planner_model)
    if mesh_url:
        return _call_api(prompt, f"{mesh_url}/v1", "mesh", executor_model, max_tokens=1024)
    return _call_ollama(prompt, ollama_url, executor_model, max_tokens=1024)


# ─── Plan parsing ──────────────────────────────────────────────────────────────

_JSON_ARRAY_RE = re.compile(r"\[[\s\S]*?\]")


def parse_plan(raw: str) -> list[str]:
    """Extract a JSON array of strings from model output (handles markdown fences)."""
    # Strip markdown fences
    raw = re.sub(r"```json?\s*", "", raw)
    raw = re.sub(r"```\s*", "", raw)

    # Find first JSON array
    m = _JSON_ARRAY_RE.search(raw)
    if not m:
        # Fall back: split on numbered list
        lines = [l.strip() for l in raw.splitlines() if l.strip()]
        steps = []
        for l in lines:
            l = re.sub(r"^\d+[\.\)]\s*", "", l)
            if l:
                steps.append(l)
        return steps[:20]

    try:
        parsed = json.loads(m.group(0))
        if isinstance(parsed, list):
            return [str(s).strip() for s in parsed if s]
    except json.JSONDecodeError:
        pass
    return []


# ─── Aider execution ──────────────────────────────────────────────────────────

def run_aider(
    instruction: str,
    mesh_url: str,
    ollama_url: str,
    model: str,
    cwd: Path,
    dry_run: bool,
) -> bool:
    aider_exe = os.environ.get("AIDER_PATH", "aider")

    with tempfile.NamedTemporaryFile(
        mode="w", suffix="-plan-step.txt", encoding="utf-8",
        delete=False, dir=str(cwd),
    ) as tf:
        tf.write(instruction)
        prompt_file = Path(tf.name)

    cmd = [
        aider_exe,
        "--yes-always",
        "--no-auto-commits",
        "--map-tokens", "0",
        "--no-show-model-warnings",
        "--no-check-update",
        "--message-file", str(prompt_file),
    ]
    if mesh_url:
        cmd += ["--openai-api-base", f"{mesh_url}/v1", "--openai-api-key", "mesh",
                "--model", f"openai/{model}"]
    elif ollama_url:
        cmd += ["--openai-api-base", f"{ollama_url}/v1", "--openai-api-key", "ollama",
                "--model", f"openai/{model}"]

    try:
        if dry_run:
            print(f"    [dry-run] aider: {instruction[:80]}")
            return True
        result = subprocess.run(cmd, cwd=str(cwd), text=True, encoding="utf-8", errors="replace")
        return result.returncode == 0
    finally:
        prompt_file.unlink(missing_ok=True)


def run_check(cmd: str, cwd: Path, timeout: int = 300) -> tuple[bool, str]:
    result = subprocess.run(
        cmd, shell=True, cwd=str(cwd),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        timeout=timeout,
    )
    return result.returncode == 0, result.stdout


def get_git_diff(cwd: Path) -> str:
    result = subprocess.run(
        ["git", "diff"], cwd=str(cwd),
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", errors="replace",
    )
    return result.stdout


def git_has_changes(cwd: Path) -> bool:
    r = subprocess.run(["git", "diff", "--quiet"], cwd=str(cwd),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return r.returncode != 0


def git_commit(msg: str, cwd: Path) -> str | None:
    subprocess.run(["git", "add", "-u"], cwd=str(cwd), check=True)
    r = subprocess.run(["git", "commit", "-m", msg], cwd=str(cwd),
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None
    m = re.search(r"([0-9a-f]{7,})", r.stdout)
    return m.group(1) if m else None


def score_diff_subprocess(diff: str, instruction: str, mesh_url: str, ollama_url: str, threshold: float) -> float:
    """Call score-diff.py as subprocess. Returns composite score 0-1."""
    if not SCORE_SCRIPT.exists() or not diff.strip():
        return 1.0  # skip scoring if script not available
    with tempfile.NamedTemporaryFile(mode="w", suffix=".diff", encoding="utf-8", delete=False) as tf:
        tf.write(diff)
        diff_file = tf.name
    try:
        r = subprocess.run(
            [sys.executable, str(SCORE_SCRIPT),
             "--diff", diff_file,
             "--instruction", instruction[:200],
             "--mesh-url", mesh_url,
             "--ollama-url", ollama_url,
             "--quiet"],
            capture_output=True, text=True, timeout=40,
        )
        raw = r.stdout.strip()
        return float(raw) if raw else 0.5
    except Exception:
        return 0.5
    finally:
        Path(diff_file).unlink(missing_ok=True)


# ─── Main planner loop ────────────────────────────────────────────────────────

def plan_and_fix(
    goal: str,
    planner_url: str,
    planner_key: str,
    planner_model: str,
    mesh_url: str,
    ollama_url: str,
    executor_model: str,
    check_cmd: str,
    max_steps: int,
    score_threshold: float,
    cwd: Path,
    dry_run: bool,
) -> bool:
    print("=" * 60)
    print(f"Goal: {goal}")
    print(f"Check: {check_cmd or '(none)'}")
    print()

    # Get initial context (test output, compiler errors)
    context = ""
    if check_cmd:
        passed, output = run_check(check_cmd, cwd)
        if passed:
            print("✅ Check already passing — nothing to do.")
            return True
        context = "\n".join(output.splitlines()[-40:])

    # Create macro plan
    print("[plan] Generating plan...")
    plan_prompt = PLAN_PROMPT.format(
        goal=goal,
        context=context[:2000] if context else "No pre-check output available.",
        max_steps=max_steps,
    )
    try:
        raw_plan = call_planner(
            plan_prompt, planner_url, planner_key, planner_model,
            mesh_url, ollama_url, executor_model,
        )
    except Exception as e:
        print(f"[plan] ERROR calling planner: {e}")
        return False

    steps = parse_plan(raw_plan)
    if not steps:
        print(f"[plan] ERROR: could not parse plan from:\n{raw_plan[:300]}")
        return False

    print(f"[plan] {len(steps)} steps:")
    for i, s in enumerate(steps, 1):
        print(f"  {i}. {s}")
    print()

    completed: list[str] = []
    commits: list[str] = []

    step_idx = 0
    while step_idx < len(steps):
        step = steps[step_idx]
        step_num = step_idx + 1
        print(f"{'─'*50}")
        print(f"Step {step_num}/{len(steps)}: {step}")

        # Execute step
        t0 = time.time()
        aider_ok = run_aider(step, mesh_url, ollama_url, executor_model, cwd, dry_run)
        elapsed = time.time() - t0
        print(f"  Aider finished in {elapsed:.1f}s")

        # Confidence gate on the produced diff
        if not dry_run and score_threshold > 0:
            diff = get_git_diff(cwd)
            if diff:
                conf = score_diff_subprocess(diff, step, mesh_url, ollama_url, score_threshold)
                print(f"  Confidence: {conf:.3f} (threshold {score_threshold})")
                if conf < score_threshold:
                    print(f"  ⚠ Low confidence — reverting step and replanning")
                    subprocess.run(["git", "checkout", "."], cwd=str(cwd),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    # Replan remaining
                    replan_prompt = REPLAN_PROMPT.format(
                        goal=goal,
                        completed="\n".join(f"  ✓ {s}" for s in completed),
                        failed_step=step,
                        failure_output=f"Confidence score too low: {conf:.3f}",
                    )
                    try:
                        raw = call_planner(replan_prompt, planner_url, planner_key, planner_model,
                                           mesh_url, ollama_url, executor_model)
                        new_steps = parse_plan(raw)
                        if new_steps:
                            steps = steps[:step_idx] + new_steps
                            print(f"  Replanned: {len(new_steps)} remaining steps")
                    except Exception as e:
                        print(f"  Replan failed: {e}")
                    step_idx += 1
                    continue

        # Commit step changes
        if not dry_run and git_has_changes(cwd):
            ts = datetime.now().strftime("%H%M%S")
            msg = f"fix(plan): step {step_num} — {step[:60]} [{ts}]"
            commit_hash = git_commit(msg, cwd)
            if commit_hash:
                commits.append(commit_hash)

        completed.append(step)

        # Check condition after step (optional)
        if check_cmd:
            passed, output = run_check(check_cmd, cwd)
            if passed:
                print(f"  ✅ Check passing after step {step_num}!")
                break
            if step_idx < len(steps) - 1:
                # Replan remaining steps with new failure context
                print(f"  Check still failing — replanning remaining steps")
                remaining_context = "\n".join(output.splitlines()[-30:])
                replan_prompt = REPLAN_PROMPT.format(
                    goal=goal,
                    completed="\n".join(f"  ✓ {s}" for s in completed),
                    failed_step=steps[step_idx + 1] if step_idx + 1 < len(steps) else "(next step)",
                    failure_output=remaining_context,
                )
                try:
                    raw = call_planner(replan_prompt, planner_url, planner_key, planner_model,
                                       mesh_url, ollama_url, executor_model)
                    new_remaining = parse_plan(raw)
                    if new_remaining:
                        steps = steps[:step_idx + 1] + new_remaining
                        print(f"  Replanned: {len(new_remaining)} remaining steps")
                except Exception as e:
                    print(f"  Replan failed: {e}")

        step_idx += 1

    # Collect training data from all step commits
    if commits and not dry_run:
        r = subprocess.run(
            [sys.executable, str(COLLECT_SCRIPT), "git"],
            cwd=str(cwd), capture_output=True, text=True,
        )
        if r.returncode == 0:
            print(f"\n[collect] {len(commits)} commit(s) added to training data")

    # Final check
    if check_cmd:
        passed, _ = run_check(check_cmd, cwd)
        if passed:
            print(f"\n✅ Goal achieved in {len(completed)} step(s)")
            return True
        else:
            print(f"\n⚠ Goal not fully achieved after {len(completed)} step(s)")
            return False

    print(f"\n✅ {len(completed)} step(s) executed")
    return True


def main():
    parser = argparse.ArgumentParser(description="Hierarchical plan-and-fix agent")
    parser.add_argument("--goal",           required=True,                              help="High-level goal description")
    parser.add_argument("--check",          default="",                                 help="Check command to run after each step (e.g. 'npx vitest run')")
    parser.add_argument("--max-steps",      type=int, default=6,                        help="Max steps in plan (default: 6)")
    parser.add_argument("--score-threshold", type=float, default=0.0,                  help="Min diff confidence to accept a step (0=disabled)")
    parser.add_argument("--mesh-url",       default="http://localhost:9337",            help="MeshLLM URL for execution")
    parser.add_argument("--ollama-url",     default="http://localhost:11434",           help="Ollama URL fallback")
    parser.add_argument("--model",          default="SDLC Framework-tuned",                  help="Executor model")
    parser.add_argument("--planner-url",    default="",                                help="OpenAI-compat URL for planner (optional; uses executor if omitted)")
    parser.add_argument("--planner-key",    default="",                                help="API key for planner URL")
    parser.add_argument("--planner-model",  default="anthropic/claude-sonnet-4",       help="Model to use for planning (default: claude-sonnet-4)")
    parser.add_argument("--repo",           default=".",                               help="Repo directory")
    parser.add_argument("--dry-run",        action="store_true",                       help="Show plan without executing")
    args = parser.parse_args()

    planner_key = args.planner_key or os.environ.get("OPENROUTER_API_KEY", "")

    success = plan_and_fix(
        goal=args.goal,
        planner_url=args.planner_url,
        planner_key=planner_key,
        planner_model=args.planner_model,
        mesh_url=args.mesh_url,
        ollama_url=args.ollama_url,
        executor_model=args.model,
        check_cmd=args.check,
        max_steps=args.max_steps,
        score_threshold=args.score_threshold,
        cwd=Path(args.repo).resolve(),
        dry_run=args.dry_run,
    )
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
