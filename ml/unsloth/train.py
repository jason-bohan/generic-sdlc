"""
Meitheal Unsloth QLoRA Fine-Tuning Pipeline
Target: Qwen3:8B on RTX 3500 Ada (12GB VRAM)
Training config: 4-bit QLoRA with gradient checkpointing
"""

import json
import time
import os
import sys
from pathlib import Path

import torch
from datasets import load_dataset
from unsloth import FastLanguageModel
from trl import SFTTrainer, SFTConfig

# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────
MODEL_NAME = "unsloth/Qwen3-8B-bnb-4bit"
OUTPUT_DIR = Path(__file__).parent / "output"
DATA_FILE = Path(__file__).parent / "data" / "train.jsonl"
MAX_SEQ_LENGTH = 2048
LORA_R = 16
LORA_ALPHA = 16
LORA_DROPOUT = 0.0
TARGET_MODULES = [
    "q_proj", "k_proj", "v_proj", "o_proj",
    "gate_proj", "up_proj", "down_proj",
]

TRAINING_ARGS = dict(
    per_device_train_batch_size=2,
    gradient_accumulation_steps=4,
    warmup_steps=5,
    max_steps=60,
    learning_rate=2e-4,
    bf16=True,
    logging_steps=5,
    optim="adamw_8bit",
    weight_decay=0.01,
    lr_scheduler_type="linear",
    seed=42,
    output_dir=str(OUTPUT_DIR / "checkpoints"),
    report_to="none",
)


def format_conversation(example):
    """Convert ShareGPT-style conversations to ChatML format for Qwen."""
    messages = example["conversations"]
    formatted = ""
    for msg in messages:
        role = msg["role"]
        content = msg["content"]
        formatted += f"<|im_start|>{role}\n{content}<|im_end|>\n"
    return {"text": formatted}


def main():
    print("=" * 60)
    print("Meitheal Unsloth QLoRA Fine-Tuning")
    print("=" * 60)
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")
    print(f"Model: {MODEL_NAME}")
    print(f"Data: {DATA_FILE}")
    print(f"LoRA rank: {LORA_R}, alpha: {LORA_ALPHA}")
    print(f"Max seq length: {MAX_SEQ_LENGTH}")
    print()

    # Track metrics
    metrics = {
        "model": MODEL_NAME,
        "gpu": torch.cuda.get_device_name(0),
        "vram_total_gb": round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 1),
        "lora_r": LORA_R,
        "lora_alpha": LORA_ALPHA,
        "max_seq_length": MAX_SEQ_LENGTH,
    }

    # ── Load model ────────────────────────────────────────────────────────────
    print("[1/5] Loading model with 4-bit quantization...")
    vram_before = torch.cuda.memory_allocated() / 1024**3
    t0 = time.time()

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=MODEL_NAME,
        max_seq_length=MAX_SEQ_LENGTH,
        dtype=None,
        load_in_4bit=True,
    )
    load_time = time.time() - t0
    vram_after_load = torch.cuda.memory_allocated() / 1024**3
    print(f"   Model loaded in {load_time:.1f}s, VRAM: {vram_after_load:.2f} GB")
    metrics["load_time_s"] = round(load_time, 1)
    metrics["vram_after_load_gb"] = round(vram_after_load, 2)

    # ── Apply LoRA ────────────────────────────────────────────────────────────
    print("[2/5] Applying QLoRA adapters...")
    model = FastLanguageModel.get_peft_model(
        model,
        r=LORA_R,
        target_modules=TARGET_MODULES,
        lora_alpha=LORA_ALPHA,
        lora_dropout=LORA_DROPOUT,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
    )
    vram_after_lora = torch.cuda.memory_allocated() / 1024**3
    print(f"   LoRA applied, VRAM: {vram_after_lora:.2f} GB")
    metrics["vram_after_lora_gb"] = round(vram_after_lora, 2)

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"   Trainable params: {trainable:,} / {total:,} ({100*trainable/total:.2f}%)")
    metrics["trainable_params"] = trainable
    metrics["total_params"] = total

    # ── Load dataset ──────────────────────────────────────────────────────────
    print("[3/5] Loading and formatting dataset...")
    dataset = load_dataset("json", data_files=str(DATA_FILE), split="train")
    dataset = dataset.map(format_conversation, remove_columns=dataset.column_names)
    print(f"   {len(dataset)} training examples loaded")
    metrics["num_examples"] = len(dataset)

    # ── Train ─────────────────────────────────────────────────────────────────
    print("[4/5] Starting training...")
    t_train_start = time.time()

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        args=SFTConfig(
            dataset_text_field="text",
            max_seq_length=MAX_SEQ_LENGTH,
            dataset_num_proc=2,
            packing=False,
            **TRAINING_ARGS,
        ),
    )

    train_result = trainer.train()
    train_time = time.time() - t_train_start
    vram_peak = torch.cuda.max_memory_allocated() / 1024**3
    print(f"   Training complete in {train_time:.1f}s")
    print(f"   Peak VRAM: {vram_peak:.2f} GB")
    print(f"   Final loss: {train_result.training_loss:.4f}")

    metrics["train_time_s"] = round(train_time, 1)
    metrics["vram_peak_gb"] = round(vram_peak, 2)
    metrics["final_loss"] = round(train_result.training_loss, 4)
    metrics["train_steps"] = TRAINING_ARGS["max_steps"]

    # ── Save ──────────────────────────────────────────────────────────────────
    print("[5/5] Saving LoRA adapter...")
    adapter_dir = OUTPUT_DIR / "lora-adapter"
    # save_pretrained_merged with save_method="lora" writes adapter_config.json
    # alongside the weights — plain save_pretrained omits it.
    model.save_pretrained_merged(str(adapter_dir), tokenizer, save_method="lora")

    adapter_size_mb = sum(
        f.stat().st_size for f in adapter_dir.rglob("*") if f.is_file()
    ) / 1024 / 1024
    print(f"   Adapter saved to {adapter_dir} ({adapter_size_mb:.1f} MB)")
    metrics["adapter_size_mb"] = round(adapter_size_mb, 1)

    # ── Export to GGUF for Ollama ─────────────────────────────────────────────
    # Run export_gguf.py separately to avoid re-downloading the base model on
    # every training run. The LoRA adapter is already saved above.
    print("[BONUS] Skipping inline GGUF export — run export_gguf.py to convert.")
    print("        python export_gguf.py")
    metrics["gguf_export"] = "skipped: run export_gguf.py"

    # ── Write metrics ─────────────────────────────────────────────────────────
    metrics_file = OUTPUT_DIR / "train_metrics.json"
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(metrics_file, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"\nMetrics written to {metrics_file}")
    print("=" * 60)
    print("DONE")

    return metrics


if __name__ == "__main__":
    main()
