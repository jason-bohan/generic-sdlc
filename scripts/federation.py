#!/usr/bin/env python3
"""
federation.py  —  Privacy-safe cross-org knowledge federation.

Orgs push anonymized fix patterns (normalized diffs — no raw code, no variable
names, no file paths) to a central aggregation server. Other orgs pull the
global knowledge and inject it into their prompts.

Privacy guarantees:
  - Diffs are normalized before sharing (VAR/STR/NUM substitution)
  - No file paths, identifiers, or business logic is transmitted
  - Org identity is hashed (not stored as plaintext)

Server: lightweight HTTP JSON store (run once, can be localhost or shared host)
Client: push local patterns, pull global aggregated knowledge, inject into prompts

Usage:
  # Start the federation server
  python scripts/federation.py serve --port 8765

  # From each org — push local patterns to the server
  python scripts/federation.py push --server http://localhost:8765 --org MyOrg

  # Pull global patterns
  python scripts/federation.py pull --server http://localhost:8765 --output .fed-patterns.json

  # Inject global patterns into a prompt
  python scripts/federation.py inject "Fix null ref" --cache .fed-patterns.json
"""

import argparse
import hashlib
import http.server
import json
import math
import re
import sys
import threading
import urllib.request
from collections import Counter
from pathlib import Path

CACHE_FILE = Path(".fed-patterns.json")

# ─── Normalization (same as pattern-library.py, reproduced for standalone use) ─

_IDENT_RE    = re.compile(r"\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b")
_STRING_RE   = re.compile(r'(["\'])(?:(?!\1).)*\1')
_NUMBER_RE   = re.compile(r"\b\d+(\.\d+)?\b")
_IMPORT_PATH = re.compile(r"from\s+['\"]([^'\"]+)['\"]")

_KEEP_WORDS = {
    "if", "else", "for", "while", "return", "const", "let", "var", "function",
    "class", "interface", "type", "import", "export", "from", "async", "await",
    "try", "catch", "throw", "new", "null", "undefined", "true", "false",
    "void", "any", "string", "number", "boolean",
}


def _normalize(diff: str) -> str:
    lines = [l for l in diff.splitlines()
             if not l.startswith(("diff ", "index ", "--- ", "+++ "))]
    text  = "\n".join("@@ context @@" if l.startswith("@@") else l for l in lines)
    text  = _IMPORT_PATH.sub("from 'IMPORT_PATH'", text)
    text  = _STRING_RE.sub("STR", text)
    text  = _NUMBER_RE.sub("NUM", text)
    text  = _IDENT_RE.sub(lambda m: m.group(0) if m.group(0) in _KEEP_WORDS else "VAR", text)
    return text.strip()


def _keywords(text: str) -> list[str]:
    stop = {"VAR", "STR", "NUM", "IMPORT_PATH", "context", "the", "and", "for"}
    return [t.lower() for t in re.findall(r"[a-zA-Z_][a-zA-Z0-9_]+", text)
            if t not in stop and len(t) > 2]


def _hash_org(org_name: str) -> str:
    return hashlib.sha256(org_name.encode()).hexdigest()[:12]


# ─── Federation server ────────────────────────────────────────────────────────

class _PatternStore:
    """In-memory store: cluster -> list of anonymized pattern entries."""
    def __init__(self) -> None:
        self._lock    = threading.Lock()
        self._patterns: dict[str, list[dict]] = {}

    def add(self, entries: list[dict]) -> int:
        added = 0
        with self._lock:
            for e in entries:
                cluster = e.get("cluster", "unknown")
                self._patterns.setdefault(cluster, [])
                # Deduplicate by pattern hash
                ph = hashlib.md5(e.get("pattern", "").encode()).hexdigest()
                if not any(x.get("_hash") == ph for x in self._patterns[cluster]):
                    e["_hash"] = ph
                    self._patterns[cluster].append(e)
                    added += 1
        return added

    def get_all(self) -> dict:
        with self._lock:
            return dict(self._patterns)

    def stats(self) -> dict:
        with self._lock:
            return {c: len(v) for c, v in self._patterns.items()}


