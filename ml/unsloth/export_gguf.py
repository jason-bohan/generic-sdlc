"""
Standalone GGUF export for SDLC Framework fine-tuned Qwen3-8B.

Run this after train.py has produced a LoRA adapter in output/lora-adapter/.

The LoRA merge requires the full unquantized base model (~16 GB one-time download).
To avoid re-downloading shards that already exist, this script prefers the partial
cache left in output/gguf/.cache from the previous failed run, then falls back to
%TEMP%/hf.

Windows fix: HuggingFace's default cache uses symlinks, which require Developer
Mode on Windows. Setting HF_HOME before any HF import avoids [Errno 22].
"""

import os
import sys
import tempfile
from pathlib import Path as _Path

# Load HF_HOME from repo-root .env if present (before any HF import).
_env_file = _Path(__file__).parent.parent.parent / ".env"
if _env_file.is_file():
    for _line in _env_file.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line.startswith("HF_HOME=") and "HF_HOME" not in os.environ:
            os.environ["HF_HOME"] = _line.split("=", 1)[1].strip()

# Priority: user env / .env > existing partial download cache > temp fallback.
# Must be set before any huggingface_hub / transformers / unsloth import.
_existing_cache = _Path(__file__).parent / "output" / "gguf" / ".cache"
if "HF_HOME" not in os.environ:
    if _existing_cache.is_dir():
        _hf_cache = str(_existing_cache)
    else:
        _hf_cache = os.path.join(tempfile.gettempdir(), "hf")
else:
    _hf_cache = os.environ["HF_HOME"]

os.environ.setdefault("HF_HOME", _hf_cache)
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(_hf_cache, "hub"))
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["DISABLE_TELEMETRY"] = "YES"
os.environ["PYTHONIOENCODING"] = "utf-8"

import json
import time
from pathlib import Path

import torch
from unsloth import FastLanguageModel

OUTPUT_DIR = Path(__file__).parent / "output"
GGUF_DIR = OUTPUT_DIR / "gguf"
MODEL_NAME = "unsloth/Qwen3-8B-bnb-4bit"
MAX_SEQ_LENGTH = 2048
QUANTIZATION = "q4_k_m"


def _resolve_adapter_dir() -> Path:
    """Return the best available adapter directory.

    Prefers output/lora-adapter/ when it has adapter_config.json (saved by
    save_pretrained_merged). Falls back to the latest trainer checkpoint, which
    always includes the full config.
    """
    primary = OUTPUT_DIR / "lora-adapter"
    if (primary / "adapter_config.json").exists():
        return primary

    checkpoints_dir = OUTPUT_DIR / "checkpoints"
    if checkpoints_dir.is_dir():
        checkpoints = sorted(checkpoints_dir.glob("checkpoint-*"), key=lambda p: int(p.name.split("-")[1]))
        for ckpt in reversed(checkpoints):
            if (ckpt / "adapter_config.json").exists():
                return ckpt

    return primary  # let main() report the missing-dir error


ADAPTER_DIR = _resolve_adapter_dir()


def main():
    print("=" * 60)
    print("SDLC Framework GGUF Export")
    print("=" * 60)
    print(f"Adapter : {ADAPTER_DIR}")
    print(f"Output  : {GGUF_DIR}")
    print(f"HF cache: {os.environ['HF_HOME']}")
    print()

    if not ADAPTER_DIR.exists():
        print(f"ERROR: adapter not found at {ADAPTER_DIR}")
        print("Run train.py first.")
        sys.exit(1)

    print("[1/3] Loading base model + LoRA adapter...")
    t0 = time.time()
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=str(ADAPTER_DIR),
        max_seq_length=MAX_SEQ_LENGTH,
        dtype=None,
        load_in_4bit=True,
    )
    print(f"   Loaded in {time.time() - t0:.1f}s")

    GGUF_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[2/3] Merging LoRA and saving merged model...")
    merged_dir = OUTPUT_DIR / "merged"
    merged_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained_merged(
        str(merged_dir),
        tokenizer,
        save_method="merged_16bit",
    )
    print(f"   Merged model saved to {merged_dir}")

    print(f"[3/3] Converting to GGUF ({QUANTIZATION})...")
    try:
        model.save_pretrained_gguf(
            str(GGUF_DIR),
            tokenizer,
            quantization_method=QUANTIZATION,
        )
        gguf_files = list(GGUF_DIR.glob("*.gguf"))
        if gguf_files:
            size_gb = gguf_files[0].stat().st_size / 1024**3
            print(f"   GGUF: {gguf_files[0].name} ({size_gb:.2f} GB)")
            result = {"gguf_file": gguf_files[0].name, "gguf_size_gb": round(size_gb, 2)}
        else:
            print("   No .gguf produced. Merged model is in output/merged/ — usable via Python.")
            result = {"gguf_export": "no_output", "merged_dir": str(merged_dir)}
    except Exception as e:
        print(f"   GGUF conversion failed: {e}")
        print(f"   Merged model is in output/merged/ — loadable via transformers/unsloth directly.")
        result = {"gguf_export": f"failed: {str(e)[:120]}", "merged_dir": str(merged_dir)}

    metrics_file = OUTPUT_DIR / "export_metrics.json"
    with open(metrics_file, "w") as f:
        json.dump(result, f, indent=2)
    print(f"\nMetrics: {metrics_file}")
    print("=" * 60)
    print("DONE")


if __name__ == "__main__":
    main()
