#!/usr/bin/env python3
"""
meeting-bridge.py  —  HTTP bridge between the Teams meeting agent and the fix pipeline.

Receives task payloads from teams-agent/index.js (POST /task) and routes them
into the autonomous pipeline: manager-agent queue → fix-pipeline → Aider.

Also provides a Graph API transcript webhook endpoint for direct Teams integration.

Task payload schema (from Teams agent):
  {
    "task":       "Refactor AI controls into AICommandRoom",
    "cluster":    "refactor",
    "confidence": 0.87,
    "meeting_id": "19:meeting_abc123@thread.v2",
    "speaker":    "Jason",
    "context":    "last N lines of transcript",
  }

Storage: .meeting-tasks.jsonl, .meeting-decisions.jsonl

Usage:
  python scripts/meeting-bridge.py serve --port 9338
  python scripts/meeting-bridge.py status
  python scripts/meeting-bridge.py inject --task "Fix null ref in userService" --cluster null_ref
  python scripts/meeting-bridge.py replay --meeting 19:meeting_abc
"""

import argparse
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPTS_DIR    = Path(__file__).parent
TASKS_LOG      = Path(".meeting-tasks.jsonl")
DECISIONS_LOG  = Path(".meeting-decisions.jsonl")
QUEUE_CMD      = [sys.executable, str(SCRIPTS_DIR / "manager-agent.py"), "queue"]
PIPELINE_CMD   = [sys.executable, str(SCRIPTS_DIR / "fix-pipeline.py")]

# Cluster → urgency/impact heuristics for manager-agent queue scoring
_CLUSTER_SCORES: dict[str, tuple[float, float]] = {
    "null_ref":       (0.8, 0.9),
    "async_await":    (0.7, 0.8),
    "type_error":     (0.6, 0.8),
    "test_assertion": (0.5, 0.7),
    "timeout":        (0.7, 0.7),
    "import_error":   (0.8, 0.8),
    "syntax_error":   (0.9, 0.9),
    "refactor":       (0.4, 0.6),
    "feature":        (0.3, 0.5),
    "other":          (0.5, 0.5),
}

# Minimum confidence to route to the fix pipeline (vs. just logging)
PIPELINE_CONFIDENCE_THRESHOLD = 0.70


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _append_jsonl(path: Path, record: dict) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    records = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except Exception:
                    pass
    return records


# ─── Task routing ─────────────────────────────────────────────────────────────

def route_task(payload: dict) -> dict:
    """
    Process a task payload from the Teams agent:
    1. Log to .meeting-tasks.jsonl
    2. Queue in manager-agent (always)
    3. If confidence >= threshold, also trigger fix-pipeline directly
    """
    task       = payload.get("task", "")
    cluster    = payload.get("cluster", "other")
    confidence = float(payload.get("confidence", 0.5))
    meeting_id = payload.get("meeting_id", "unknown")
    speaker    = payload.get("speaker", "unknown")

    if not task:
        return {"ok": False, "reason": "empty task"}

    # Normalize cluster to known set
    if cluster not in _CLUSTER_SCORES:
        cluster = "other"
    urgency, impact = _CLUSTER_SCORES[cluster]

    record = {
        "task":        task,
        "cluster":     cluster,
        "confidence":  confidence,
        "meeting_id":  meeting_id,
        "speaker":     speaker,
        "urgency":     urgency,
        "impact":      impact,
        "status":      "received",
        "ts":          _now(),
    }
    _append_jsonl(TASKS_LOG, record)
    print(f"[bridge] TASK ({confidence:.2f}): {task[:70]}  cluster={cluster}")

    # Always queue in manager-agent
    queue_result = _queue_task(task, cluster, urgency, impact)

    # High-confidence tasks also go directly to fix-pipeline in a background thread
    pipeline_started = False
    if confidence >= PIPELINE_CONFIDENCE_THRESHOLD:
        t = threading.Thread(
            target=_run_pipeline_async,
            args=(task, cluster),
            daemon=True,
        )
        t.start()
        pipeline_started = True
        print(f"[bridge] -> pipeline triggered for: {task[:50]}")

    return {
        "ok":              True,
        "task":            task,
        "cluster":         cluster,
        "queued":          queue_result,
        "pipeline_started": pipeline_started,
    }


def route_decision(payload: dict) -> dict:
    """Log a meeting decision — these are not executed, just recorded."""
    decision = payload.get("decision", "")
    if not decision:
        return {"ok": False, "reason": "empty decision"}
    record = {
        "decision":   decision,
        "meeting_id": payload.get("meeting_id", "unknown"),
        "speaker":    payload.get("speaker", "unknown"),
        "ts":         _now(),
    }
    _append_jsonl(DECISIONS_LOG, record)
    print(f"[bridge] DECISION: {decision[:70]}")
    return {"ok": True, "decision": decision}


def _queue_task(task: str, cluster: str, urgency: float, impact: float) -> bool:
    try:
        proc = subprocess.run(
            QUEUE_CMD + [
                "--add",     task,
                "--cluster", cluster,
                "--urgency", str(urgency),
                "--impact",  str(impact),
            ],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
        )
        return proc.returncode == 0
    except Exception as e:
        print(f"[bridge] queue failed: {e}")
        return False


