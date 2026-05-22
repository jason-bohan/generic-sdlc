#!/usr/bin/env python3
"""
future-bugs.py  —  Pre-emptive training: predict and fix bugs before they happen.

Learns the failure distribution from history, generates synthetic bug scenarios
of the most likely types, runs agents to fix them, and records results as new
training data. Builds resilience against bugs that haven't happened yet.

Modes:
  template    — structured templates per cluster (fast, deterministic)
  adversarial — LLM generates subtle hard-to-detect bugs

Bug scenario schema (stored as aider_dataset.jsonl tasks):
  {
    "instruction": "Fix this [null_ref] bug: agentStatus.name accessed before null check",
    "response":    "",    # filled by sim-batch after the agent attempts a fix
    "_meta": {
      "source":  "future-bugs",
      "mode":    "template" | "adversarial",
      "cluster": "null_ref",
      "difficulty": "easy" | "medium" | "hard",
    }
  }

Usage:
  python scripts/future-bugs.py generate --count 20 --mode template
  python scripts/future-bugs.py generate --count 5  --mode adversarial \\
      --mesh-url http://localhost:9337 --model qwen3:14b
  python scripts/future-bugs.py run --limit 10 --model SDLC Framework-tuned
  python scripts/future-bugs.py stats
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
OUTPUT_FILE = Path("aider_dataset.jsonl")
META_LOG    = Path(".meta-learning.jsonl")

# ─── Failure distribution ─────────────────────────────────────────────────────

def learn_failure_distribution() -> dict[str, float]:
    """Build cluster failure rates from meta-learning log."""
    if not META_LOG.exists():
        return {"null_ref": 0.32, "async_await": 0.20, "timeout": 0.18,
                "race_condition": 0.15, "import_error": 0.10, "type_error": 0.05}

    from collections import defaultdict
    clusters: dict[str, dict] = defaultdict(lambda: {"total": 0, "fail": 0})
    tasks_seen: dict[str, set] = defaultdict(set)

    with META_LOG.open(encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line.strip())
                c   = r.get("cluster", "unknown")
                tid = r.get("task_id") or f"__{r.get('ts','')}_{c}"
                tasks_seen[c].add(tid)
                if not r.get("success"):
                    clusters[c]["fail"] += 1
            except Exception:
                pass
    for c, d in clusters.items():
        d["total"] = len(tasks_seen[c])

    total_fails = sum(d["fail"] for d in clusters.values()) or 1
    return {c: d["fail"] / total_fails for c, d in clusters.items() if d["fail"] > 0}


# ─── Template-based bug scenarios ─────────────────────────────────────────────

_TEMPLATES: dict[str, list[tuple[str, str]]] = {
    "null_ref": [
        ("Fix null reference: {obj}.{prop} accessed before null guard in {fn}",
         "easy"),
        ("Handle undefined value: {fn} returns undefined when {obj} is not initialized",
         "medium"),
        ("Fix chained property access crash: {obj}?.{prop}?.{sub} needs optional chaining",
         "medium"),
        ("Add null check before calling {obj}.{prop}() in {fn} error handler",
         "hard"),
    ],
    "async_await": [
        ("Add missing await: {fn} calls async {service} but does not await the result",
         "easy"),
        ("Fix promise not awaited: {fn} uses .then() but should use async/await pattern",
         "medium"),
        ("Handle rejected promise: {fn} does not catch errors from {service} API call",
         "medium"),
        ("Fix async race: two concurrent {service} calls with shared state, missing coordination",
         "hard"),
    ],
    "timeout": [
        ("Increase timeout: {service} request to {endpoint} fails after 5000ms",
         "easy"),
        ("Add retry logic: {endpoint} endpoint is flaky, add 3 retries with backoff",
         "medium"),
        ("Fix timeout cascade: {service} timeout causes downstream {fn} to hang indefinitely",
         "hard"),
    ],
    "race_condition": [
        ("Fix race condition: {fn} reads and writes shared state without synchronization",
         "hard"),
        ("Add cleanup: useEffect in {component} does not cancel pending {service} request on unmount",
         "medium"),
        ("Fix state update after unmount: {component} calls setState after component is destroyed",
         "medium"),
    ],
    "import_error": [
        ("Fix broken import: {module} is imported from wrong path in {fn}",
         "easy"),
        ("Add missing export: {fn} is used in {component} but not exported from {module}",
         "easy"),
        ("Fix circular import: {module} and {fn} import each other causing initialization error",
         "hard"),
    ],
    "type_error": [
        ("Fix type mismatch: {fn} expects string but receives {obj} | undefined",
         "medium"),
        ("Add type guard: {fn} narrows type before accessing {prop} on union type",
         "medium"),
        ("Fix generic type: {service} method returns wrong type parameter in {fn}",
         "hard"),
    ],
}

_PLACEHOLDERS = {
    "obj":       ["agentStatus", "config", "meshllmProvider", "response", "user"],
    "prop":      ["name", "status", "id", "data", "message"],
    "sub":       ["value", "text", "count", "items"],
    "fn":        ["handleRequest", "fetchAgentData", "processResult", "updateStatus"],
    "service":   ["agentRunner", "meshllmProvider", "apiClient", "spawner"],
    "endpoint":  ["/api/agents", "/v1/chat/completions", "/api/status"],
    "component": ["AgentCard", "InteractiveView", "AIHealth", "SimpleFloor"],
    "module":    ["agent-drivers", "meshllmProvider", "spawn-agent", "config"],
}


def _fill(template: str) -> str:
    import random
    def replace(m: re.Match) -> str:
        key = m.group(1)
        opts = _PLACEHOLDERS.get(key, [key])
        return random.choice(opts)
    return re.sub(r"\{(\w+)\}", replace, template)


def generate_template_scenarios(
    distribution: dict[str, float],
    count: int,
) -> list[dict]:
    import random
    clusters = list(distribution.keys())
    weights  = [distribution[c] for c in clusters]
    scenarios = []
    for _ in range(count):
        cluster = random.choices(clusters, weights=weights, k=1)[0]
        if cluster not in _TEMPLATES:
            cluster = random.choice(list(_TEMPLATES.keys()))
        tmpl, difficulty = random.choice(_TEMPLATES[cluster])
        instruction = _fill(tmpl)
        scenarios.append({
            "instruction": instruction,
            "response":    "",
            "_meta": {
                "source":     "future-bugs",
                "mode":       "template",
                "cluster":    cluster,
                "difficulty": difficulty,
                "generated":  datetime.now(timezone.utc).isoformat(),
            },
        })
    return scenarios


# ─── Adversarial bug generation ───────────────────────────────────────────────

_ADVERSARIAL_PROMPT = """\
Generate {count} realistic, subtle bug scenarios for a TypeScript/React codebase.
Each bug should be of type: {cluster}

