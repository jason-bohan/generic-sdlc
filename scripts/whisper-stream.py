#!/usr/bin/env python3
"""
whisper-stream.py  —  Real-time voice → task pipeline for meeting agent.

Captures system/mic audio in 3-second chunks, transcribes with faster-whisper,
extracts engineering tasks via the Mesh router, and POSTs them to the meeting
bridge (meeting-bridge.py) for pipeline execution.

Also maintains a rolling transcript context so consecutive sentences are
understood together rather than as isolated utterances.

Setup (Windows):
  pip install faster-whisper sounddevice numpy pygame
  # For virtual mic (capturing Teams audio):
  # Install VB-CABLE from vb-audio.com, set Teams output → CABLE Input

Usage:
  python scripts/whisper-stream.py
  python scripts/whisper-stream.py --model small --bridge http://localhost:9338
  python scripts/whisper-stream.py --device "CABLE Output" --speaker "Agent"
  python scripts/whisper-stream.py --list-devices
"""

import argparse
import json
import queue
import sys
import threading
import time
import urllib.request
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

# Lazy imports — only fail if actually used
def _import_audio():
    try:
        import sounddevice as sd
        import numpy as np
        return sd, np
    except ImportError:
        print("ERROR: pip install sounddevice numpy")
        sys.exit(1)

def _import_whisper():
    try:
        from faster_whisper import WhisperModel
        return WhisperModel
    except ImportError:
        print("ERROR: pip install faster-whisper")
        sys.exit(1)

BRIDGE_URL  = "http://localhost:9338"
MESH_API    = "http://localhost:9337/v1"
MESH_MODEL  = "qwen3:8b"

CHUNK_SECONDS  = 3       # how many seconds of audio per transcription pass
SAMPLE_RATE    = 16000   # whisper expects 16kHz
CHANNELS       = 1
CONTEXT_WINDOW = 10      # utterances kept for LLM context
MIN_TEXT_LEN   = 8       # discard very short transcriptions (noise)
SILENCE_THRESHOLD = 0.01 # RMS below this = probably silence

# ─── Task extraction ──────────────────────────────────────────────────────────

_EXTRACT_PROMPT = """\
You are an engineering assistant monitoring a software team meeting.

Recent conversation:
{context}

New utterance: "{text}"

Does this contain a concrete coding task, bug fix, refactor, or architectural decision?
- Actionable task: return JSON {{"task": "short imperative", "confidence": 0.0-1.0, "cluster": "null_ref|async_await|type_error|refactor|feature|other"}}
- Decision (not a task): return JSON {{"decision": "statement", "confidence": 0.0-1.0}}
- Nothing actionable: return JSON {{"nothing": true}}

Output ONLY valid JSON.
"""


