"""
SDLC Framework Unsloth QLoRA Fine-Tuning Pipeline
Target: Qwen2.5-Coder-14B on Apple Silicon (32GB unified) or CUDA GPU
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
# 14B fits in 32GB unified memory at 4-bit (~9GB weights + LoRA overhead).
# Drop to Qwen3-8B if running on a 12GB GPU (set MODEL_NAME env var).
# ──────────────────────────────────────────────────────────────────────────────
MODEL_NAME = os.environ.get(
    "SDLC_BASE_MODEL",
    "unsloth/Qwen2.5-Coder-14B-Instruct-bnb-4bit",
)
OUTPUT_DIR = Path(__file__).parent / "output"
DATA_FILE = Path(__file__).parent / "data" / "train.jsonl"
MAX_SEQ_LENGTH = 4096   # 14B handles longer context well; use 2048 on 12GB GPU
LORA_R = 32             # higher rank → more capacity; drop to 16 on 12GB GPU
LORA_ALPHA = 32
LORA_DROPOUT = 0.0
TARGET_MODULES = [
    "q_proj", "k_proj", "v_proj", "o_proj",
    "gate_proj", "up_proj", "down_proj",
]

TRAINING_ARGS = dict(
    per_device_train_batch_size=1,   # 14B needs smaller batch; effective=4 via accum
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
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", default=None,
                        choices=["developer", "reviewer", "qa"],
                        help="Agent role — loads train-{role}.jsonl if present")
    args = parser.parse_args()

    # Resolve dataset path: prefer role-specific file
    data_file = DATA_FILE
    if args.role:
        role_file = DATA_FILE.parent / f"train-{args.role}.jsonl"
        if role_file.exists():
            data_file = role_file

    # Hardware info — works on CUDA and MPS (Apple Silicon)
    if torch.cuda.is_available():
        hw_name = torch.cuda.get_device_name(0)
        hw_mem = f"{torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB VRAM"
    elif torch.backends.mps.is_available():
        hw_name = "Apple MPS"
        hw_mem = f"{torch.mps.driver_allocated_memory() / 1024**3:.1f} GB (unified)"
    else:
        hw_name = "CPU"
        hw_mem = "N/A"

    print("=" * 60)
    print("SDLC Framework Unsloth QLoRA Fine-Tuning")
    print("=" * 60)
    print(f"HW:    {hw_name}  {hw_mem}")
    print(f"Model: {MODEL_NAME}")
    print(f"Role:  {args.role or 'all'}")
    print(f"Data:  {data_file}")
    print(f"LoRA rank: {LORA_R}, alpha: {LORA_ALPHA}")
    print(f"Max seq length: {MAX_SEQ_LENGTH}")
    print()

    # Track metrics
    metrics = {
        "model": MODEL_NAME,
        "role": args.role or "all",
        "hw": hw_name,
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
    dataset = load_dataset("json", data_files=str(data_file), split="train")
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
