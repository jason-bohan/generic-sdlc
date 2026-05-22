#!/usr/bin/env python3
"""
voice-agent.py  —  Text-to-speech agent that speaks in meetings.

Turns agent responses into audio, plays them through a virtual mic (VB-CABLE)
so the agent's voice appears in the Teams meeting call.

Windows setup:
  1. Install VB-CABLE: https://vb-audio.com/Cable/
  2. In Teams audio settings: Microphone = "CABLE Input (VB-Audio)"
  3. Run this script; it routes speech through CABLE

Standalone TTS:
  python scripts/voice-agent.py speak --text "Fix will require updating SettingsPanel"

HTTP server mode (called by whisper-stream / bridge):
  python scripts/voice-agent.py serve --port 9339

Usage:
  python scripts/voice-agent.py speak --text "Refactoring SettingsPanel into AICommandRoom"
  python scripts/voice-agent.py serve --port 9339
  python scripts/voice-agent.py list-voices
"""

import argparse
import asyncio
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

CABLE_DEVICE = os.environ.get("VBCABLE_DEVICE", "CABLE Input")  # VB-CABLE virtual mic
DEFAULT_VOICE = "en-US-GuyNeural"      # Microsoft Edge TTS voice
DEFAULT_RATE  = "+5%"                  # slightly faster than default
CONFIDENCE_GATE = 0.75                 # don't speak below this confidence
TEMP_DIR = Path(tempfile.gettempdir())


# ─── TTS synthesis ────────────────────────────────────────────────────────────

async def _synthesize(text: str, voice: str, rate: str, output_path: Path) -> None:
    try:
        import edge_tts
    except ImportError:
        print("ERROR: pip install edge-tts")
        sys.exit(1)
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(str(output_path))


def synthesize(text: str, voice: str = DEFAULT_VOICE, rate: str = DEFAULT_RATE) -> Path:
    out = TEMP_DIR / "SDLC Framework_voice.mp3"
    asyncio.run(_synthesize(text, voice, rate, out))
    return out


# ─── Audio playback ───────────────────────────────────────────────────────────

def play_to_device(audio_path: Path, device_name: str | None = None) -> None:
    """
    Play audio file. If device_name is set (e.g. "CABLE Input"), route there
    using pygame's mixer; otherwise play through the default output device.
    """
    try:
        import pygame
    except ImportError:
        # Fallback: use os start / afplay / aplay
        _play_fallback(audio_path)
        return

    if not pygame.mixer.get_init():
        if device_name:
            # pygame doesn't expose output device directly; on Windows we can
            # use pre_init to set sample rate then rely on OS routing via VB-CABLE
            # being set as the default device (user must do this in Control Panel).
            pygame.mixer.pre_init(frequency=24000, size=-16, channels=1, buffer=512)
        pygame.mixer.init()

    pygame.mixer.music.load(str(audio_path))
    pygame.mixer.music.play()
    while pygame.mixer.music.get_busy():
        time.sleep(0.05)


def _play_fallback(audio_path: Path) -> None:
    """OS-level fallback: use powershell / afplay / aplay."""
    if sys.platform == "win32":
        subprocess.run(
            ["powershell", "-c", f'(New-Object Media.SoundPlayer "{audio_path}").PlaySync()'],
            capture_output=True,
        )
    elif sys.platform == "darwin":
        subprocess.run(["afplay", str(audio_path)])
    else:
        subprocess.run(["aplay", str(audio_path)], capture_output=True)


# ─── High-level speak function ────────────────────────────────────────────────

def speak(text: str, confidence: float = 1.0, voice: str = DEFAULT_VOICE,
          route_to_cable: bool = True) -> bool:
    """
    Synthesize and play text. Returns True if spoken, False if below threshold.
    """
    if confidence < CONFIDENCE_GATE:
        print(f"  [voice] below threshold ({confidence:.2f} < {CONFIDENCE_GATE}) — silent")
        return False

    text = text.strip()
    if not text:
        return False

    print(f"  [voice] speaking ({confidence:.2f}): {text[:80]}")
    try:
        audio = synthesize(text, voice=voice)
        device = CABLE_DEVICE if route_to_cable else None
        play_to_device(audio, device)
        return True
    except Exception as e:
        print(f"  [voice] error: {e}")
        return False


# ─── Response generation ──────────────────────────────────────────────────────

