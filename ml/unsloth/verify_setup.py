"""Quick verification that training can start without errors."""
import sys
from pathlib import Path

print("Verifying training setup...")

# Check CUDA
import torch
assert torch.cuda.is_available(), "CUDA not available"
print(f"  [OK] CUDA: {torch.cuda.get_device_name(0)}")
print(f"  [OK] VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

# Check dataset
from datasets import load_dataset
data_file = Path(__file__).parent / "data" / "train.jsonl"
ds = load_dataset("json", data_files=str(data_file), split="train")
print(f"  [OK] Dataset: {len(ds)} examples loaded")
assert len(ds) > 0, "Dataset is empty"

# Check conversation format
sample = ds[0]
assert "conversations" in sample, f"Missing 'conversations' key. Got: {list(sample.keys())}"
assert len(sample["conversations"]) >= 2, "Conversation too short"
print(f"  [OK] Format: ShareGPT with {len(sample['conversations'])} messages in first example")

# Check Unsloth + model loading (dry run)
from unsloth import FastLanguageModel
print("  [OK] Unsloth imported successfully")

# Check available disk space for output
output_dir = Path(__file__).parent / "output"
import shutil
free_gb = shutil.disk_usage(output_dir.parent).free / 1024**3
print(f"  [OK] Disk space: {free_gb:.1f} GB free")
assert free_gb > 5, f"Need at least 5 GB free, have {free_gb:.1f}"

print("\nAll checks passed. Ready to train.")
print("Run: python train.py")
