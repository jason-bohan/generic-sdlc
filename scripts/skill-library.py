#!/usr/bin/env python3
"""
skill-library.py  —  Named, trackable, reusable fix skills.

A skill is higher-level than a pattern (pattern-library.py):
  - Pattern: structural similarity (normalized diff → TF-IDF)
  - Skill:   semantic + named + success-tracked ("add null guard", "fix async await")

Skills are extracted automatically from successful diffs using keyword rules
and a small taxonomy, then stored with usage counts and success rates.

At runtime, the most relevant skills are injected into Aider prompts as
"known good techniques" — this is the memory the system develops over time.

Commands:
  extract   Extract skills from a diff file or git commit
  inject    Build a skill context block for an Aider prompt
  record    Update success/failure outcome for a used skill
  list      Show all skills sorted by success rate
  import    Bulk-extract from aider_dataset.jsonl

Library: .skill-library.json
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from datetime import datetime, timezone

LIBRARY_FILE = Path(".skill-library.json")

# ─── Skill taxonomy ───────────────────────────────────────────────────────────
# Each entry: (skill_name, description, list_of_trigger_patterns_in_diff)
SKILL_TAXONOMY: list[tuple[str, str, list[str]]] = [
    ("add_null_guard",
     "Add a null/undefined guard before property access",
     ["?.", "?? ", "=== null", "=== undefined", "!== null", "!== undefined",
      "if (!", "if (!VAR", "null check", "guard"]),

    ("fix_async_await",
     "Add missing await or fix async/Promise handling",
     ["await ", "async ", ".then(", "Promise", "async function", "resolves", "rejects"]),

    ("fix_type_annotation",
     "Fix TypeScript type mismatch or add missing type",
     ["as ", ": string", ": number", ": boolean", ": void", "| null", "| undefined",
      "satisfies ", "type ", "interface "]),

    ("increase_timeout",
     "Increase a timeout or retry delay value",
     ["timeout", "TimeoutMs", "TIMEOUT", "delay", "waitFor", "interval"]),

    ("fix_import",
     "Fix a broken import path or missing export",
     ["import ", "from '", "from \"", "export ", "require("]),

    ("add_error_handling",
     "Add try/catch or error handler to async code",
     ["try {", "catch (", "catch(", ".catch(", "throw new", "Error("]),

    ("fix_test_assertion",
     "Fix a test assertion (expect, toBe, toEqual)",
     ["expect(", "toBe(", "toEqual(", "toContain(", "resolves", "rejects",
      "mockReturnValue", "mockResolvedValue", "vi.fn"]),

    ("extract_function",
     "Extract repeated logic into a named function",
     ["function ", "const VAR = (", "=> {", "return VAR"]),

    ("fix_api_endpoint",
     "Fix HTTP status code, route, or response shape",
     ["res.status(", "res.json(", "router.", ".get(", ".post(", ".put(", "fetch("]),

    ("fix_env_config",
     "Fix environment variable reference or default value",
     ["process.env.", "?.env.", "env.", "|| '", "?? '"]),

    ("remove_debug_code",
     "Remove console.log, debugging artifacts, or unused code",
     ["-console.", "-debugger", "-// TODO", "- console"]),

    ("fix_race_condition",
     "Fix a race condition or timing issue",
     ["useEffect", "cleanup", "clearTimeout", "clearInterval", "AbortController",
      "signal", "unmount"]),
]


# ─── Library I/O ──────────────────────────────────────────────────────────────

def _load() -> dict:
    if LIBRARY_FILE.exists():
        try:
            return json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save(library: dict) -> None:
    LIBRARY_FILE.write_text(json.dumps(library, indent=2, ensure_ascii=False), encoding="utf-8")


# ─── Extraction ───────────────────────────────────────────────────────────────

def _changed_tokens(diff: str) -> list[str]:
    tokens = []
    for line in diff.splitlines():
        if (line.startswith("+") or line.startswith("-")) and \
           not line.startswith(("+++", "---")):
            tokens.extend(re.findall(r"\S+", line[1:]))
    return tokens


def extract_skills(diff: str, instruction: str = "") -> list[str]:
    """Return list of skill names triggered by this diff."""
    combined = diff + " " + instruction
    found = []
    for skill_name, description, triggers in SKILL_TAXONOMY:
        hit = sum(1 for t in triggers if t.lower() in combined.lower())
        if hit >= 2:  # require at least 2 trigger tokens to avoid false positives
            found.append(skill_name)
    return found


def _ensure_skill(library: dict, skill_name: str) -> None:
    if skill_name not in library:
        desc = next((d for n, d, _ in SKILL_TAXONOMY if n == skill_name), skill_name)
        library[skill_name] = {
            "name":         skill_name,
            "description":  desc,
            "usage_count":  0,
            "success_count": 0,
            "examples":     [],
            "first_seen":   datetime.now(timezone.utc).isoformat(),
            "last_used":    None,
        }


def add_example(
    library: dict,
    skill_name: str,
    instruction: str,
    diff: str,
    source: str = "git",
) -> None:
    _ensure_skill(library, skill_name)
    s = library[skill_name]
    s["usage_count"] += 1
    s["last_used"] = datetime.now(timezone.utc).isoformat()
    if len(s["examples"]) < 10:  # cap stored examples
        s["examples"].append({
            "instruction": instruction[:200],
            "diff":        diff[:1000],
            "source":      source,
        })


# ─── Retrieval ────────────────────────────────────────────────────────────────

def find_relevant_skills(query: str, library: dict, top_k: int = 3) -> list[dict]:
    """Find skills relevant to a query string, ranked by relevance + success rate."""
    if not library:
        return []

    scored = []
    for skill_name, entry in library.items():
        triggers = next((t for n, _, t in SKILL_TAXONOMY if n == skill_name), [])
        hit = sum(1 for t in triggers if t.lower() in query.lower())
        if hit == 0:
            continue
        sr = entry["success_count"] / max(entry["usage_count"], 1)
        score = hit * (0.5 + 0.5 * sr)
        scored.append((score, entry))

    scored.sort(key=lambda x: -x[0])
    return [e for _, e in scored[:top_k]]


def build_inject_block(query: str, library: dict, top_k: int = 3) -> str:
    skills = find_relevant_skills(query, library, top_k)
    if not skills:
        return ""

    lines = ["### Relevant skills from previous successful fixes:\n"]
    for s in skills:
        sr = s["success_count"] / max(s["usage_count"], 1)
        lines.append(f"**{s['name']}** (success rate: {sr:.0%}): {s['description']}")
        if s["examples"]:
            ex = s["examples"][0]
            lines.append(f"Example: {ex['instruction']}")
            # Show first few changed lines of example diff
            diff_preview = [
                l for l in ex["diff"].splitlines()
                if (l.startswith("+") or l.startswith("-")) and not l.startswith(("+++", "---"))
            ][:6]
            if diff_preview:
                lines.append("```diff")
                lines.extend(diff_preview)
                lines.append("```")
        lines.append("")

    return "\n".join(lines)


# ─── Outcome recording ────────────────────────────────────────────────────────

def record_outcome(library: dict, skill_names: list[str], success: bool) -> None:
    for name in skill_names:
        if name in library:
            library[name]["usage_count"]  += 1
            if success:
                library[name]["success_count"] += 1
            library[name]["last_used"] = datetime.now(timezone.utc).isoformat()


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Skill library for reusable fix patterns")
    sub = parser.add_subparsers(dest="cmd", required=True)

    ext = sub.add_parser("extract", help="Extract and store skills from a diff")
    ext.add_argument("--diff",        default="-",       help="Diff file or git commit hash (- for stdin)")
    ext.add_argument("--instruction", default="",        help="What the change does")
    ext.add_argument("--source",      default="manual",  help="Source tag")
    ext.add_argument("--success",     type=lambda x: x.lower() == "true", default=True)

    inj = sub.add_parser("inject", help="Build a skill context block for an Aider prompt")
    inj.add_argument("query",          help="Task description to find relevant skills for")
    inj.add_argument("--top-k", type=int, default=3)

    rec = sub.add_parser("record", help="Record outcome for a skill (after fix attempt)")
    rec.add_argument("--skills",  required=True, help="Comma-separated skill names")
    rec.add_argument("--success", type=lambda x: x.lower() == "true", required=True)

    lst = sub.add_parser("list", help="List all skills sorted by success rate")

    imp = sub.add_parser("import", help="Bulk-import from aider_dataset.jsonl")
    imp.add_argument("dataset",   help="Path to aider_dataset.jsonl")
    imp.add_argument("--limit", type=int, default=10000)

    args = parser.parse_args()
    library = _load()

    if args.cmd == "extract":
        if args.diff == "-" or not args.diff:
            diff_text = sys.stdin.read()
        else:
            path = Path(args.diff)
            if path.exists():
                diff_text = path.read_text(encoding="utf-8", errors="replace")
            else:
                r = subprocess.run(["git", "show", args.diff, "-p", "--diff-filter=M"],
                                   capture_output=True, text=True, encoding="utf-8")
                diff_text = r.stdout

        skills = extract_skills(diff_text, args.instruction)
        if not skills:
            print("No skills detected in this diff")
        for name in skills:
            add_example(library, name, args.instruction, diff_text, args.source)
            if args.success:
                library[name]["success_count"] = library[name].get("success_count", 0) + 1
            print(f"Extracted: {name}")
        _save(library)

    elif args.cmd == "inject":
        block = build_inject_block(args.query, library, args.top_k)
        print(block if block else "(no relevant skills found)")

    elif args.cmd == "record":
        names = [n.strip() for n in args.skills.split(",") if n.strip()]
        record_outcome(library, names, args.success)
        _save(library)
        print(f"Recorded {len(names)} skill(s): success={args.success}")

    elif args.cmd == "list":
        if not library:
            print("Library empty — run: python scripts/skill-library.py import aider_dataset.jsonl")
            return
        entries = sorted(library.values(),
                         key=lambda e: e["success_count"] / max(e["usage_count"], 1),
                         reverse=True)
        print(f"{'Skill':<22} {'Uses':>5} {'Successes':>9} {'SR':>5}  Description")
        print("-" * 75)
        for e in entries:
            sr = e["success_count"] / max(e["usage_count"], 1)
            print(f"{e['name']:<22} {e['usage_count']:>5} {e['success_count']:>9} {sr:>5.0%}  {e['description'][:40]}")

    elif args.cmd == "import":
        path = Path(args.dataset)
        if not path.exists():
            print(f"Not found: {path}")
            return
        count = 0
        with open(path, encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i >= args.limit:
                    break
                line = line.strip()
                if not line:
                    continue
                ex = json.loads(line)
                diff = ex.get("response", "")
                instr = ex.get("instruction", "")
                if not diff:
                    continue
                skills = extract_skills(diff, instr)
                for name in skills:
                    add_example(library, name, instr, diff, "aider_dataset")
                    library[name]["success_count"] = library[name].get("success_count", 0) + 1
                if skills:
                    count += 1
        _save(library)
        print(f"Extracted skills from {count} examples -> {LIBRARY_FILE}")


if __name__ == "__main__":
    main()
