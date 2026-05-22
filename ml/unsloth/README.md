# SDLC Framework Unsloth Fine-Tuning

QLoRA fine-tuning pipeline for `Qwen3:8B` on the story generation task.
Produces `sdlc-tuned:latest` — the highest-priority local inference model in SDLC Framework.

**Hardware:** NVIDIA GPU ≥8 GB VRAM, CUDA 12.6  
**Time:** ~16 minutes per training run on RTX 3500 Ada (12 GB)  
**Cost:** Zero cloud spend — fully local

---

## Quick Start

```powershell
# 1. Set up Python environment (one-time)
.\setup-env.ps1
# Creates .venv, installs PyTorch CUDA + Unsloth, sets HF_HOME=C:\ml\hf_cache

# 2. Activate
.\.venv\Scripts\Activate.ps1

# 3. Train
python train.py
# Output: output\lora-adapter\ (177 MB LoRA adapter)

# 4. Export to GGUF for Ollama
python export_gguf.py
# Downloads ~16 GB base model once to HF_HOME, then converts → output\gguf\*.gguf

# 5. Register with Ollama
ollama create sdlc-tuned -f Modelfile.tuned

# 6. Restart the SDLC Framework server — it will auto-select sdlc-tuned:latest
```

---

## Files

| File | Purpose |
|------|---------|
| `train.py` | QLoRA training pipeline — loads model, trains, saves LoRA adapter |
| `export_gguf.py` | Standalone GGUF export — merges LoRA into base model, converts to GGUF |
| `benchmark.py` | Compare base `qwen3:8b` vs `sdlc-tuned` on 6 story prompts |
| `verify_setup.py` | Validate environment before training |
| `check_cuda.py` | Confirm GPU/CUDA is available |
| `setup-env.ps1` | One-time environment setup |
| `requirements.txt` | Runtime dependencies |
| `requirements-test.txt` | Test dependencies (pytest, pytest-mock) |
| `data/train.jsonl` | Training examples (ShareGPT format) |
| `REPORT.md` | Full training metrics, VRAM analysis, benchmark results |

---

## Training Data Format

Examples in `data/train.jsonl` follow ShareGPT format:

```jsonl
{"conversations": [
  {"role": "system",    "content": "You are a product owner AI that generates Agility story fields as HTML. Return a SINGLE JSON object with keys: description, acceptanceCriteria, frontend, backend, qa. JSON ONLY."},
  {"role": "user",      "content": "Story: Add pagination to the backlog list\nContext files: src/components/BacklogList.tsx, src/hooks/usePagination.ts"},
  {"role": "assistant", "content": "{\"description\": \"...\", \"acceptanceCriteria\": \"...\", ...}"}
]}
```

Add examples to improve quality. Target 100–200 for good generalization.

---

## HuggingFace Cache

The GGUF export needs the full unquantized base model (~16 GB). `setup-env.ps1` sets `HF_HOME=C:\ml\hf_cache` as a persistent user environment variable so the download is cached across reboots.

To override:

```powershell
$env:HF_HOME = "D:\your\preferred\path"
python export_gguf.py
```

The partial download from a previous failed run is reused automatically (the script checks `output/gguf/.cache` first).

---

## Tests

```powershell
python -m pytest tests/ -v    # 15 unit tests, no GPU required
```

Tests cover: Windows env var setup, path configuration, merge→GGUF two-phase flow, fallback behavior when GGUF conversion fails.

---

## Results (RTX 3500 Ada, 12 GB VRAM)

| Metric | Value |
|--------|-------|
| Training time | 15.6 min |
| Peak VRAM | 6.99 GB (58%) |
| Final loss | 0.73 |
| Adapter size | 177.5 MB |
| Trainable params | 43.6M / 4.76B (0.92%) |

See `REPORT.md` for the full loss curve and deployment recommendations.
