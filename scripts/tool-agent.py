#!/usr/bin/env python3
"""
tool-agent.py  —  ReAct-style tool-using agent for diagnosis before fixing.

The agent runs a reasoning loop (Reason + Act) BEFORE generating a diff.
It can call tools to gather real context: run tests, grep files, read logs,
call HTTP endpoints, run shell commands. Once it has enough information it
generates a targeted Aider prompt with the gathered context attached.

Tool call format (the model outputs):
  TOOL: tool_name(arg1, arg2)

Available tools:
  run_tests(cmd)          Run test suite, return output
  read_file(path)         Read a file (truncated)
  grep(pattern, path)     Search files for pattern
  git_log(n)              Last N commit messages
  git_diff(ref)           Diff since ref (default: HEAD)
  shell(cmd)              Run a shell command (capped output)
  http_get(url)           HTTP GET (for local APIs)
  list_files(dir)         List files in directory

Usage:
  python scripts/tool-agent.py --task "Fix failing Vitest tests" --max-turns 5
  python scripts/tool-agent.py --task "Debug the meshllm health endpoint" --test ""
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from datetime import datetime

SCRIPTS_DIR = Path(__file__).parent

# ─── Tool definitions ─────────────────────────────────────────────────────────

MAX_OUTPUT_CHARS = 3000  # cap per tool result to avoid context explosion


def _cap(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n... [{len(text) - limit} chars trimmed] ...\n" + text[-half:]


def tool_run_tests(cmd: str = "npx vitest run", cwd: str = ".") -> str:
    result = subprocess.run(
        cmd, shell=True, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", timeout=300,
    )
    status = "PASSED" if result.returncode == 0 else "FAILED"
    return f"[run_tests: {status}]\n{_cap(result.stdout)}"


def tool_read_file(path: str, cwd: str = ".") -> str:
    full = Path(cwd) / path
    if not full.exists():
        return f"[read_file: NOT FOUND] {path}"
    try:
        content = full.read_text(encoding="utf-8", errors="replace")
        return f"[read_file: {path}]\n{_cap(content)}"
    except Exception as e:
        return f"[read_file: ERROR] {e}"


def tool_grep(pattern: str, path: str = "src", cwd: str = ".") -> str:
    result = subprocess.run(
        ["git", "grep", "-n", "--", pattern, path],
        cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", timeout=15,
    )
    output = result.stdout or result.stderr or "(no matches)"
    return f"[grep: {pattern!r} in {path}]\n{_cap(output)}"


def tool_git_log(n: str = "10", cwd: str = ".") -> str:
    result = subprocess.run(
        ["git", "log", f"-{n}", "--oneline"],
        cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
    )
    return f"[git_log: last {n}]\n{result.stdout}"


def tool_git_diff(ref: str = "HEAD", cwd: str = ".") -> str:
    result = subprocess.run(
        ["git", "diff", ref],
        cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
    )
    return f"[git_diff: {ref}]\n{_cap(result.stdout or '(no diff)')}"


def tool_shell(cmd: str, cwd: str = ".") -> str:
    # Restrict to safe commands
    SAFE_PREFIXES = ("npx", "node", "python", "npm run", "git log", "git status",
                     "cat ", "ls ", "dir ", "type ")
    if not any(cmd.strip().startswith(p) for p in SAFE_PREFIXES):
        return f"[shell: BLOCKED] '{cmd}' — only read-only commands allowed"
    result = subprocess.run(
        cmd, shell=True, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", timeout=60,
    )
    return f"[shell: {cmd}]\n{_cap(result.stdout)}"


def tool_http_get(url: str, cwd: str = ".") -> str:
    if not (url.startswith("http://localhost") or url.startswith("http://127.")):
        return f"[http_get: BLOCKED] only localhost URLs allowed"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return f"[http_get: {url} {resp.status}]\n{_cap(body)}"
    except Exception as e:
        return f"[http_get: ERROR] {e}"


def tool_list_files(directory: str = "src", cwd: str = ".") -> str:
    result = subprocess.run(
        ["git", "ls-files", directory],
        cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
    )
    lines = result.stdout.strip().splitlines()[:80]
    return f"[list_files: {directory}]\n" + "\n".join(lines)


TOOLS = {
    "run_tests":  tool_run_tests,
    "read_file":  tool_read_file,
    "grep":       tool_grep,
    "git_log":    tool_git_log,
    "git_diff":   tool_git_diff,
    "shell":      tool_shell,
    "http_get":   tool_http_get,
    "list_files": tool_list_files,
}

TOOL_DOCS = "\n".join([
    "  run_tests(cmd='npx vitest run')  — Run test suite",
    "  read_file(path)                  — Read a source file",
    "  grep(pattern, path='src')        — Search for pattern in files",
    "  git_log(n='10')                  — Recent commit messages",
    "  git_diff(ref='HEAD')             — Changes since ref",
    "  shell(cmd)                       — Run safe read-only command",
    "  http_get(url)                    — GET a localhost endpoint",
    "  list_files(dir='src')            — List tracked files in directory",
])

# ─── Tool call parsing ────────────────────────────────────────────────────────

_TOOL_RE = re.compile(
    r"TOOL:\s*(\w+)\(([^)]*)\)",
    re.IGNORECASE,
)


def parse_tool_call(text: str) -> tuple[str, list[str]] | None:
    m = _TOOL_RE.search(text)
    if not m:
        return None
    name = m.group(1).strip()
    raw_args = m.group(2).strip()
    # Split on comma, strip quotes
    args = []
    for arg in re.split(r",\s*", raw_args):
        arg = arg.strip().strip("'\"`")
        if arg:
            args.append(arg)
    return name, args


def execute_tool(name: str, args: list[str], cwd: str) -> str:
    fn = TOOLS.get(name)
    if not fn:
        return f"[UNKNOWN TOOL: {name}]"
    try:
        return fn(*args, cwd=cwd) if args else fn(cwd=cwd)
    except TypeError:
        # Some tools take fewer args than provided — call with cwd only
        try:
            return fn(cwd=cwd)
        except Exception as e:
            return f"[{name}: ERROR] {e}"
    except Exception as e:
        return f"[{name}: ERROR] {e}"


# ─── LLM caller ───────────────────────────────────────────────────────────────

def call_model(messages: list[dict], mesh_url: str, ollama_url: str, model: str) -> str:
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": 1024,
    }).encode()

    if mesh_url:
        url = f"{mesh_url}/v1/chat/completions"
        key = "mesh"
    else:
        url = f"{ollama_url}/api/chat"
        key = "ollama"

    headers = {"Content-Type": "application/json"}
    if key != "ollama":
        headers["Authorization"] = f"Bearer {key}"

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            if "choices" in data:
                return data["choices"][0]["message"]["content"]
            return data.get("message", {}).get("content", "")
    except Exception as e:
        return f"[LLM ERROR: {e}]"


# ─── ReAct loop ──────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are a software diagnostic agent. Before writing any code, use tools to gather information.

Available tools (call exactly as shown):
{tool_docs}

When you have enough information, output:
  READY: <concise summary of what you found and what needs to be changed>

Rules:
- Use tools sparingly — maximum {max_tools} tool calls
- Call one tool per response
- Do NOT write diffs or code changes — gather information only
- When you're ready, output READY: followed by your findings"""


