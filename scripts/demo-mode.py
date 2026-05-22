#!/usr/bin/env python3
"""
demo-mode.py  —  Hardcoded end-to-end demo: conversation → diff → PR.

No LLM calls. No pipeline. No external services required.
This is what you show to people. It works every time.

The scenario: team discussion about extracting the AIHealth component out of
SimpleFloor.tsx into its own file — a real refactor in this actual codebase.

Modes:
  demo  (default) — fully simulated, nothing touches git. Safe to run anywhere.
  live            — after user clicks Approve, actually runs the real pipeline.

Usage:
  python scripts/demo-mode.py
  python scripts/demo-mode.py --port 9002
  python scripts/demo-mode.py --live
  python scripts/demo-mode.py --speed slow   (for screen recordings)
"""

import argparse
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent

# ─── Hardcoded demo scenario ──────────────────────────────────────────────────

SCENARIO = {
    "title":    "Extract AIHealth into dedicated component",
    "cluster":  "refactor",
    "speaker":  "Jason",
    "transcript": [
        {"speaker": "Jason",  "text": "The AIHealth display is still buried inside SimpleFloor — it's getting hard to maintain."},
        {"speaker": "Sarah",  "text": "Yeah, and we can't reuse it anywhere. It should be its own component."},
        {"speaker": "Jason",  "text": "Let's move it. AIHealth.tsx, export the component, import it in SimpleFloor."},
        {"speaker": "Sarah",  "text": "Makes sense. Should be a clean lift-and-shift, no logic changes."},
    ],
    "extracted_task": "Extract AI health display from SimpleFloor.tsx into dedicated AIHealth component",
    "confidence": 0.94,
    "diff": """\
diff --git a/src/dashboard/SimpleFloor.tsx b/src/dashboard/SimpleFloor.tsx
index a3f1c2d..7b84e91 100644
--- a/src/dashboard/SimpleFloor.tsx
+++ b/src/dashboard/SimpleFloor.tsx
@@ -1,8 +1,9 @@
 import React from 'react';
+import { AIHealth } from './AIHealth';
 import { AgentCard } from './components/AgentCard';
-import { useAgentHealth } from '../hooks/useAgentHealth';

 export function SimpleFloor() {
-  const { healthStatus, isLoading } = useAgentHealth();
-
   return (
     <div className="floor-grid">
@@ -12,20 +13,7 @@
       {agents.map(agent => (
         <AgentCard key={agent.id} agent={agent} />
       ))}
-      <div className="health-panel">
-        {isLoading ? (
-          <span className="loading">Checking agent health...</span>
-        ) : (
-          <div className="health-status">
-            <span className={`status-dot ${healthStatus}`} />
-            <span>
-              {healthStatus === 'healthy' ? 'All agents nominal' : 'Issues detected'}
-            </span>
-          </div>
-        )}
-      </div>
+      <AIHealth />
     </div>
   );
 }

diff --git a/src/dashboard/AIHealth.tsx b/src/dashboard/AIHealth.tsx
new file mode 100644
index 0000000..c4f28a3
--- /dev/null
+++ b/src/dashboard/AIHealth.tsx
@@ -0,0 +1,24 @@
+import React from 'react';
+import { useAgentHealth } from '../hooks/useAgentHealth';
+
+export function AIHealth() {
+  const { healthStatus, isLoading } = useAgentHealth();
+
+  return (
+    <div className="health-panel">
+      {isLoading ? (
+        <span className="loading">Checking agent health...</span>
+      ) : (
+        <div className="health-status">
+          <span className={`status-dot ${healthStatus}`} />
+          <span>
+            {healthStatus === 'healthy'
+              ? 'All agents nominal'
+              : 'Issues detected'}
+          </span>
+        </div>
+      )}
+    </div>
+  );
+}
""",
    "pr_url":  "https://github.com/meitheal/meitheal/pull/42",
    "pr_title": "refactor(dashboard): extract AIHealth into dedicated component",
    "files_changed": 2,
    "lines_added": 24,
    "lines_removed": 15,
}

# ─── State (in-memory, reset per demo run) ───────────────────────────────────

