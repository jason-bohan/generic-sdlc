#!/usr/bin/env python3
"""
cross-domain.py  —  Multi-domain task planning: infra + backend + frontend together.

Complex bugs may require coordinated changes across system layers. This planner
decomposes a task into domain-specific steps, runs each with shared context
(each agent sees the previous agent's output), and computes a cross-domain reward.

Task schema:
  {
    "description": "API timeout causing blank screen",
    "layers":      ["backend", "infra", "frontend"],
    "impact":      "user-visible",
    "steps": [
      {"domain": "infra",    "agent": "infra-agent-1",    "step": "check service timeout config"},
      {"domain": "backend",  "agent": "backend-agent-1",  "step": "add retry with backoff"},
      {"domain": "frontend", "agent": "frontend-agent-1", "step": "show loading state during waits"},
    ]
  }

Usage:
  python scripts/cross-domain.py plan --task "API timeout causes blank screen" \\
      --layers backend,infra,frontend
  python scripts/cross-domain.py run --task-file task.json --model meitheal-tuned
  python scripts/cross-domain.py score --results results.json
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent

DOMAIN_AGENT_MAP = {
    "backend":  "backend-agent",
    "frontend": "frontend-agent",
    "infra":    "infra-agent",
    "test":     "test-agent",
    "api":      "api-agent",
    "db":       "db-agent",
}

DOMAIN_WEIGHTS = {
    "backend":  0.35,
    "frontend": 0.25,
    "infra":    0.20,
    "test":     0.15,
    "api":      0.30,
    "db":       0.25,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _call_model(messages: list[dict], url: str, model: str, max_tokens: int = 1024) -> str:
    payload = json.dumps({
        "model": model, "messages": messages,
        "temperature": 0.2, "max_tokens": max_tokens,
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


# ─── Task decomposition ───────────────────────────────────────────────────────

_DECOMPOSE_PROMPT = """\
You are a senior architect decomposing a multi-layer engineering task.

Task: {task}
Affected layers: {layers}

Produce a JSON object with this exact structure:
{{
  "description": "{task}",
  "layers": {layers_list},
  "impact": "user-visible" | "internal" | "performance",
  "steps": [
    {{"domain": "backend", "agent": "backend-agent", "step": "one specific action"}},
    ...
  ]
}}

Rules:
- One step per domain
- Each step must be concrete and actionable (not "fix the bug")
- Steps should build on each other (later steps can reference earlier ones)
- Domains: backend, frontend, infra, api, db, test

Output only the JSON, no other text.
"""


def decompose_task(task: str, layers: list[str], url: str, model: str) -> dict | None:
    prompt = _DECOMPOSE_PROMPT.format(
        task=task,
        layers=", ".join(layers),
        layers_list=json.dumps(layers),
    )
    raw = _call_model([{"role": "user", "content": prompt}], url, model, max_tokens=800)
    m   = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return None
    try:
        plan = json.loads(m.group(0))
        # Ensure agents are mapped
        for step in plan.get("steps", []):
            if not step.get("agent"):
                step["agent"] = DOMAIN_AGENT_MAP.get(step.get("domain", ""), "default-agent")
        return plan
    except Exception:
        return None


# ─── Step execution ───────────────────────────────────────────────────────────

_STEP_SYSTEM = "Output ONLY a unified diff. No explanation, no markdown fences."

_STEP_USER = """\
You are a {domain} specialist. Apply exactly the step below as a minimal diff.

Overall task: {task}

Your specific step: {step}

Context from previous steps:
{context}