_RESPONSE_PROMPTS = {
    "task": (
        "You are a concise AI engineering assistant in a meeting. "
        "A coding task was just detected. Respond in 1-2 sentences acknowledging "
        "it and briefly stating your approach. Be direct, no filler. "
        "Task: {task}"
    ),
    "decision": (
        "You are a concise AI engineering assistant in a meeting. "
        "The team just made an architectural decision. Acknowledge it briefly "
        "and note any implications in 1 sentence. "
        "Decision: {decision}"
    ),
    "question": (
        "You are a concise AI engineering assistant in a meeting. "
        "An open question was raised. Offer a brief answer or suggest next steps "
        "in 1-2 sentences. "
        "Question: {question}"
    ),
}


def generate_response(kind: str, content: str, mesh_url: str, model: str) -> str | None:
    import urllib.request as ur
    prompt = _RESPONSE_PROMPTS.get(kind, "").format(**{kind: content})
    if not prompt:
        return None
    payload = json.dumps({
        "model":    model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.4,
        "max_tokens":  80,
    }).encode()
    try:
        req = ur.Request(
            f"{mesh_url}/chat/completions",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": "Bearer mesh"},
            method="POST",
        )
        with ur.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"  [voice] LLM error: {e}")
        return None


# ─── HTTP server mode ─────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    mesh_url = "http://localhost:9337/v1"
    model    = "qwen3:8b"
    voice    = DEFAULT_VOICE
    cable    = True

    def log_message(self, fmt, *args):
        pass

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw    = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def _send(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self._read_body()

        if self.path == "/speak":
            # Direct TTS: {"text": "...", "confidence": 0.9}
            text       = body.get("text", "")
            confidence = float(body.get("confidence", 1.0))
            spoken = speak(text, confidence, voice=self.__class__.voice,
                           route_to_cable=self.__class__.cable)
            self._send({"ok": True, "spoken": spoken, "text": text})

        elif self.path in ("/task", "/decision", "/question"):
            # Generate a response and speak it
            kind    = self.path.lstrip("/")
            content = body.get(kind, "") or body.get("text", "")
            conf    = float(body.get("confidence", 0.8))
            if content and conf >= CONFIDENCE_GATE:
                response = generate_response(
                    kind, content, self.__class__.mesh_url, self.__class__.model
                )
                if response:
                    threading.Thread(
                        target=speak,
                        args=(response, conf, self.__class__.voice, self.__class__.cable),
                        daemon=True,
                    ).start()
                    self._send({"ok": True, "response": response})
                else:
                    self._send({"ok": False, "reason": "no response generated"})
            else:
                self._send({"ok": False, "reason": "below threshold or empty"})

        else:
            self._send({"error": "not found"}, 404)

    def do_GET(self):
        if self.path == "/health":
            self._send({"status": "ok", "voice": self.__class__.voice})
        else:
            self._send({"error": "not found"}, 404)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Voice agent — TTS for meeting presence")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("speak", help="Speak a piece of text immediately")
    sp.add_argument("--text",       required=True)
    sp.add_argument("--confidence", type=float, default=1.0)
    sp.add_argument("--voice",      default=DEFAULT_VOICE)
    sp.add_argument("--no-cable",   action="store_true", help="Play through speakers, not CABLE")

    srv = sub.add_parser("serve", help="Run HTTP server for voice requests")
    srv.add_argument("--port",      type=int, default=9339)
    srv.add_argument("--voice",     default=DEFAULT_VOICE)
    srv.add_argument("--mesh-url",  default="http://localhost:9337/v1")
    srv.add_argument("--model",     default="qwen3:8b")
    srv.add_argument("--no-cable",  action="store_true")

    sub.add_parser("list-voices", help="List available Edge TTS voices")

    args = parser.parse_args()

    if args.cmd == "speak":
        ok = speak(args.text, args.confidence, args.voice, not args.no_cable)
        sys.exit(0 if ok else 1)

    elif args.cmd == "serve":
        _Handler.mesh_url = args.mesh_url
        _Handler.model    = args.model
        _Handler.voice    = args.voice
        _Handler.cable    = not args.no_cable
        server = HTTPServer(("0.0.0.0", args.port), _Handler)
        print(f"Voice agent server on port {args.port}")
        print(f"  Voice    : {args.voice}")
        print(f"  CABLE    : {'yes (VB-CABLE)' if not args.no_cable else 'no (speakers)'}")
        print(f"  POST /speak       {{text, confidence}}")
        print(f"  POST /task        {{task, confidence}}")
        print(f"  POST /decision    {{decision, confidence}}")
        server.serve_forever()

    elif args.cmd == "list-voices":
        async def _list():
            import edge_tts
            voices = await edge_tts.list_voices()
            en = [v for v in voices if v["Locale"].startswith("en-")]
            for v in en:
                print(f"  {v['ShortName']:<35} {v['Gender']}")
        try:
            asyncio.run(_list())
        except ImportError:
            print("ERROR: pip install edge-tts")


if __name__ == "__main__":
    main()