_state = {
    "step":          "idle",   # idle | transcript | extracted | diff | approving | done
    "transcript_idx": 0,
    "live_mode":     False,
    "speed":         "normal", # slow | normal | fast
}

_STEP_DELAYS = {
    "slow":   {"char": 0.04, "line": 1.8, "extract": 3.0, "diff": 2.0, "pr": 2.5},
    "normal": {"char": 0.02, "line": 1.2, "extract": 1.8, "diff": 1.2, "pr": 1.5},
    "fast":   {"char": 0.00, "line": 0.5, "extract": 0.8, "diff": 0.6, "pr": 0.8},
}


def _delays():
    return _STEP_DELAYS[_state["speed"]]


def reset_demo():
    _state["step"]          = "idle"
    _state["transcript_idx"] = 0


# ─── Demo playback (runs in background thread) ────────────────────────────────

def run_demo():
    d = _delays()
    _state["step"] = "transcript"

    for i, line in enumerate(SCENARIO["transcript"]):
        _state["transcript_idx"] = i + 1
        time.sleep(d["line"])

    time.sleep(d["extract"])
    _state["step"] = "extracted"

    time.sleep(d["diff"])
    _state["step"] = "diff"


def run_approve(live_mode: bool):
    _state["step"] = "approving"
    time.sleep(_delays()["pr"])

    if live_mode:
        _run_live_pipeline()
    else:
        # Simulated — always succeeds
        pass

    _state["step"] = "done"


def _run_live_pipeline():
    pipeline = SCRIPTS_DIR / "fix-pipeline.py"
    if pipeline.exists():
        subprocess.run(
            [sys.executable, str(pipeline),
             "--task", SCENARIO["extracted_task"],
             "--record-meta"],
            timeout=180,
        )


# ─── HTML UI ──────────────────────────────────────────────────────────────────

