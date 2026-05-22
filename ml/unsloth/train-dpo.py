"""
train-dpo.py  —  DPO fine-tuning on top of the SFT LoRA adapter.

Run AFTER train.py has produced output/lora-adapter/.
DPO teaches the model what NOT to do (verbose chat, full-file rewrites, bad format)
by contrasting good diffs (chosen) with bad outputs (rejected).

Typical command:
    cd ml/unsloth
    python train-dpo.py

GPU requirement: RTX 3500 Ada (12 GB VRAM) — same as SFT run.
"""

import json
import time
from pathlib import Path

import torch
from datasets import load_dataset
from unsloth import FastLanguageModel
from trl import DPOTrainer, DPOConfig

# ──────────────────────────────────────────────────────────────────────────────
# Paths
# ──────────────────────────────────────────────────────────────────────────────
HERE        = Path(__file__).parent
SFT_ADAPTER = HERE / "output" / "lora-adapter"   # produced by train.py
DPO_DATA    = HERE / "data" / "dpo.jsonl"         # produced by prepare-dpo-dataset.py
OUTPUT_DIR  = HERE / "output" / "dpo-adapter"

# ──────────────────────────────────────────────────────────────────────────────
# Model config (must match train.py)
# ──────────────────────────────────────────────────────────────────────────────
BASE_MODEL_NAME = "unsloth/Qwen3-8B-bnb-4bit"
MAX_SEQ_LENGTH  = 2048
LORA_R          = 16
LORA_ALPHA      = 16
TARGET_MODULES  = [
    "q_proj", "k_proj", "v_proj", "o_proj",
    "gate_proj", "up_proj", "down_proj",
]

# ──────────────────────────────────────────────────────────────────────────────
# DPO training config
# ──────────────────────────────────────────────────────────────────────────────
DPO_BETA      = 0.1     # KL penalty — lower = more aggressive preference learning
MAX_STEPS     = 500     # increase once dataset is 10k+ examples
LEARNING_RATE = 5e-5    # lower than SFT to avoid forgetting
BATCH_SIZE    = 1       # DPO pairs are heavier (2× the SFT forward pass)
GRAD_ACCUM    = 8       # effective batch = 8


def main():
    print("=" * 60)
    print("Meitheal DPO Fine-Tuning")
    print("=" * 60)

    if not SFT_ADAPTER.exists():
        print(f"ERROR: SFT adapter not found at {SFT_ADAPTER}")
        print("Run train.py first to produce the SFT LoRA adapter.")
        return

    if not DPO_DATA.exists():
        print(f"ERROR: DPO dataset not found at {DPO_DATA}")
        print("Run: python scripts/prepare-dpo-dataset.py")
        return

    print(f"GPU     : {torch.cuda.get_device_name(0)}")
    print(f"VRAM    : {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")
    print(f"Adapter : {SFT_ADAPTER}")
    print(f"Data    : {DPO_DATA}")
    print(f"Beta    : {DPO_BETA}")
    print()

    metrics = {
        "gpu": torch.cuda.get_device_name(0),
        "sft_adapter": str(SFT_ADAPTER),
        "dpo_beta": DPO_BETA,
    }

    # ── Load base + SFT adapter ───────────────────────────────────────────────
    print("[1/4] Loading base model + SFT LoRA adapter...")
    t0 = time.time()
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL_NAME,
        max_seq_length=MAX_SEQ_LENGTH,
        dtype=None,
        load_in_4bit=True,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=LORA_R,
        target_modules=TARGET_MODULES,
        lora_alpha=LORA_ALPHA,
        lora_dropout=0.0,
        bias="none",
        use_gradient_checkpointing="unsloth",
    )
    # Merge SFT weights into the base before DPO so DPO trains on top of them
    model.load_adapter(str(SFT_ADAPTER), adapter_name="sft")
    model.set_adapter("sft")
    print(f"   Loaded in {time.time() - t0:.1f}s")

    # ── Load DPO dataset ──────────────────────────────────────────────────────
    print("[2/4] Loading DPO dataset...")
    dataset = load_dataset("json", data_files=str(DPO_DATA), split="train")
    print(f"   {len(dataset)} DPO pairs")
    metrics["num_dpo_pairs"] = len(dataset)

    # ── Train ─────────────────────────────────────────────────────────────────
    print("[3/4] DPO training...")
    t_train = time.time()

    dpo_config = DPOConfig(
        beta=DPO_BETA,
        per_device_train_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRAD_ACCUM,
        warmup_steps=20,
        max_steps=MAX_STEPS,
        learning_rate=LEARNING_RATE,
        bf16=True,
        logging_steps=10,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="cosine",
        output_dir=str(OUTPUT_DIR / "checkpoints"),
        report_to="none",
        max_length=MAX_SEQ_LENGTH,
        max_prompt_length=MAX_SEQ_LENGTH // 2,
        remove_unused_columns=False,
    )

    trainer = DPOTrainer(
        model=model,
        ref_model=None,   # implicit reference via the base weights (saves VRAM)
        args=dpo_config,
        train_dataset=dataset,
        tokenizer=tokenizer,
    )
    result = trainer.train()
    train_time = time.time() - t_train
    vram_peak = torch.cuda.max_memory_allocated() / 1024**3

    print(f"   Training complete in {train_time:.1f}s")
    print(f"   Peak VRAM: {vram_peak:.2f} GB")
    print(f"   Final loss: {result.training_loss:.4f}")
    metrics["train_time_s"]  = round(train_time, 1)
    metrics["vram_peak_gb"]  = round(vram_peak, 2)
    metrics["final_loss"]    = round(result.training_loss, 4)

    # ── Save ──────────────────────────────────────────────────────────────────
    print("[4/4] Saving DPO adapter...")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained_merged(str(OUTPUT_DIR), tokenizer, save_method="lora")
    adapter_mb = sum(f.stat().st_size for f in OUTPUT_DIR.rglob("*") if f.is_file()) / 1024 / 1024
    print(f"   Saved to {OUTPUT_DIR} ({adapter_mb:.1f} MB)")
    metrics["adapter_size_mb"] = round(adapter_mb, 1)

    metrics_file = HERE / "output" / "dpo_metrics.json"
    with open(metrics_file, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"\nMetrics → {metrics_file}")
    print("=" * 60)
    print("DONE — next: run export_gguf.py pointing at output/dpo-adapter/")


if __name__ == "__main__":
    main()