def react_loop(
    task: str,
    test_cmd: str,
    mesh_url: str,
    ollama_url: str,
    model: str,
    max_turns: int,
    cwd: str,
) -> tuple[str, list[dict]]:
    """
    Run the ReAct loop. Returns (summary_of_findings, tool_results).
    The summary is ready to be injected into an Aider prompt.
    """
    system = SYSTEM_PROMPT.format(tool_docs=TOOL_DOCS, max_tools=max_turns)

    messages: list[dict] = [
        {"role": "system", "content": system},
        {"role": "user",   "content": f"Task: {task}\n\nStart by gathering relevant information."},
    ]

    tool_results: list[dict] = []
    tools_used = 0

    for turn in range(max_turns + 2):  # +2 for initial + final response
        response = call_model(messages, mesh_url, ollama_url, model)
        messages.append({"role": "assistant", "content": response})

        print(f"  [turn {turn + 1}] {response[:120].strip()}")

        # Check for READY signal
        ready_m = re.search(r"READY:\s*(.+)", response, re.DOTALL)
        if ready_m:
            findings = ready_m.group(1).strip()
            return findings, tool_results

        # Check for tool call
        parsed = parse_tool_call(response)
        if parsed and tools_used < max_turns:
            name, args = parsed
            print(f"  → executing: {name}({', '.join(args)})")
            result = execute_tool(name, args, cwd)
            tool_results.append({"tool": name, "args": args, "result": result})
            tools_used += 1

            # Feed result back
            messages.append({"role": "user", "content": result})
        elif tools_used >= max_turns:
            # Force conclusion
            messages.append({
                "role": "user",
                "content": "You've used all your tool calls. Output READY: with your findings now."
            })
        else:
            # No tool call, no READY — prompt for conclusion
            messages.append({
                "role": "user",
                "content": "What did you find? Output READY: with your summary."
            })

    return "(diagnosis timed out)", tool_results