Output only the unified diff for your specific step.
"""


def execute_step(
    task_description: str,
    step: dict,
    context: str,
    url: str,
    model: str,
) -> dict:
    domain = step.get("domain", "unknown")
    action = step.get("step", "")
    agent  = step.get("agent", "default-agent")

    prompt = _STEP_USER.format(
        domain=domain, task=task_description, step=action,
        context=context[-2000:] if context else "(first step — no prior context)",
    )
    diff = _call_model(
        [{"role": "system", "content": _STEP_SYSTEM},
         {"role": "user",   "content": prompt}],
        url, model,
    )

    lines   = diff.splitlines()
    added   = sum(1 for l in lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))
    valid   = (any(l.startswith("---") for l in lines) and
               any(l.startswith("@@") for l in lines))

    return {
        "domain":  domain,
        "agent":   agent,
        "step":    action,
        "diff":    diff,
        "valid":   valid,
        "lines":   added + removed,
        "ts":      _now(),
    }


def run_plan(plan: dict, url: str, model: str) -> list[dict]:
    """Execute all steps sequentially with shared context."""
    steps   = plan.get("steps", [])
    results = []
    context = ""

    for i, step in enumerate(steps):
        print(f"  [{i+1}/{len(steps)}] {step['domain']} / {step['agent']}: {step['step'][:60]}")
        result  = execute_step(plan["description"], step, context, url, model)
        results.append(result)
        context += f"\n\n[{step['domain']}] diff:\n{result['diff'][:800]}"
        status = "ok" if result["valid"] else "invalid"
        print(f"    -> {status}  {result['lines']} changed lines")

    return results


# ─── Cross-domain reward ──────────────────────────────────────────────────────

def cross_domain_reward(results: list[dict]) -> dict:
    """
    Weighted average reward across domains.
    Each domain step gets a quality score based on diff validity + size discipline.
    """
    total_weight = 0.0
    weighted_sum = 0.0
    domain_scores = {}

    for r in results:
        domain = r["domain"]
        w      = DOMAIN_WEIGHTS.get(domain, 0.25)

        lines = r["lines"]
        valid = r["valid"]

        # Simple quality heuristic per step
        if not valid:
            q = 0.0
        elif 1 <= lines <= 30:
            q = 1.0
        elif lines <= 80:
            q = 0.6
        else:
            q = 0.3

        domain_scores[domain] = round(q, 3)
        weighted_sum  += w * q
        total_weight  += w

    composite = weighted_sum / max(total_weight, 1.0)
    return {
        "composite":     round(composite, 3),
        "domain_scores": domain_scores,
        "total_steps":   len(results),
        "valid_steps":   sum(1 for r in results if r["valid"]),
    }


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Cross-domain multi-layer task planning")
    sub = parser.add_subparsers(dest="cmd", required=True)

    plan_p = sub.add_parser("plan", help="Decompose a task into domain steps")
    plan_p.add_argument("--task",     required=True)
    plan_p.add_argument("--layers",   default="backend,frontend", help="Comma-sep layer names")
    plan_p.add_argument("--output",   default="",                 help="Write plan JSON to file")
    plan_p.add_argument("--mesh-url", default="http://localhost:9337")
    plan_p.add_argument("--model",    default="qwen3:14b",        help="Use a strong model for planning")

    run_p = sub.add_parser("run", help="Execute a task plan")
    run_p.add_argument("--task-file", required=True,               help="JSON plan file from 'plan'")
    run_p.add_argument("--output",    default="",                  help="Write results JSON to file")
    run_p.add_argument("--mesh-url",  default="http://localhost:9337")
    run_p.add_argument("--model",     default="meitheal-tuned")

    sc_p = sub.add_parser("score", help="Compute cross-domain reward for results")
    sc_p.add_argument("--results",   required=True, help="Results JSON file from 'run'")

    args = parser.parse_args()

    if args.cmd == "plan":
        layers = [l.strip() for l in args.layers.split(",") if l.strip()]
        print(f"[cross-domain] Decomposing: {args.task[:70]}")
        print(f"               Layers: {layers}")
        plan = decompose_task(args.task, layers, args.mesh_url, args.model)
        if not plan:
            print("Planning failed — model output was not valid JSON")
            sys.exit(1)
        out = json.dumps(plan, indent=2)
        if args.output:
            Path(args.output).write_text(out, encoding="utf-8")
            print(f"Plan written to {args.output}")
        else:
            print(out)

    elif args.cmd == "run":
        plan_path = Path(args.task_file)
        if not plan_path.exists():
            print(f"Plan file not found: {args.task_file}")
            sys.exit(1)
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        print(f"[cross-domain] Running plan: {plan.get('description', '?')[:70]}")
        print(f"               {len(plan.get('steps', []))} steps across {plan.get('layers', [])}")
        results = run_plan(plan, args.mesh_url, args.model)
        reward  = cross_domain_reward(results)
        print(f"\nCross-domain reward: {reward['composite']:.3f}  "
              f"({reward['valid_steps']}/{reward['total_steps']} valid steps)")
        out = json.dumps({"plan": plan, "results": results, "reward": reward}, indent=2)
        if args.output:
            Path(args.output).write_text(out, encoding="utf-8")
            print(f"Results written to {args.output}")

    elif args.cmd == "score":
        data    = json.loads(Path(args.results).read_text(encoding="utf-8"))
        results = data.get("results", data) if isinstance(data, dict) else data
        reward  = cross_domain_reward(results)
        print(f"Composite      : {reward['composite']:.3f}")
        print(f"Valid steps    : {reward['valid_steps']}/{reward['total_steps']}")
        print(f"Domain scores  :")
        for domain, score in reward["domain_scores"].items():
            print(f"  {domain:<16} {score:.3f}")


if __name__ == "__main__":
    main()