def extract_from_text(text: str, context_lines: list[str]) -> dict | None:
    context = "\n".join(context_lines[-8:]) or "(start of meeting)"
    prompt  = _EXTRACT_PROMPT.format(context=context, text=text)
    payload = json.dumps({
        "model":    MESH_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens":  128,
    }).encode()
    try:
        req = urllib.request.Request(
            f"{MESH_API}/chat/completions",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": "Bearer mesh"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data  = json.loads(resp.read())
            raw   = data["choices"][0]["message"]["content"].strip()
            # Strip markdown fences
            raw = raw.replace("```json", "").replace("```", "").strip()
            return json.loads(raw)
    except Exception as e:
        print(f"  [extract] error: {e}")
        return None


def post_to_bridge(endpoint: str, payload: dict) -> bool:
    try:
        data = json.dumps(payload).encode()
        req  = urllib.request.Request(
            f"{BRIDGE_URL}/{endpoint}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


# ─── Audio pipeline ───────────────────────────────────────────────────────────

class WhisperStream:
    def __init__(self, model_size: str, device: str | None, speaker: str,
                 bridge_url: str, mesh_api: str, mesh_model: str):
        self._bridge_url   = bridge_url
        self._mesh_api     = mesh_api
        self._mesh_model   = mesh_model
        self._speaker      = speaker
        self._device       = device
        self._audio_q: queue.Queue = queue.Queue()
        self._context: deque       = deque(maxlen=CONTEXT_WINDOW)
        self._running      = False
        self._meeting_id   = f"voice_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"

        WhisperModel = _import_whisper()
        print(f"Loading Whisper model '{model_size}'...")
        self._whisper = WhisperModel(model_size, compute_type="int8")
        print("Model loaded.")

    def _audio_callback(self, indata, frames, time_info, status):
        if status:
            print(f"  [audio] {status}", file=sys.stderr)
        self._audio_q.put(indata.copy())

    def _is_silence(self, audio_np) -> bool:
        rms = float((audio_np ** 2).mean() ** 0.5)
        return rms < SILENCE_THRESHOLD

    def _transcribe_loop(self):
        sd, np = _import_audio()
        chunks_per_window = int(CHUNK_SECONDS * SAMPLE_RATE / 512)  # ~512 frames per chunk

        buffer = []
        while self._running:
            try:
                chunk = self._audio_q.get(timeout=0.5)
                buffer.append(chunk)
            except queue.Empty:
                continue

            if len(buffer) < chunks_per_window:
                continue

            audio_np = np.concatenate(buffer, axis=0).flatten().astype("float32")
            buffer   = []

            if self._is_silence(audio_np):
                continue

            segments, _ = self._whisper.transcribe(audio_np, beam_size=1, language="en")
            text = " ".join(seg.text for seg in segments).strip()

            if len(text) < MIN_TEXT_LEN:
                continue

            ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
            print(f"[{ts}] {self._speaker}: {text}")
            self._context.append(f"{self._speaker}: {text}")
            self._handle_utterance(text)

    def _handle_utterance(self, text: str):
        result = extract_from_text(text, list(self._context))
        if not result:
            return

        if "task" in result and result.get("task"):
            confidence = float(result.get("confidence", 0.5))
            task       = result["task"]
            cluster    = result.get("cluster", "other")
            print(f"  -> TASK ({confidence:.0%}): {task}")
            post_to_bridge("task", {
                "task":       task,
                "cluster":    cluster,
                "confidence": confidence,
                "meeting_id": self._meeting_id,
                "speaker":    self._speaker,
                "context":    "\n".join(list(self._context)[-6:]),
            })

        elif "decision" in result and result.get("decision"):
            confidence = float(result.get("confidence", 0.5))
            decision   = result["decision"]
            print(f"  -> DECISION ({confidence:.0%}): {decision}")
            post_to_bridge("decision", {
                "decision":   decision,
                "confidence": confidence,
                "meeting_id": self._meeting_id,
                "speaker":    self._speaker,
            })

    def start(self):
        sd, np = _import_audio()

        # Find device index
        device_idx = None
        if self._device:
            devices = sd.query_devices()
            for i, d in enumerate(devices):
                if self._device.lower() in d["name"].lower():
                    device_idx = i
                    break
            if device_idx is None:
                print(f"WARNING: device '{self._device}' not found — using default")

        self._running = True
        t = threading.Thread(target=self._transcribe_loop, daemon=True)
        t.start()

        print(f"Listening on: {self._device or 'default mic'}  (meeting_id={self._meeting_id})")
        print(f"Bridge: {self._bridge_url}  Mesh: {self._mesh_api}")
        print("Press Ctrl+C to stop.\n")

        try:
            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                callback=self._audio_callback,
                device=device_idx,
                blocksize=512,
            ):
                while True:
                    time.sleep(0.1)
        except KeyboardInterrupt:
            print("\nStopped.")
        finally:
            self._running = False


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Real-time Whisper voice → meeting pipeline")
    parser.add_argument("--model",       default="base",
                        choices=["tiny", "base", "small", "medium"],
                        help="Whisper model size (larger = more accurate, slower)")
    parser.add_argument("--device",      default=None,
                        help="Audio input device name substring (e.g. 'CABLE Output', 'Microphone')")
    parser.add_argument("--speaker",     default="Participant",
                        help="Speaker label to use in transcript context")
    parser.add_argument("--bridge",      default=BRIDGE_URL,
                        help="Meeting bridge URL")
    parser.add_argument("--mesh",        default=MESH_API,
                        help="Mesh API URL")
    parser.add_argument("--mesh-model",  default=MESH_MODEL)
    parser.add_argument("--list-devices", action="store_true",
                        help="List available audio devices and exit")
    args = parser.parse_args()

    if args.list_devices:
        sd, _ = _import_audio()
        print("Available audio devices:")
        for i, d in enumerate(sd.query_devices()):
            marker = "<-- input" if d["max_input_channels"] > 0 else ""
            print(f"  [{i:2d}] {d['name']}  {marker}")
        return

    global BRIDGE_URL, MESH_API, MESH_MODEL
    BRIDGE_URL  = args.bridge
    MESH_API    = args.mesh
    MESH_MODEL  = args.mesh_model

    stream = WhisperStream(
        model_size=args.model,
        device=args.device,
        speaker=args.speaker,
        bridge_url=BRIDGE_URL,
        mesh_api=MESH_API,
        mesh_model=MESH_MODEL,
    )
    stream.start()


if __name__ == "__main__":
    main()