Rules:
- Make bugs subtle enough to pass basic code review
- Include enough context that an agent can identify and fix them
- Do NOT include the fix — only describe the bug
- Output ONLY a JSON array of instruction strings

Example:
["Fix subtle race condition: useEffect in AgentCard dispatches state update but
 the cleanup function does not cancel the pending fetch, causing setState on unmounted component"]

Output {count} bug descriptions as a JSON array of strings.
"""


def generate_adversarial_scenarios(
    distribution: dict[str, float],
    count: int,
    url: str,
    model: str,
) -> list[dict]:
    import random
    clusters = list(distribution.keys())
    weights  = [distribution[c] for c in clusters]
    scenarios = []

    # Group by cluster for efficiency (fewer LLM calls)
    from collections import Counter
    cluster_counts: Counter = Counter(
        random.choices(clusters, weights=weights, k=count)
    )

    for cluster, n in cluster_counts.items():
        payload = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content":
                _ADVERSARIAL_PROMPT.format(count=n, cluster=cluster)}],
            "temperature": 0.7, "max_tokens": 1024,
        }).encode()
        headers = {"Content-Type": "application/json", "Authorization": "Bearer mesh"}
        req = urllib.request.Request(
            f"{url}/v1/chat/completions", data=payload, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read())
                raw  = data["choices"][0]["message"]["content"].strip()
            m = re.search(r"\[.*\]", raw, re.DOTALL)
            instructions = json.loads(m.group(0)) if m else []
        except Exception:
            instructions = []

        for instr in instructions[:n]:
            if isinstance(instr, str) and instr.strip():
                scenarios.append({
                    "instruction": instr.strip(),
                    "response":    "",
                    "_meta": {
                        "source":     "future-bugs",
                        "mode":       "adversarial",
                        "cluster":    cluster,
                        "difficulty": "hard",
                        "generated":  datetime.now(timezone.utc).isoformat(),
                    },
                })
    return scenarios


# ─── Save and run ─────────────────────────────────────────────────────────────

def save_scenarios(scenarios: list[dict], output: Path) -> None:
    with output.open("a", encoding="utf-8") as f:
        for s in scenarios:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")


def run_sim(limit: int, model: str, mesh_url: str) -> dict:
    """Run sim-batch on recently generated future-bug scenarios."""
    sim = SCRIPTS_DIR / "sim-batch.py"
    if not sim.exists():
        return {"error": "sim-batch.py not found"}
    result = subprocess.run(
        [sys.executable, str(sim), "--limit", str(limit),
         "--model", model, "--mesh-url", mesh_url,
         "--cluster", ""],  # pick up any cluster
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"Results\s*:\s*(\d+)/(\d+)", result.stdout)
    if m:
        passed, total = int(m.group(1)), int(m.group(2))
        return {"passed": passed, "total": total,
                "pass_rate": round(passed / max(total, 1), 3)}
    return {"output": result.stdout[-400:]}


# ─── Stats ────────────────────────────────────────────────────────────────────

def stats(output: Path) -> None:
    if not output.exists():
        print("No scenarios yet")
        return
    cluster_counts: Counter = Counter()
    mode_counts: Counter    = Counter()
    total = 0
    with output.open(encoding="utf-8") as f:
        for line in f:
            try:
                ex   = json.loads(line.strip())
                meta = ex.get("_meta", {})
                if meta.get("source") == "future-bugs":
                    cluster_counts[meta.get("cluster", "?")] += 1
                    mode_counts[meta.get("mode", "?")] += 1
                    total += 1
            except Exception:
                pass
    print(f"Future-bug scenarios: {total}")
    print(f"\nBy cluster:")
    for c, n in cluster_counts.most_common():
        print(f"  {c:<18} {n}")
    print(f"\nBy mode:")
    for m, n in mode_counts.most_common():
        print(f"  {m:<18} {n}")


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Pre-emptive bug simulation and training")
    sub = parser.add_subparsers(dest="cmd", required=True)

    gen = sub.add_parser("generate", help="Generate bug scenarios")
    gen.add_argument("--count",    type=int, default=20)
    gen.add_argument("--mode",     default="template", choices=["template", "adversarial"])
    gen.add_argument("--output",   default=str(OUTPUT_FILE))
    gen.add_argument("--mesh-url", default="http://localhost:9337")
    gen.add_argument("--model",    default="qwen3:14b")

    run_p = sub.add_parser("run", help="Run sim-batch on generated scenarios")
    run_p.add_argument("--limit",    type=int, default=10)
    run_p.add_argument("--model",    default="SDLC Framework-tuned")
    run_p.add_argument("--mesh-url", default="http://localhost:9337")

    sub.add_parser("stats", help="Show generation statistics")

    args = parser.parse_args()

    if args.cmd == "generate":
        dist = learn_failure_distribution()
        print(f"[future-bugs] Failure distribution: "
              f"{', '.join(f'{c}={v:.0%}' for c, v in sorted(dist.items(), key=lambda x: -x[1])[:5])}")

        if args.mode == "template":
            scenarios = generate_template_scenarios(dist, args.count)
        else:
            scenarios = generate_adversarial_scenarios(dist, args.count, args.mesh_url, args.model)

        output = Path(args.output)
        save_scenarios(scenarios, output)
        print(f"Generated {len(scenarios)} {args.mode} scenarios -> {output}")
        cluster_c = Counter(s["_meta"]["cluster"] for s in scenarios)
        for c, n in cluster_c.most_common():
            print(f"  {c:<18} {n}")

    elif args.cmd == "run":
        print(f"[future-bugs] Running {args.limit} scenarios through sim-batch...")
        result = run_sim(args.limit, args.model, args.mesh_url)
        if "error" in result:
            print(f"Error: {result['error']}")
        else:
            print(f"Pass rate: {result.get('pass_rate', '?')}  "
                  f"({result.get('passed', '?')}/{result.get('total', '?')})")

    elif args.cmd == "stats":
        stats(OUTPUT_FILE)


if __name__ == "__main__":
    main()
