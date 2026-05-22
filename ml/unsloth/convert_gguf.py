"""
Convert already-merged model to GGUF. Run this when export_gguf.py completed
the merge but failed at the llama.cpp install step (Windows numpy lock issue).

Loads from output/merged/ — no re-download needed.
"""

import os
import sys
import tempfile
from pathlib import Path

_hf_cache = os.path.join(tempfile.gettempdir(), "hf")
os.environ.setdefault("HF_HOME", _hf_cache)
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["DISABLE_TELEMETRY"] = "YES"
os.environ["PYTHONIOENCODING"] = "utf-8"

import json
from unsloth import FastLanguageModel

MERGED_DIR = Path(__file__).parent / "output" / "merged"
GGUF_DIR   = Path(__file__).parent / "output" / "gguf"
MAX_SEQ_LENGTH = 2048
QUANTIZATION   = "q4_k_m"


def main():
    print("=" * 60)
    print("SDLC Framework GGUF Conversion (from merged model)")
    print("=" * 60)

    if not MERGED_DIR.exists():
        print(f"ERROR: merged model not found at {MERGED_DIR}")
        print("Run export_gguf.py first to produce the merged model.")
        sys.exit(1)

    print(f"Source : {MERGED_DIR}")
    print(f"Output : {GGUF_DIR}")
    print()

    print("[1/2] Loading merged model...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=str(MERGED_DIR),
        max_seq_length=MAX_SEQ_LENGTH,
        dtype=None,
        load_in_4bit=False,
    )
    print("   Loaded.")

    GGUF_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[2/2] Converting to GGUF ({QUANTIZATION})...")
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
            print("   No .gguf produced.")
            result = {"gguf_export": "no_output"}
    except Exception as e:
        print(f"   Failed: {e}")
        result = {"gguf_export": f"failed: {str(e)[:200]}"}

    out = Path(__file__).parent / "output" / "convert_metrics.json"
    out.write_text(json.dumps(result, indent=2))
    print(f"\nMetrics: {out}")
    print("=" * 60)
    print("DONE")


if __name__ == "__main__":
    main()