def _run_pipeline_async(task: str, cluster: str) -> None:
    """Run fix-pipeline in background. Called from a daemon thread."""
    try:
        subprocess.run(
            PIPELINE_CMD + [
                "--task",        task,
                "--record-meta",
            ],
            text=True, encoding="utf-8", errors="replace", timeout=300,
        )
    except subprocess.TimeoutExpired:
        print(f"[bridge] pipeline timed out for: {task[:50]}")
    except Exception as e:
        print(f"[bridge] pipeline error: {e}")


# ─── HTTP server ──────────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence access log

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw    = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def _send(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self._read_body()

        if self.path == "/task":
            result = route_task(body)
            self._send(result)

        elif self.path == "/decision":
            result = route_decision(body)
            self._send(result)

        elif self.path == "/transcript":
            # Batch transcript from Graph API subscription
            items = body.get("transcriptItems", [])
            meeting_id = body.get("meeting_id", "unknown")
            results = []
            for item in items:
                text       = item.get("text", "").strip()
                speaker    = item.get("speakerDisplayName", "unknown")
                confidence = float(item.get("confidence", 0.6))
                if text:
                    results.append(route_task({
                        "task":       text,
                        "cluster":    "other",
                        "confidence": confidence,
                        "meeting_id": meeting_id,
                        "speaker":    speaker,
                    }))
            self._send({"ok": True, "processed": len(results)})

        else:
            self._send({"error": "not found"}, 404)

    def do_GET(self):
        if self.path == "/status":
            tasks     = _load_jsonl(TASKS_LOG)
            decisions = _load_jsonl(DECISIONS_LOG)
            self._send({
                "status":       "ok",
                "total_tasks":  len(tasks),
                "decisions":    len(decisions),
                "pipeline_threshold": PIPELINE_CONFIDENCE_THRESHOLD,
                "recent_tasks": [
                    {"task": t["task"][:60], "cluster": t["cluster"],
                     "confidence": t["confidence"], "ts": t["ts"]}
                    for t in tasks[-5:]
                ],
            })
        elif self.path == "/health":
            self._send({"status": "ok"})
        else:
            self._send({"error": "not found"}, 404)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Meeting bridge — routes Teams agent tasks into the Meitheal pipeline"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    srv = sub.add_parser("serve", help="Start the bridge HTTP server")
    srv.add_argument("--port", type=int, default=9338)

    sub.add_parser("status", help="Show logged tasks and decisions")

    inj = sub.add_parser("inject", help="Manually inject a task (for testing)")
    inj.add_argument("--task",       required=True)
    inj.add_argument("--cluster",    default="other")
    inj.add_argument("--confidence", type=float, default=0.85)
    inj.add_argument("--speaker",    default="manual")
    inj.add_argument("--meeting-id", default="test")

    rep = sub.add_parser("replay", help="Re-queue all tasks from a specific meeting")
    rep.add_argument("--meeting", required=True, help="Partial or full meeting ID")

    args = parser.parse_args()

    if args.cmd == "serve":
        server = HTTPServer(("0.0.0.0", args.port), _Handler)
        print(f"Meeting bridge on port {args.port}")
        print(f"  POST /task        — receive task from Teams agent")
        print(f"  POST /decision    — log a meeting decision")
        print(f"  POST /transcript  — batch Graph API transcript")
        print(f"  GET  /status      — show bridge state")
        print(f"  Pipeline threshold: confidence >= {PIPELINE_CONFIDENCE_THRESHOLD}")
        server.serve_forever()

    elif args.cmd == "status":
        tasks     = _load_jsonl(TASKS_LOG)
        decisions = _load_jsonl(DECISIONS_LOG)
        print(f"Total tasks logged    : {len(tasks)}")
        print(f"Total decisions logged: {len(decisions)}")
        if tasks:
            print(f"\nLast 5 tasks:")
            for t in tasks[-5:]:
                pipe = "PIPELINE" if t["confidence"] >= PIPELINE_CONFIDENCE_THRESHOLD else "queued"
                print(f"  [{pipe}] [{t['cluster']}] {t['task'][:60]}  "
                      f"conf={t['confidence']:.2f}  {t['ts'][:19]}")
        if decisions:
            print(f"\nLast 3 decisions:")
            for d in decisions[-3:]:
                print(f"  {d['decision'][:70]}  {d['ts'][:19]}")

    elif args.cmd == "inject":
        result = route_task({
            "task":       args.task,
            "cluster":    args.cluster,
            "confidence": args.confidence,
            "meeting_id": args.meeting_id,
            "speaker":    args.speaker,
        })
        print(json.dumps(result, indent=2))

    elif args.cmd == "replay":
        tasks = _load_jsonl(TASKS_LOG)
        matches = [t for t in tasks if args.meeting in t.get("meeting_id", "")]
        if not matches:
            print(f"No tasks found for meeting: {args.meeting}")
            return
        print(f"Replaying {len(matches)} tasks from meeting {args.meeting[:30]}")
        for t in matches:
            print(f"  -> {t['task'][:60]}")
            _queue_task(t["task"], t["cluster"], t["urgency"], t["impact"])
        print("Done")


if __name__ == "__main__":
    main()