# ─── Aider handoff ────────────────────────────────────────────────────────────

def build_aider_prompt(task: str, findings: str, tool_results: list[dict]) -> str:
    lines = [
        "You are a coding agent. Apply the minimal necessary changes.\n",
        f"### Task:\n{task}\n",
        f"### Diagnostic findings:\n{findings}\n",
    ]
    if tool_results:
        lines.append("### Evidence gathered by diagnostic agent:")
        for tr in tool_results[:5]:  # cap context size
            lines.append(f"\n{tr['result'][:800]}")
    lines.append("\nMake minimal targeted changes. Do not rewrite unrelated code.")
    return "\n".join(lines)


def run_aider(prompt: str, mesh_url: str, ollama_url: str, model: str, cwd: str) -> bool:
    aider_exe = os.environ.get("AIDER_PATH", "aider")
    with tempfile.NamedTemporaryFile(
        mode="w", suffix="-tool-agent.txt", encoding="utf-8",
        delete=False, dir=cwd,
    ) as tf:
        tf.write(prompt)
        pf = Path(tf.name)

    cmd = [
        aider_exe, "--yes-always", "--no-auto-commits",
        "--map-tokens", "0", "--no-show-model-warnings", "--no-check-update",
        "--message-file", str(pf),
    ]
    if mesh_url:
        cmd += ["--openai-api-base", f"{mesh_url}/v1", "--openai-api-key", "mesh",
                "--model", f"openai/{model}"]
    elif ollama_url:
        cmd += ["--openai-api-base", f"{ollama_url}/v1", "--openai-api-key", "ollama",
                "--model", f"openai/{model}"]
    try:
        result = subprocess.run(cmd, cwd=cwd, text=True, encoding="utf-8", errors="replace")
        return result.returncode == 0
    finally:
        pf.unlink(missing_ok=True)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Tool-using diagnostic agent + Aider handoff")
    parser.add_argument("--task",       required=True,                           help="What to fix or investigate")
    parser.add_argument("--test",       default="npx vitest run",                help="Test command for run_tests tool")
    parser.add_argument("--max-turns",  type=int, default=4,                    help="Max tool calls (default: 4)")
    parser.add_argument("--mesh-url",   default="http://localhost:9337",         help="MeshLLM URL")
    parser.add_argument("--ollama-url", default="http://localhost:11434",        help="Ollama URL")
    parser.add_argument("--model",      default="SDLC Framework-tuned",               help="Model for diagnosis + execution")
    parser.add_argument("--repo",       default=".",                             help="Repo directory")
    parser.add_argument("--diagnose-only", action="store_true",                 help="Run diagnosis only, don't call Aider")
    args = parser.parse_args()

    cwd = str(Path(args.repo).resolve())
    # Override run_tests default with the --test arg
    _original_run_tests = TOOLS["run_tests"]
    TOOLS["run_tests"] = lambda *a, cwd=cwd: tool_run_tests(
        args.test if not a else a[0], cwd
    )

    print(f"Task    : {args.task}")
    print(f"Model   : {args.model}")
    print(f"MaxTurns: {args.max_turns}")
    print()
    print("[Diagnosis phase]")

    findings, tool_results = react_loop(
        task=args.task,
        test_cmd=args.test,
        mesh_url=args.mesh_url,
        ollama_url=args.ollama_url,
        model=args.model,
        max_turns=args.max_turns,
        cwd=cwd,
    )

    print(f"\n[Findings]\n{findings}\n")

    if args.diagnose_only:
        print("(--diagnose-only: skipping Aider)")
        return

    print("[Execution phase — handing off to Aider]")
    prompt = build_aider_prompt(args.task, findings, tool_results)
    run_aider(prompt, args.mesh_url, args.ollama_url, args.model, cwd)
    print("\nDone.")


if __name__ == "__main__":
    main()
