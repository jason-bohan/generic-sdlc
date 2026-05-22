#!/usr/bin/env python3
"""
Meitheal auto-finetune pipeline.

Steps:
  1. Collect training data from git commits  (collect-training-data.py git)
  2. Prepare Unsloth dataset                 (prepare-unsloth-data.py)
  3. Run Unsloth fine-tuning                 (if unsloth available + GPU)
  4. Rebuild Ollama model                    (ollama create meitheal-tuned:latest)

Run manually:  python scripts/finetune-trigger.py [--root /repo/root]
"""

import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def run(cmd: list[str], cwd: str, label: str) -> bool:
    print(f"\n{'='*60}")
    print(f"[finetune] {label}")
    print(f"[finetune] $ {' '.join(cmd)}")
    print(f"{'='*60}")
    result = subprocess.run(cmd, cwd=cwd, text=True)
    ok = result.returncode == 0
    print(f"[finetune] {'✓' if ok else '✗'} {label} exited {result.returncode}")
    return ok


def step_collect(root: str) -> bool:
    script = os.path.join(root, "scripts", "collect-training-data.py")
    return run([sys.executable, script, "git"], cwd=root, label="Collect training data (git commits)")


def step_prepare(root: str) -> bool:
    script = os.path.join(root, "scripts", "prepare-unsloth-data.py")
    dataset = os.path.join(root, "aider_dataset.jsonl")
    out_dir = os.path.join(root, "ml", "unsloth", "data")
    os.makedirs(out_dir, exist_ok=True)
    return run(
        [sys.executable, script, "--input", dataset, "--output", os.path.join(out_dir, "train.jsonl")],
        cwd=root,
        label="Prepare Unsloth dataset",
    )


def step_finetune(root: str) -> bool:
    try:
        import unsloth  # type: ignore  # noqa: F401
    except ImportError:
        print("[finetune] unsloth not installed — skipping training (dataset is ready in ml/unsloth/data/)")
        print("[finetune] To train: pip install unsloth && python scripts/finetune-trigger.py --root .")
        return True  # not a failure — data is prepared

    train_script = os.path.join(root, "ml", "unsloth", "train.py")
    if not os.path.exists(train_script):
        print(f"[finetune] {train_script} not found — skipping training")
        print("[finetune] Dataset is ready in ml/unsloth/data/train.jsonl")
        return True

    return run([sys.executable, train_script], cwd=root, label="Unsloth fine-tune")


def step_rebuild_ollama(root: str) -> bool:
    modelfile = os.path.join(root, "Modelfile")
    if not os.path.exists(modelfile):
        print("[finetune] Modelfile not found — skipping ollama rebuild")
        return True

    # Try direct ollama CLI first (native mode)
    if _cmd_exists("ollama"):
        return run(["ollama", "create", "meitheal-tuned:latest", "-f", modelfile], cwd=root, label="Rebuild ollama model (native)")

    # Docker: exec into the ollama container
    # Modelfile is at /app/Modelfile since source is bind-mounted
    container = os.environ.get("OLLAMA_CONTAINER", "")
    if not container:
        # Try to find it by image name pattern
        result = subprocess.run(
            ["docker", "ps", "--filter", "ancestor=ollama/ollama", "--format", "{{.Names}}"],
            capture_output=True, text=True,
        )
        names = [n.strip() for n in result.stdout.splitlines() if n.strip()]
        if names:
            container = names[0]

    if container:
        return run(
            ["docker", "exec", container, "ollama", "create", "meitheal-tuned:latest", "-f", "/app/Modelfile"],
            cwd=root,
            label=f"Rebuild ollama model (docker exec {container})",
        )

    print("[finetune] ollama CLI not found and no running ollama container detected — skipping rebuild")
    return True


def _cmd_exists(cmd: str) -> bool:
    import shutil
    return shutil.which(cmd) is not None


def main() -> int:
    parser = argparse.ArgumentParser(description="Meitheal auto-finetune pipeline")
    parser.add_argument("--root", default=os.getcwd(), help="Repo root directory")
    parser.add_argument("--skip-collect", action="store_true", help="Skip data collection step")
    parser.add_argument("--skip-prepare", action="store_true", help="Skip dataset preparation step")
    parser.add_argument("--skip-train", action="store_true", help="Skip Unsloth training step")
    parser.add_argument("--skip-ollama", action="store_true", help="Skip ollama model rebuild")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    print(f"[finetune] Starting pipeline at {datetime.utcnow().isoformat()}Z")
    print(f"[finetune] Root: {root}")

    failed = []

    if not args.skip_collect:
        if not step_collect(root):
            failed.append("collect")

    if not args.skip_prepare:
        if not step_prepare(root):
            failed.append("prepare")
            print("[finetune] Dataset preparation failed — aborting training")
            args.skip_train = True

    if not args.skip_train:
        if not step_finetune(root):
            failed.append("finetune")
            print("[finetune] Training failed — skipping ollama rebuild")
            args.skip_ollama = True

    if not args.skip_ollama:
        if not step_rebuild_ollama(root):
            failed.append("ollama")

    print(f"\n[finetune] Pipeline complete at {datetime.utcnow().isoformat()}Z")
    if failed:
        print(f"[finetune] Failed steps: {', '.join(failed)}")
        return 1

    print("[finetune] All steps succeeded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
