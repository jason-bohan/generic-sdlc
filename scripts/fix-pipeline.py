#!/usr/bin/env python3
"""
fix-pipeline.py  —  Autonomous test-failure fixer using Aider + MeshLLM.

Loop:
  1. Run test command
  2. If failing: write failure log to prompt file → run Aider → go to 1
  3. If passing: commit the fix → collect training data from the commit
  4. Repeat up to --max-attempts times

The fixed code becomes training data automatically via collect-training-data.py.
Use --dry-run to see what would happen without touching git.

Usage:
  python scripts/fix-pipeline.py [options]

Examples:
  # Default: npm test, MeshLLM, up to 5 attempts
  python scripts/fix-pipeline.py

  # Custom test command, Ollama fallback, 10 attempts
  python scripts/fix-pipeline.py --test "npx vitest run" --mesh-url "" --max-attempts 10

  # TypeScript compile errors only
  python scripts/fix-pipeline.py --test "npx tsc --noEmit" --commit-msg "fix(ts): resolve type errors"
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

SCRIPTS_DIR    = Path(__file__).parent
REPO_ROOT      = SCRIPTS_DIR.parent
COLLECT_SCRIPT = SCRIPTS_DIR / "collect-training-data.py"
SCORE_SCRIPT   = SCRIPTS_DIR / "score-diff.py"
MAX_SELF_CHANGE_FILES = 3
SELF_CHANGE_ALLOWED_PREFIXES = ("scripts/", "src/server/", "src/test/", "ml/unsloth/")

AIDER_SYSTEM_PREFIX = """\
You are a coding agent fixing test failures.
Rules:
- Make MINIMAL changes to make tests pass
- Do NOT rewrite unrelated code
- Do NOT add new dependencies without strong reason
- Do NOT modify test files unless the test itself is wrong
- Output only code changes, no explanations