_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meitheal — Meeting Demo</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a14;color:#e0e0f0;min-height:100vh;display:flex;flex-direction:column}
header{background:linear-gradient(90deg,#1a1a35,#0f1a2e);padding:14px 24px;display:flex;align-items:center;gap:14px;border-bottom:1px solid #1e2a45}
header h1{font-size:1.15rem;font-weight:700;color:#7eb8f7;letter-spacing:-0.01em}
.demo-badge{background:#2a1a50;color:#b088ff;font-size:0.68rem;font-weight:700;padding:3px 10px;border-radius:12px;text-transform:uppercase;letter-spacing:0.08em}
main{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:0;height:calc(100vh - 54px)}
.panel{padding:20px 24px;display:flex;flex-direction:column;gap:14px}
.panel-left{border-right:1px solid #1e2a45}
.section-title{font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#556;margin-bottom:4px}
/* Transcript */
.transcript{display:flex;flex-direction:column;gap:8px;flex:1}
.utterance{opacity:0;transform:translateY(6px);transition:opacity 0.4s,transform 0.4s;padding:10px 14px;border-radius:8px;background:#12121e;border:1px solid #1e2a45}
.utterance.visible{opacity:1;transform:translateY(0)}
.utterance .who{font-size:0.72rem;font-weight:700;color:#7eb8f7;margin-bottom:4px}
.utterance .what{font-size:0.88rem;color:#c0c0d8;line-height:1.45}
/* Task extraction */
.task-box{padding:14px 16px;border-radius:8px;background:#0e1a10;border:1px solid #1a3a20;opacity:0;transition:opacity 0.5s,transform 0.4s;transform:translateY(6px)}
.task-box.visible{opacity:1;transform:translateY(0)}
.task-box .label{font-size:0.7rem;color:#5a9a5a;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.task-box .label::before{content:"✓";background:#2a6a2a;color:#9ef59e;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-size:0.65rem;flex-shrink:0}
.task-box .task-text{font-size:0.95rem;font-weight:600;color:#e0f0e0}
.conf-bar{margin-top:10px;display:flex;align-items:center;gap:8px}
.conf-bar-bg{flex:1;height:4px;background:#1a2a1a;border-radius:2px}
.conf-bar-fill{height:4px;background:linear-gradient(90deg,#4a9a4a,#7ef77e);border-radius:2px;transition:width 1s ease}
.conf-label{font-size:0.7rem;color:#5a9a5a;width:32px;text-align:right}
/* Diff */
.diff-box{flex:1;overflow:hidden;display:flex;flex-direction:column;opacity:0;transition:opacity 0.5s}
.diff-box.visible{opacity:1}
.diff-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#111120;border:1px solid #1e2a45;border-bottom:none;border-radius:8px 8px 0 0}
.diff-meta{font-size:0.72rem;color:#778;display:flex;gap:12px}
.diff-meta .adds{color:#5a9a5a}
.diff-meta .dels{color:#9a5a5a}
.diff-scroll{overflow-y:auto;border:1px solid #1e2a45;border-radius:0 0 8px 8px;background:#0c0c14;flex:1}
pre.diff{font-family:'Cascadia Code','Fira Mono',monospace;font-size:0.78rem;line-height:1.5;padding:12px 16px;white-space:pre;tab-size:2}
.d-add{color:#7ef77e;background:rgba(100,200,100,0.06)}
.d-del{color:#f77e7e;background:rgba(200,100,100,0.06)}
.d-hunk{color:#7eb8f7}
.d-ctx{color:#556}
.d-file{color:#b088ff;font-weight:700}
/* Actions */
.action-bar{display:flex;gap:10px;padding-top:8px;border-top:1px solid #1e2a45;margin-top:auto}
button{padding:10px 22px;border:none;border-radius:7px;font-size:0.88rem;font-weight:700;cursor:pointer;transition:background 0.15s,transform 0.1s;letter-spacing:0.01em}
button:active{transform:scale(0.97)}
.btn-approve{background:linear-gradient(135deg,#1a6a1a,#2a8a2a);color:#c0f0c0}
.btn-approve:hover{background:linear-gradient(135deg,#2a8a2a,#3aaa3a)}
.btn-approve:disabled{opacity:0.4;cursor:default}
.btn-reset{background:#1a1a30;color:#778;border:1px solid #2a2a45}
.btn-reset:hover{background:#22223a}
/* PR done state */
.pr-done{opacity:0;transition:opacity 0.5s;padding:16px;background:#0e1a10;border:1px solid #1a3a20;border-radius:8px;display:flex;flex-direction:column;gap:10px}
.pr-done.visible{opacity:1}
.pr-done .pr-title{font-size:0.82rem;font-weight:700;color:#9ef59e}
.pr-done .pr-url a{font-size:0.82rem;color:#7eb8f7;text-decoration:none}
.pr-done .pr-url a:hover{text-decoration:underline}
.pr-stats{display:flex;gap:14px;font-size:0.75rem;color:#778}
.pr-stats .adds{color:#7ef77e}
.pr-stats .dels{color:#f77e7e}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #2a2a45;border-top-color:#7eb8f7;border-radius:50%;animation:spin 0.7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.idle-hint{color:#334;font-size:0.88rem;text-align:center;padding:40px 0;flex:1;display:flex;align-items:center;justify-content:center}
</style>
</head>
<body>
<header>
  <h1>Meitheal</h1>
  <span class="demo-badge">Demo Mode</span>
  <span style="color:#556;font-size:0.8rem;margin-left:auto">conversation → code → PR</span>
</header>
<main>
  <div class="panel panel-left">
    <div>
      <div class="section-title">Meeting Transcript</div>
      <div id="transcript" class="transcript">
        <div class="idle-hint" id="idle-hint">Click "Start Demo" to begin</div>
      </div>
    </div>
    <div id="task-box" class="task-box" style="display:none">
      <div class="label">Task extracted (94% confidence)</div>
      <div class="task-text" id="task-text"></div>
      <div class="conf-bar">
        <div class="conf-bar-bg"><div class="conf-bar-fill" id="conf-fill" style="width:0%"></div></div>
        <span class="conf-label" id="conf-pct">0%</span>
      </div>
    </div>
    <div class="action-bar">
      <button id="btn-start" class="btn-approve" onclick="startDemo()">▶ Start Demo</button>
      <button class="btn-reset" onclick="resetDemo()">↺ Reset</button>
    </div>
  </div>

  <div class="panel">
    <div style="flex:1;display:flex;flex-direction:column;gap:14px">
      <div>
        <div class="section-title">Proposed Changes</div>
      </div>
      <div id="diff-box" class="diff-box" style="display:none">
        <div class="diff-header">
          <span style="font-size:0.78rem;color:#aaa;font-family:monospace">src/dashboard/</span>
          <span class="diff-meta">
            <span class="adds">+24</span>
            <span class="dels">-15</span>
            <span>2 files</span>
          </span>
        </div>
        <div class="diff-scroll"><pre class="diff" id="diff-content"></pre></div>
      </div>
      <div id="diff-placeholder" class="idle-hint">Diff will appear after task extraction</div>
    </div>

    <div id="pr-done" class="pr-done" style="display:none">
      <div class="pr-title">✓ Pull request created</div>
      <div class="pr-url"><a id="pr-url-link" href="#" target="_blank"></a></div>
      <div class="pr-stats">
        <span class="adds">+24 lines</span>
        <span class="dels">-15 lines</span>
        <span>2 files changed</span>
        <span>Branch: meeting/refactor/extract-ai-health</span>
      </div>
    </div>

    <div class="action-bar" style="margin-top:auto">
      <button id="btn-approve" class="btn-approve" onclick="approve()" disabled>
        Apply &amp; Create PR
      </button>
    </div>
  </div>
</main>

<script>
const TRANSCRIPT = SCENARIO_JSON.transcript;
const DIFF_RAW   = SCENARIO_JSON.diff;
const TASK_TEXT  = SCENARIO_JSON.extracted_task;
const CONF       = SCENARIO_JSON.confidence;
const PR_URL     = SCENARIO_JSON.pr_url;
const PR_TITLE   = SCENARIO_JSON.pr_title;

let running = false;
let pollerActive = false;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function renderDiff(raw) {
  return raw.split('\n').map(line => {
    const e = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file'))
      return `<span class="d-file">${e}</span>`;
    if (line.startsWith('+++') || line.startsWith('---'))
      return `<span class="d-file">${e}</span>`;
    if (line.startsWith('+'))  return `<span class="d-add">${e}</span>`;
    if (line.startsWith('-'))  return `<span class="d-del">${e}</span>`;
    if (line.startsWith('@@')) return `<span class="d-hunk">${e}</span>`;
    return `<span class="d-ctx">${e}</span>`;
  }).join('\n');
}

async function startDemo() {
  if (running) return;
  running = true;
  document.getElementById('btn-start').disabled = true;
  document.getElementById('idle-hint')?.remove();

  const tc = document.getElementById('transcript');

  // Step 1: play transcript
  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const div = document.createElement('div');
    div.className = 'utterance';
    div.innerHTML = `<div class="who">${TRANSCRIPT[i].speaker}</div><div class="what">${TRANSCRIPT[i].text}</div>`;
    tc.appendChild(div);
    await sleep(50);
    div.classList.add('visible');
    await sleep(1200 + TRANSCRIPT[i].text.length * 12);
  }

  // Step 2: show task
  await sleep(800);
  const taskBox = document.getElementById('task-box');
  taskBox.style.display = 'block';
  document.getElementById('task-text').textContent = TASK_TEXT;
  await sleep(50);
  taskBox.classList.add('visible');

  // Animate confidence bar
  await sleep(300);
  const pct = Math.round(CONF * 100);
  document.getElementById('conf-fill').style.width = pct + '%';
  document.getElementById('conf-pct').textContent = pct + '%';

  // Step 3: show diff
  await sleep(1400);
  document.getElementById('diff-placeholder').style.display = 'none';
  const diffBox = document.getElementById('diff-box');
  diffBox.style.display = 'flex';
  document.getElementById('diff-content').innerHTML = renderDiff(DIFF_RAW);
  await sleep(80);
  diffBox.classList.add('visible');

  // Enable approve
  document.getElementById('btn-approve').disabled = false;
  document.getElementById('btn-approve').textContent = 'Apply & Create PR';
}

async function approve() {
  const btn = document.getElementById('btn-approve');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating PR…';

  // Call server
  try {
    await fetch('/approve', {method:'POST'});
  } catch(e) {}

  await sleep(1500);

  const prDone = document.getElementById('pr-done');
  prDone.style.display = 'block';
  const link = document.getElementById('pr-url-link');
  link.href = PR_URL;
  link.textContent = PR_TITLE + ' → ' + PR_URL;
  await sleep(50);
  prDone.classList.add('visible');

  btn.textContent = '✓ PR Created';
  btn.style.background = 'linear-gradient(135deg,#0e3a1a,#1a5a2a)';
}

function resetDemo() {
  fetch('/reset', {method:'POST'}).then(() => location.reload());
}
</script>
</body>
</html>"""


# ─── HTTP server ──────────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    live_mode = False

    def log_message(self, fmt, *args):
        pass

    def _send(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html: str) -> None:
        # Inject the scenario JSON into the page
        scenario_js = f"const SCENARIO_JSON = {json.dumps(SCENARIO)};"
        html = html.replace("const SCENARIO_JSON = SCENARIO_JSON;", scenario_js)
        # Fix: replace the placeholder in the script block
        html = html.replace("SCENARIO_JSON.transcript", "SCENARIO_JSON.transcript")
        # Actually inject properly:
        html = html.replace(
            "<script>",
            f"<script>\nconst SCENARIO_JSON = {json.dumps(SCENARIO, ensure_ascii=False)};\n",
            1
        )
        # Remove the duplicate line we added
        html = html.replace(
            "const SCENARIO_JSON = SCENARIO_JSON;", ""
        )
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send_html(_HTML)
        elif self.path == "/state":
            self._send(_state)
        elif self.path == "/health":
            self._send({"status": "ok", "live_mode": self.__class__.live_mode})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/approve":
            threading.Thread(
                target=run_approve,
                args=(self.__class__.live_mode,),
                daemon=True,
            ).start()
            self._send({"ok": True})
        elif self.path == "/reset":
            reset_demo()
            self._send({"ok": True})
        else:
            self._send({"error": "not found"}, 404)


# ─── Clean HTML injection ─────────────────────────────────────────────────────

def _build_html() -> str:
    """Inject the scenario JSON directly into the HTML so no API call is needed."""
    scenario_json = json.dumps(SCENARIO, ensure_ascii=False, indent=None)
    return _HTML.replace(
        "<script>",
        f"<script>\nconst SCENARIO_JSON = {scenario_json};\n",
        1,
    )


# Patch _send_html to use pre-built version
_BUILT_HTML = _build_html()


class DemoHandler(BaseHTTPRequestHandler):
    live_mode = False

    def log_message(self, fmt, *args):
        pass

    def _json(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            body = _BUILT_HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/state":
            self._json(_state)
        elif self.path == "/health":
            self._json({"status": "ok", "live_mode": self.__class__.live_mode,
                        "scenario": SCENARIO["title"]})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/approve":
            threading.Thread(
                target=run_approve,
                args=(self.__class__.live_mode,),
                daemon=True,
            ).start()
            self._json({"ok": True})
        elif self.path == "/reset":
            reset_demo()
            self._json({"ok": True})
        else:
            self._json({"error": "not found"}, 404)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Meitheal demo mode — hardcoded end-to-end demo, always works"
    )
    parser.add_argument("--port",  type=int, default=9002)
    parser.add_argument("--live",  action="store_true",
                        help="After Approve: actually run fix-pipeline (default: simulated)")
    parser.add_argument("--speed", default="normal",
                        choices=["slow", "normal", "fast"],
                        help="Playback speed (slow = good for screen recording)")
    args = parser.parse_args()

    _state["speed"]    = args.speed
    _state["live_mode"] = args.live
    DemoHandler.live_mode = args.live

    mode_label = "LIVE (real pipeline)" if args.live else "SIMULATED (safe)"

    print()
    print("  Meitheal — Demo Mode")
    print("  " + "─" * 40)
    print(f"  Scenario : {SCENARIO['title']}")
    print(f"  Mode     : {mode_label}")
    print(f"  Speed    : {args.speed}")
    print(f"  URL      : http://localhost:{args.port}")
    print()
    print("  Open the URL in a browser, click 'Start Demo'.")
    print("  Press Ctrl+C to stop.")
    print()

    server = HTTPServer(("0.0.0.0", args.port), DemoHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Done.")


if __name__ == "__main__":
    main()
