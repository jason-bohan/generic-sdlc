import { readBody, json } from '../router';
import { processMeetingText } from '../meeting-agent';
import type { UseFn } from './types';

const meetingMemory = new Map<string, string[]>();

function getActivityText(body: Record<string, unknown>): string {
    const text = body.text;
    if (typeof text === 'string') return text;
    const value = body.value;
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).text === 'string') {
        return String((value as Record<string, unknown>).text);
    }
    return '';
}

function getSpeaker(body: Record<string, unknown>): string | undefined {
    const from = body.from;
    if (from && typeof from === 'object') {
        const name = (from as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) return name.trim();
    }
    return typeof body.speaker === 'string' ? body.speaker : undefined;
}

export function mount(use: UseFn, rootDir: string): void {
    use('/api/meeting-agent/messages', async (req, res) => {
        if (req.method === 'GET') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meeting Agent Demo</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, Segoe UI, sans-serif; background: #101418; color: #eef2f7; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: start center; padding: 32px; }
    main { width: min(920px, 100%); }
    h1 { font-size: 28px; margin: 0 0 16px; }
    label { display: block; margin: 18px 0 8px; color: #b9c4d0; }
    textarea, input { box-sizing: border-box; width: 100%; border: 1px solid #334155; background: #151b23; color: #eef2f7; border-radius: 6px; padding: 12px; font: inherit; }
    textarea { min-height: 130px; resize: vertical; }
    .row { display: flex; gap: 12px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; background: #3b82f6; color: white; font: inherit; cursor: pointer; }
    button.secondary { background: #334155; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0b0f14; border: 1px solid #334155; border-radius: 6px; padding: 14px; min-height: 160px; }
  </style>
</head>
<body>
  <main>
    <h1>Meeting Agent Demo</h1>
    <label for="meeting-text">Meeting message</label>
    <textarea id="meeting-text">Action item for frontend: implement moving the AI controls into AICommandRoom and add tests for routing.</textarea>
    <label for="meeting-id">Meeting ID</label>
    <input id="meeting-id" value="demo-meeting-1" />
    <div class="row">
      <label><input id="execute" type="checkbox" /> Dispatch to agents</label>
      <button id="send">Analyze</button>
      <button id="clear" class="secondary">Clear Output</button>
    </div>
    <label>Response</label>
    <pre id="output">(waiting)</pre>
  </main>
  <script>
    const output = document.getElementById('output');
    document.getElementById('send').addEventListener('click', async () => {
      output.textContent = 'Analyzing...';
      const body = {
        type: 'message',
        text: document.getElementById('meeting-text').value,
        conversation: { id: document.getElementById('meeting-id').value || 'demo-meeting-1' },
        from: { name: 'Demo User' },
        execute: document.getElementById('execute').checked
      };
      try {
        const res = await fetch('/api/meeting-agent/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        output.textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        output.textContent = String(e);
      }
    });
    document.getElementById('clear').addEventListener('click', () => { output.textContent = '(waiting)'; });
  </script>
</body>
</html>`);
            return;
        }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        try {
            const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
            const text = getActivityText(body).trim();
            if (!text) {
                json(res, { error: 'text is required' }, 400);
                return;
            }
            const conversation = body.conversation && typeof body.conversation === 'object'
                ? body.conversation as Record<string, unknown>
                : {};
            const meetingId = String(body.meetingId || conversation.id || 'default-meeting');
            const memory = meetingMemory.get(meetingId) ?? [];
            meetingMemory.set(meetingId, memory);
            const execute = body.execute !== false;
            const result = await processMeetingText({
                text,
                meetingId,
                speaker: getSpeaker(body),
                execute,
                memory,
                rootDir,
            });
            json(res, {
                type: 'message',
                text: result.reply,
                ok: true,
                tasks: result.tasks,
                decisions: result.decisions,
                trace: result.trace,
            });
        } catch (e) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });
}