"""

# ─── Helpers ──────────────────────────────────────────────────────────────────

def run_tests(cmd: str, cwd: Path) -> tuple[bool, str]:
    """Run test command. Returns (passed, output)."""
    result = subprocess.run(
        cmd, shell=True, cwd=str(cwd),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        timeout=300,
    )
    passed = result.returncode == 0
    return passed, result.stdout


def trim_log(output: str, max_lines: int = 100) -> str:
    """Keep the last max_lines lines (where the failure signal is densest)."""
    lines = output.splitlines()
    if len(lines) <= max_lines:
        return output
    kept = lines[-max_lines:]
    skipped = len(lines) - max_lines
    return f"... [{skipped} lines trimmed] ...\n" + "\n".join(kept)


def run_aider(
    prompt_file: Path,
    mesh_url: str,
    ollama_url: str,
    model: str,
    cwd: Path,
    dry_run: bool,
) -> bool:
    """
    Run Aider with --message-file pointing at the prompt.
    Returns True if Aider exited cleanly (exit code 0).
    """
    aider_exe = os.environ.get("AIDER_PATH", "aider")

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

    if dry_run:
        print(f"  [dry-run] would run: {' '.join(cmd)}")
        return True

    result = subprocess.run(cmd, cwd=str(cwd), text=True, encoding="utf-8", errors="replace")
    return result.returncode == 0


def git_has_changes(cwd: Path) -> bool:
    result = subprocess.run(
        ["git", "diff", "--quiet"], cwd=str(cwd),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return result.returncode != 0  # non-zero = has changes


def git_commit_fix(msg: str, cwd: Path) -> str | None:
    """Stage all changes and commit. Returns commit hash or None on failure."""
    subprocess.run(["git", "add", "-u"], cwd=str(cwd), check=True)
    result = subprocess.run(
        ["git", "commit", "-m", msg],
        cwd=str(cwd), capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"  [commit] failed: {result.stderr.strip()}")
        return None
    # Extract hash from "master abc1234" style output
    m = re.search(r"([0-9a-f]{7,})", result.stdout)
    return m.group(1) if m else None


def _get_git_diff(cwd: Path) -> str:
    r = subprocess.run(["git", "diff"], cwd=str(cwd),
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                       text=True, encoding="utf-8", errors="replace")
    return r.stdout


def _changed_files_from_diff(diff: str) -> list[str]:
    files: list[str] = []
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                path = parts[2]
                if path.startswith("a/"):
                    path = path[2:]
                if path not in files:
                    files.append(path)
    return files


def evaluate_self_change_gate(
    diff: str,
    simulation_result: dict,
    rollback_ref: str,
    human_checkpoint: str = "",
    max_files: int = MAX_SELF_CHANGE_FILES,
) -> dict:
    """Fail closed unless self-modifying changes are simulated, reversible, and bounded."""
    changed_files = _changed_files_from_diff(diff)
    reasons = []
    simulation_passed = simulation_result.get("passed") is True

    if not simulation_passed:
        reasons.append("simulation_not_passed")
    if not rollback_ref:
        reasons.append("missing_rollback_ref")
    if not human_checkpoint:
        reasons.append("missing_human_checkpoint")
    if len(changed_files) > max_files:
        reasons.append("scope_too_large")

    out_of_scope = [
        p for p in changed_files
        if not any(p.startswith(prefix) for prefix in SELF_CHANGE_ALLOWED_PREFIXES)
    ]
    if out_of_scope:
        reasons.append("path_out_of_scope")

    return {
        "approved": len(reasons) == 0,
        "reasons": reasons,
        "changed_files": changed_files,
        "max_files": max_files,
        "rollback_ref": rollback_ref,
        "human_checkpoint": human_checkpoint,
        "simulation": simulation_result,
        "allowed_prefixes": list(SELF_CHANGE_ALLOWED_PREFIXES),
    }


def _score_diff(diff: str, instruction: str, mesh_url: str, ollama_url: str, model: str) -> float:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".diff", encoding="utf-8", delete=False) as tf:
        tf.write(diff)
        diff_file = tf.name
    try:
        r = subprocess.run(
            [sys.executable, str(SCORE_SCRIPT),
             "--diff", diff_file, "--instruction", instruction[:200],
             "--mesh-url", mesh_url, "--ollama-url", ollama_url, "--quiet"],
            capture_output=True, text=True, timeout=40,
        )
        return float(r.stdout.strip()) if r.stdout.strip() else 0.5
    except Exception:
        return 0.5
    finally:
        Path(diff_file).unlink(missing_ok=True)


def _escalate_with_stronger_model(
    failure_log: str,
    escalate_url: str,
    escalate_key: str,
    escalate_model: str,
    mesh_url: str,
    ollama_url: str,
    local_model: str,
    cwd: Path,
    dry_run: bool,
) -> None:
    """Re-run Aider with a stronger (cloud) model when local confidence is too low."""
    import urllib.request
    prompt = (
        AIDER_SYSTEM_PREFIX
        + "The local model produced a low-confidence diff. Fix these test failures with precision:\n\n"
        + f"```\n{failure_log}\n```\n\n"
        + "Make the smallest correct change.\n"
    )
    with tempfile.NamedTemporaryFile(mode="w", suffix="-escalate.txt", encoding="utf-8",
                                     delete=False, dir=str(cwd)) as tf:
        tf.write(prompt)
        pf = Path(tf.name)
    try:
        aider_exe = os.environ.get("AIDER_PATH", "aider")
        cmd = [
            aider_exe, "--yes-always", "--no-auto-commits",
            "--map-tokens", "0", "--no-show-model-warnings", "--no-check-update",
            "--openai-api-base", f"{escalate_url}/v1",
            "--openai-api-key", escalate_key,
            "--model", f"openai/{escalate_model}",
            "--message-file", str(pf),
        ]
        if not dry_run:
            subprocess.run(cmd, cwd=str(cwd), text=True, encoding="utf-8", errors="replace")
        else:
            print(f"    [dry-run] escalate: {escalate_model}")
    finally:
        pf.unlink(missing_ok=True)


def collect_fix_as_training_data(commit_hash: str, cwd: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(COLLECT_SCRIPT), "git"],
        cwd=str(cwd), capture_output=True, text=True,
    )
    if result.returncode == 0:
        print(f"  [collect] added fix commit {commit_hash} to training data")
    else:
        print(f"  [collect] warning: {result.stderr.strip()[:200]}")


# ─── Main loop ────────────────────────────────────────────────────────────────

def fix_loop(
    test_cmd: str,
    mesh_url: str,
    ollama_url: str,
    model: str,
    max_attempts: int,
    commit_msg_prefix: str,
    cwd: Path,
    dry_run: bool,
    score_threshold: float = 0.0,
    escalate_url: str = "",
    escalate_key: str = "",
    escalate_model: str = "anthropic/claude-sonnet-4",
) -> bool:
    print(f"Fix pipeline starting")
    print(f"  Test cmd  : {test_cmd}")
    print(f"  Model     : {model}")
    print(f"  Backend   : {mesh_url or ollama_url or 'PATH default'}")
    print(f"  Max tries : {max_attempts}")
    print(f"  Dry run   : {dry_run}")
    print()

    for attempt in range(1, max_attempts + 1):
        print(f"{'='*50}")
        print(f"Attempt {attempt}/{max_attempts}  —  {datetime.now().strftime('%H:%M:%S')}")

        # Run tests
        passed, output = run_tests(test_cmd, cwd)
        if passed:
            print("✅ Tests passing!")
            return True

        print(f"❌ Tests failed ({len(output.splitlines())} lines of output)")

        # Build prompt
        trimmed = trim_log(output)
        prompt_text = (
            AIDER_SYSTEM_PREFIX
            + f"Fix the following test failures (attempt {attempt}/{max_attempts}):\n\n"
            + f"```\n{trimmed}\n```\n\n"
            + "Make minimal targeted changes. Do not modify test files.\n"
        )

        # Write to temp file
        with tempfile.NamedTemporaryFile(
            mode="w", suffix="-fix-prompt.txt", encoding="utf-8",
            delete=False, dir=str(cwd),
        ) as tf:
            tf.write(prompt_text)
            prompt_file = Path(tf.name)

        try:
            print(f"  Running Aider (prompt: {len(prompt_text)} chars)...")
            t0 = time.time()
            aider_ok = run_aider(prompt_file, mesh_url, ollama_url, model, cwd, dry_run)
            elapsed = time.time() - t0
            print(f"  Aider finished in {elapsed:.1f}s (exit: {'ok' if aider_ok else 'error'})")
        finally:
            prompt_file.unlink(missing_ok=True)

        # Confidence cascade: score the diff; if low, escalate to a stronger model
        if not dry_run and git_has_changes(cwd) and score_threshold > 0 and SCORE_SCRIPT.exists():
            diff = _get_git_diff(cwd)
            if diff:
                conf = _score_diff(diff, trimmed[:200], mesh_url, ollama_url, model)
                print(f"  Diff confidence: {conf:.3f} (threshold {score_threshold})")
                if conf < score_threshold and escalate_url and escalate_key:
                    print(f"  ↑ Escalating to {escalate_model}...")
                    subprocess.run(["git", "checkout", "."], cwd=str(cwd),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    _escalate_with_stronger_model(
                        trimmed, escalate_url, escalate_key, escalate_model,
                        mesh_url, ollama_url, model, cwd, dry_run,
                    )

        # Commit changes (if any) for training data collection
        if not dry_run and git_has_changes(cwd):
            ts = datetime.now().strftime("%Y%m%d-%H%M")
            msg = f"{commit_msg_prefix}: fix attempt {attempt} [{ts}] [auto]"
            commit_hash = git_commit_fix(msg, cwd)
            if commit_hash:
                collect_fix_as_training_data(commit_hash, cwd)

    print(f"⚠️  Max attempts ({max_attempts}) reached without passing tests")
    return False


def main():
    parser = argparse.ArgumentParser(description="Autonomous test-failure fixer via Aider + MeshLLM")
    parser.add_argument("--test",         default="npx vitest run",              help="Test command (default: npx vitest run)")
    parser.add_argument("--mesh-url",     default="http://localhost:9337",        help="MeshLLM base URL (empty = skip)")
    parser.add_argument("--ollama-url",   default="http://localhost:11434",       help="Ollama base URL (fallback)")
    parser.add_argument("--model",        default="meitheal-tuned",              help="Model name")
    parser.add_argument("--max-attempts", type=int, default=5,                   help="Max fix iterations (default: 5)")
    parser.add_argument("--commit-msg",   default="fix(auto)",                   help="Git commit message prefix")
    parser.add_argument("--repo",         default=".",                            help="Repo directory (default: cwd)")
    parser.add_argument("--dry-run",        action="store_true",                                help="Show what would run without executing")
    parser.add_argument("--score-threshold", type=float, default=0.0,                          help="Cascade: escalate if diff confidence < this (0=disabled)")
    parser.add_argument("--escalate-url",   default="https://openrouter.ai/api/v1",            help="URL to escalate to when confidence is low")
    parser.add_argument("--escalate-key",   default="",                                        help="API key for escalation (or OPENROUTER_API_KEY env)")
    parser.add_argument("--escalate-model", default="anthropic/claude-sonnet-4",               help="Model to use on escalation")
    args = parser.parse_args()

    escalate_key = args.escalate_key or os.environ.get("OPENROUTER_API_KEY", "")
    cwd = Path(args.repo).resolve()
    success = fix_loop(
        test_cmd=args.test,
        mesh_url=args.mesh_url,
        ollama_url=args.ollama_url,
        model=args.model,
        max_attempts=args.max_attempts,
        commit_msg_prefix=args.commit_msg,
        cwd=cwd,
        dry_run=args.dry_run,
        score_threshold=args.score_threshold,
        escalate_url=args.escalate_url,
        escalate_key=escalate_key,
        escalate_model=args.escalate_model,
    )
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
