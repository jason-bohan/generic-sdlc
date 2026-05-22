#!/usr/bin/env python3
"""
preview-server.py  —  Live code diff preview for meeting agent.

Runs a dry-run of the fix pipeline and serves the resulting diff to a web UI
in real time. Team members can see what the agent would change BEFORE it's
applied, then approve or reject via the UI or API.

Preview states:
  pending   — request received, generating diff
  ready     — diff computed, waiting for human approval
  approved  — human approved, pipeline running for real
  rejected  — human rejected, task discarded
  applied   — pipeline completed, PR created

Storage: .preview-queue.json

Usage:
  python scripts/preview-server.py serve --port 9001
  python scripts/preview-server.py queue --task "Fix null ref in userService"
  python scripts/preview-server.py status
"""

import argparse
import json
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPTS_DIR   = Path(__file__).parent
QUEUE_FILE    = Path(".preview-queue.json")
PIPELINE_CMD  = [sys.executable, str(SCRIPTS_DIR / "fix-pipeline.py")]
SCORE_CMD     = [sys.executable, str(SCRIPTS_DIR / "score-diff.py")]

AUTO_APPROVE_CONFIDENCE = 0.90   # auto-approve without human if confidence >= this
PREVIEW_TIMEOUT_S       = 30     # seconds to wait for dry-run diff generation


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_queue() -> list[dict]:
    if QUEUE_FILE.exists():
        try:
            return json.loads(QUEUE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_queue(q: list[dict]) -> None:
    QUEUE_FILE.write_text(json.dumps(q, indent=2, ensure_ascii=False), encoding="utf-8")


# ─── Diff generation (dry run) ────────────────────────────────────────────────

def generate_preview_diff(task: str, cluster: str = "other") -> str:
    """
    Run fix-pipeline with --dry-run (or score-diff on an existing diff)
    and return the diff text. Falls back to a placeholder if unavailable.
    """
    fp = SCRIPTS_DIR / "fix-pipeline.py"
    if not fp.exists():
        return f"# Preview not available — fix-pipeline.py not found\n# Task: {task}\n"

    try:
        result = subprocess.run(
            PIPELINE_CMD + ["--task", task, "--dry-run", "--record-meta"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=PREVIEW_TIMEOUT_S,
        )
        # fix-pipeline --dry-run outputs the planned diff to stdout
        diff = result.stdout.strip()
        if not diff:
            diff = f"# Dry-run produced no output\n# stderr: {result.stderr[:200]}\n"
        return diff
    except subprocess.TimeoutExpired:
        return f"# Preview timed out after {PREVIEW_TIMEOUT_S}s\n# Task: {task}\n"
    except Exception as e:
        return f"# Preview error: {e}\n# Task: {task}\n"


def run_pipeline_real(task: str, cluster: str) -> bool:
    """Run the actual fix pipeline after human approval."""
    try:
        result = subprocess.run(
            PIPELINE_CMD + ["--task", task, "--record-meta"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=300,
        )
        return result.returncode == 0
    except Exception as e:
        print(f"[preview] pipeline error: {e}")
        return False


# ─── Preview queue management ─────────────────────────────────────────────────

def enqueue_preview(task: str, cluster: str, confidence: float,
                    meeting_id: str = "manual", speaker: str = "unknown") -> dict:
    q     = _load_queue()
    entry = {
        "id":          f"prev_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}",
        "task":        task,
        "cluster":     cluster,
        "confidence":  confidence,
        "meeting_id":  meeting_id,
        "speaker":     speaker,
        "state":       "pending",
        "diff":        None,
        "queued_at":   _now(),
        "updated_at":  _now(),
    }
    q.append(entry)
    _save_queue(q)

    # Generate diff in background thread
    def _gen():
        diff = generate_preview_diff(task, cluster)
        q2   = _load_queue()
        for item in q2:
            if item["id"] == entry["id"]:
                item["diff"]       = diff
                item["updated_at"] = _now()
                # Auto-approve high-confidence tasks
                item["state"] = "ready"
                if confidence >= AUTO_APPROVE_CONFIDENCE:
                    item["state"] = "approved"
                    item["auto_approved"] = True
                    print(f"[preview] auto-approved ({confidence:.0%}): {task[:50]}")
                    t = threading.Thread(target=_execute, args=(item,), daemon=True)
                    t.start()
                break
        _save_queue(q2)

    threading.Thread(target=_gen, daemon=True).start()
    return entry


def approve_preview(preview_id: str) -> dict | None:
    q = _load_queue()
    target = next((item for item in q if item["id"] == preview_id), None)
    if not target or target["state"] not in ("pending", "ready"):
        return None
    target["state"]      = "approved"
    target["updated_at"] = _now()
    _save_queue(q)
    threading.Thread(target=_execute, args=(target,), daemon=True).start()
    return target


def reject_preview(preview_id: str) -> dict | None:
    q = _load_queue()
    target = next((item for item in q if item["id"] == preview_id), None)
    if not target:
        return None
    target["state"]      = "rejected"
    target["updated_at"] = _now()
    _save_queue(q)
    return target


def _execute(item: dict) -> None:
    task    = item["task"]
    cluster = item["cluster"]
    print(f"[preview] executing: {task[:60]}")
    success = run_pipeline_real(task, cluster)
    q = _load_queue()
    for i in q:
        if i["id"] == item["id"]:
            i["state"]      = "applied" if success else "failed"
            i["updated_at"] = _now()
            break
    _save_queue(q)
    print(f"[preview] {'applied' if success else 'FAILED'}: {task[:60]}")


# ─── HTML UI (served inline) ──────────────────────────────────────────────────

_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meitheal Live Preview</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0d0d0d; color: #e0e0e0; margin: 0; padding: 0; }
  header { background: #1a1a2e; padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
  header h1 { margin: 0; font-size: 1.1rem; color: #7eb8f7; }
  .badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 12px; font-weight: 600; }
  .badge-pending  { background: #333; color: #aaa; }
  .badge-ready    { background: #1a3a5c; color: #7eb8f7; }
  .badge-approved { background: #1a3a1a; color: #7ef77e; }
  .badge-rejected { background: #3a1a1a; color: #f77e7e; }
  .badge-applied  { background: #1e3a2e; color: #5ef5b0; }
  .badge-failed   { background: #3a1a1a; color: #f77e7e; }
  #items { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
  .card { background: #161625; border: 1px solid #2a2a40; border-radius: 8px; overflow: hidden; }
  .card-header { padding: 12px 16px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #2a2a40; }
  .card-header .task { font-weight: 600; flex: 1; font-size: 0.95rem; }
  .card-header .meta { font-size: 0.75rem; color: #888; }
  .diff-block { background: #111; padding: 14px 16px; overflow-x: auto; font-family: 'Cascadia Code', monospace; font-size: 0.82rem; line-height: 1.5; }
  .diff-block .add  { color: #7ef77e; }
  .diff-block .del  { color: #f77e7e; }
  .diff-block .hunk { color: #88aacc; }
  .diff-block .ctx  { color: #888; }
  .actions { padding: 10px 16px; display: flex; gap: 8px; }
  button { padding: 6px 18px; border-radius: 6px; border: none; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
  .btn-approve { background: #2a6a2a; color: #9ef59e; }
  .btn-approve:hover { background: #3a8a3a; }
  .btn-reject  { background: #6a2a2a; color: #f59e9e; }
  .btn-reject:hover  { background: #8a3a3a; }
  .empty { text-align: center; color: #555; padding: 60px 20px; }
</style>
</head>
<body>
<header>
  <h1>Meitheal Live Preview</h1>
  <span id="status-dot" style="color:#5ef5b0;font-size:0.8rem;">● live</span>
</header>
<div id="items"><div class="empty">Waiting for tasks from the meeting agent…</div></div>
<script>
function renderDiff(diff) {
  if (!diff) return '<span style="color:#555">Generating preview…</span>';
  return diff.split('\n').map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="add">${esc(line)}</span>`;
    if (line.startsWith('-') && !line.startsWith('---')) return `<span class="del">${esc(line)}</span>`;
    if (line.startsWith('@@'))                           return `<span class="hunk">${esc(line)}</span>`;
    return `<span class="ctx">${esc(line)}</span>`;
  }).join('\n');
}
function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function actionBtns(id, state) {
  if (state === 'ready') return `
    <button class="btn-approve" onclick="act('${id}','approve')">Approve + Run</button>
    <button class="btn-reject"  onclick="act('${id}','reject')">Reject</button>`;
  if (state === 'pending') return `<span style="color:#888;font-size:0.8rem">Generating diff…</span>`;
  return '';
}
async function act(id, action) {
  await fetch(`/${action}/${id}`, {method:'POST'});
  poll();
}
async function poll() {
  try {
    const res  = await fetch('/api/queue');
    const data = await res.json();
    const el   = document.getElementById('items');
    if (!data.length) {
      el.innerHTML = '<div class="empty">Waiting for tasks from the meeting agent…</div>';
      return;
    }
    el.innerHTML = data.map(item => `
      <div class="card">
        <div class="card-header">
          <div class="task">${esc(item.task)}</div>
          <span class="badge badge-${item.state}">${item.state}</span>
          <span class="meta">${item.cluster} · ${(item.confidence*100).toFixed(0)}% · ${item.speaker}</span>
        </div>
        <pre class="diff-block">${renderDiff(item.diff)}</pre>
        <div class="actions">${actionBtns(item.id, item.state)}</div>
      </div>`).join('');
  } catch(e) {
    document.getElementById('status-dot').textContent = '● offline';
    document.getElementById('status-dot').style.color = '#f77e7e';
  }
}
poll();
setInterval(poll, 2000);
</script>
</body>
</html>"""


# ─── HTTP server ──────────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw    = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def _send_json(self, data, code: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html: str) -> None:
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send_html(_HTML)
        elif self.path == "/api/queue":
            self._send_json(_load_queue())
        elif self.path == "/health":
            self._send_json({"status": "ok"})
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        body = self._read_body()

        if self.path == "/preview":
            # From Teams agent or bridge: queue a new preview
            entry = enqueue_preview(
                task       = body.get("task", ""),
                cluster    = body.get("cluster", "other"),
                confidence = float(body.get("confidence", 0.7)),
                meeting_id = body.get("meeting_id", "unknown"),
                speaker    = body.get("speaker", "unknown"),
            )
            self._send_json({"ok": True, "id": entry["id"], "state": entry["state"]})

        elif self.path.startswith("/approve/"):
            preview_id = self.path[len("/approve/"):]
            result     = approve_preview(preview_id)
            self._send_json({"ok": bool(result), "state": result["state"] if result else None})

        elif self.path.startswith("/reject/"):
            preview_id = self.path[len("/reject/"):]
            result     = reject_preview(preview_id)
            self._send_json({"ok": bool(result)})

        else:
            self._send_json({"error": "not found"}, 404)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Live diff preview server for meeting agent")
    sub = parser.add_subparsers(dest="cmd", required=True)

    srv = sub.add_parser("serve", help="Start the preview HTTP server")
    srv.add_argument("--port", type=int, default=9001)

    q_p = sub.add_parser("queue", help="Manually queue a preview task")
    q_p.add_argument("--task",       required=True)
    q_p.add_argument("--cluster",    default="other")
    q_p.add_argument("--confidence", type=float, default=0.80)

    sub.add_parser("status", help="Show current preview queue")

    args = parser.parse_args()

    if args.cmd == "serve":
        server = HTTPServer(("0.0.0.0", args.port), _Handler)
        print(f"Preview server on http://localhost:{args.port}")
        print(f"  GET  /             — live diff UI (open in browser)")
        print(f"  GET  /api/queue    — JSON queue state")
        print(f"  POST /preview      — queue a task for preview")
        print(f"  POST /approve/:id  — approve and execute")
        print(f"  POST /reject/:id   — reject")
        print(f"  Auto-approve threshold: confidence >= {AUTO_APPROVE_CONFIDENCE:.0%}")
        server.serve_forever()

    elif args.cmd == "queue":
        entry = enqueue_preview(args.task, args.cluster, args.confidence)
        print(f"Queued: {entry['id']}  state={entry['state']}")
        print("Open http://localhost:9001 to review")

    elif args.cmd == "status":
        q = _load_queue()
        if not q:
            print("Preview queue is empty")
            return
        print(f"{'ID':<25} {'State':<10} {'Conf':>5}  {'Task'}")
        print("-" * 75)
        for item in q:
            print(f"{item['id']:<25} {item['state']:<10} "
                  f"{item['confidence']:>5.0%}  {item['task'][:45]}")


if __name__ == "__main__":
    main()