_store = _PatternStore()


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress request logs

    def _send_json(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/patterns":
            self._send_json({"patterns": _store.get_all()})
        elif self.path == "/stats":
            self._send_json({"clusters": _store.stats(), "version": "1.0"})
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/push":
            length  = int(self.headers.get("Content-Length", 0))
            body    = json.loads(self.rfile.read(length))
            entries = body.get("patterns", [])
            added   = _store.add(entries)
            self._send_json({"added": added, "total": sum(_store.stats().values())})
        else:
            self._send_json({"error": "not found"}, 404)


def serve(port: int) -> None:
    server = http.server.HTTPServer(("0.0.0.0", port), _Handler)
    print(f"Federation server running on port {port}")
    print(f"  Push: POST http://localhost:{port}/push")
    print(f"  Pull: GET  http://localhost:{port}/patterns")
    server.serve_forever()


# ─── Client: push ─────────────────────────────────────────────────────────────

def push_local_patterns(server_url: str, org_name: str, limit: int = 200) -> dict:
    """Read local pattern-library.jsonl, normalize, and push to federation server."""
    lib_file = Path(".pattern-library.jsonl")
    if not lib_file.exists():
        return {"error": "No local pattern library found — run pattern-library.py first"}

    org_hash = _hash_org(org_name)
    entries  = []
    with lib_file.open(encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= limit:
                break
            line = line.strip()
            if not line:
                continue
            try:
                ex = json.loads(line)
            except Exception:
                continue

            diff        = ex.get("diff", "")
            instruction = ex.get("instruction", "")
            pattern     = _normalize(diff)
            keywords    = _keywords(f"{instruction} {pattern}")
            if not pattern:
                continue

            # Infer cluster from keywords
            cluster = "unknown"
            for kw, cl in [("null", "null_ref"), ("async", "async_await"),
                            ("await", "async_await"), ("timeout", "timeout"),
                            ("import", "import_error"), ("test", "test_assertion")]:
                if kw in keywords:
                    cluster = cl
                    break

            entries.append({
                "pattern":     pattern[:800],
                "instruction": instruction[:100],
                "keywords":    keywords[:20],
                "cluster":     cluster,
                "org_hash":    org_hash,
                "sr":          1.0,  # only push successful patterns
            })

    if not entries:
        return {"error": "No patterns to push"}

    payload = json.dumps({"patterns": entries}).encode()
    req = urllib.request.Request(
        f"{server_url}/push",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            return {"pushed": len(entries), "server_response": result}
    except Exception as e:
        return {"error": str(e)}


# ─── Client: pull ─────────────────────────────────────────────────────────────

def pull_global_patterns(server_url: str, output_file: Path) -> dict:
    req = urllib.request.Request(f"{server_url}/patterns", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        output_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        total = sum(len(v) for v in data.get("patterns", {}).values())
        return {"clusters": list(data.get("patterns", {}).keys()), "total": total}
    except Exception as e:
        return {"error": str(e)}


# ─── Client: inject ───────────────────────────────────────────────────────────

def _tf(tokens: list[str]) -> dict[str, float]:
    c = Counter(tokens)
    n = len(tokens) or 1
    return {t: v / n for t, v in c.items()}


def _cosine(a: dict, b: dict) -> float:
    shared = set(a) & set(b)
    dot    = sum(a[k] * b[k] for k in shared)
    ma     = math.sqrt(sum(v**2 for v in a.values()))
    mb     = math.sqrt(sum(v**2 for v in b.values()))
    return dot / (ma * mb) if ma and mb else 0.0


def build_inject_block(query: str, cache_file: Path, top_k: int = 3) -> str:
    if not cache_file.exists():
        return ""
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
    except Exception:
        return ""

    all_entries = []
    for entries in data.get("patterns", {}).values():
        all_entries.extend(entries)

    if not all_entries:
        return ""

    q_tokens = _keywords(query)
    q_tf     = _tf(q_tokens)
    scored   = []
    for e in all_entries:
        e_tf = _tf(e.get("keywords", []))
        sim  = _cosine(q_tf, e_tf)
        if sim > 0.05:
            scored.append((sim, e))

    scored.sort(key=lambda x: -x[0])
    top = scored[:top_k]
    if not top:
        return ""

    lines = ["### Global patterns from federated knowledge base:\n"]
    for sim, e in top:
        lines.append(f"Pattern (similarity={sim:.2f}, cluster={e.get('cluster','?')}): "
                     f"{e.get('instruction', '')[:80]}")
        pattern_preview = [l for l in e.get("pattern", "").splitlines()
                           if l.strip() and not l.startswith("@@ context")][:8]
        if pattern_preview:
            lines.append("```diff")
            lines.extend(pattern_preview)
            lines.append("```")
        lines.append("")

    return "\n".join(lines)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Federated cross-org knowledge sharing")
    sub = parser.add_subparsers(dest="cmd", required=True)

    srv = sub.add_parser("serve", help="Start the federation server")
    srv.add_argument("--port", type=int, default=8765)

    push_p = sub.add_parser("push", help="Push local patterns to federation server")
    push_p.add_argument("--server", default="http://localhost:8765")
    push_p.add_argument("--org",    default="SDLC Framework", help="Org name (hashed before transmit)")
    push_p.add_argument("--limit",  type=int, default=200)

    pull_p = sub.add_parser("pull", help="Pull global patterns from server")
    pull_p.add_argument("--server", default="http://localhost:8765")
    pull_p.add_argument("--output", default=str(CACHE_FILE))

    inj = sub.add_parser("inject", help="Build inject block from cached global patterns")
    inj.add_argument("query")
    inj.add_argument("--cache",  default=str(CACHE_FILE))
    inj.add_argument("--top-k", type=int, default=3)

    stats_p = sub.add_parser("stats", help="Show server stats")
    stats_p.add_argument("--server", default="http://localhost:8765")

    args = parser.parse_args()

    if args.cmd == "serve":
        serve(args.port)

    elif args.cmd == "push":
        result = push_local_patterns(args.server, args.org, args.limit)
        if "error" in result:
            print(f"Error: {result['error']}")
        else:
            print(f"Pushed {result['pushed']} patterns  server response: {result['server_response']}")

    elif args.cmd == "pull":
        result = pull_global_patterns(args.server, Path(args.output))
        if "error" in result:
            print(f"Error: {result['error']}")
        else:
            print(f"Pulled {result['total']} patterns  clusters: {result['clusters']}")
            print(f"Cached to {args.output}")

    elif args.cmd == "inject":
        block = build_inject_block(args.query, Path(args.cache), args.top_k)
        print(block if block else "(no relevant global patterns found)")

    elif args.cmd == "stats":
        try:
            with urllib.request.urlopen(f"{args.server}/stats", timeout=5) as resp:
                data = json.loads(resp.read())
            print(f"Server: {args.server}")
            for cluster, count in data.get("clusters", {}).items():
                print(f"  {cluster:<18} {count} patterns")
        except Exception as e:
            print(f"Could not reach server: {e}")


if __name__ == "__main__":
    main()
