#!/usr/bin/env python3
"""
SDLC Framework auto-finetune pipeline.

Steps:
  1. Collect training data from git commits  (collect-training-data.py git)
  2. Prepare Unsloth dataset                 (prepare-unsloth-data.py)
  3. Run Unsloth fine-tuning                 (if unsloth available + GPU)
  4. Rebuild Ollama model                    (ollama create SDLC Framework-tuned:latest)

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


AGENT_ROLES = ["developer", "reviewer", "qa"]


def step_prepare(root: str, role: "str | None" = None) -> bool:
    script = os.path.join(root, "scripts", "prepare-unsloth-data.py")
    dataset = os.path.join(root, "aider_dataset.jsonl")
    role_suffix = f"-{role}" if role else ""
    out_dir = os.path.join(root, "ml", "unsloth", "data")
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, f"train{role_suffix}.jsonl")
    cmd = [sys.executable, script, "--input", dataset, "--output", out_file]
    if role:
        cmd += ["--role", role]
    return run(cmd, cwd=root, label=f"Prepare dataset ({role or 'all'})")


def step_finetune(root: str, role: "str | None" = None) -> bool:
    try:
        import unsloth  # type: ignore  # noqa: F401
    except ImportError:
        role_suffix = f"-{role}" if role else ""
        print(f"[finetune] unsloth not installed — dataset ready in ml/unsloth/data/train{role_suffix}.jsonl")
        print("[finetune] To train: pip install unsloth && python scripts/finetune-trigger.py --root .")
        return True

    train_script = os.path.join(root, "ml", "unsloth", "train.py")
    if not os.path.exists(train_script):
        print(f"[finetune] {train_script} not found — skipping training")
        return True

    cmd = [sys.executable, train_script]
    if role:
        cmd += ["--role", role]
    return run(cmd, cwd=root, label=f"Unsloth fine-tune ({role or 'all'})")


def _ollama_create(model_name: str, modelfile_path: str, root: str) -> bool:
    if _cmd_exists("ollama"):
        return run(["ollama", "create", model_name, "-f", modelfile_path],
                   cwd=root, label=f"Register ollama model {model_name} (native)")

    container = os.environ.get("OLLAMA_CONTAINER", "")
    if not container:
        result = subprocess.run(
            ["docker", "ps", "--filter", "ancestor=ollama/ollama", "--format", "{{.Names}}"],
            capture_output=True, text=True,
        )
        names = [n.strip() for n in result.stdout.splitlines() if n.strip()]
        if names:
            container = names[0]

    if container:
        docker_path = modelfile_path.replace(root, "/app")
        return run(
            ["docker", "exec", container, "ollama", "create", model_name, "-f", docker_path],
            cwd=root, label=f"Register ollama model {model_name} (docker exec {container})",
        )

    print("[finetune] ollama CLI not found and no running ollama container — skipping")
    return True


def step_rebuild_ollama(root: str, role: "str | None" = None, workspace_name: str = "sdlc") -> bool:
    template = os.path.join(root, "ml", "unsloth", "Modelfile.template")
    if not os.path.exists(template):
        # Fall back to legacy Modelfile in repo root
        template = os.path.join(root, "Modelfile")
    if not os.path.exists(template):
        print("[finetune] No Modelfile template found — skipping ollama rebuild")
        return True

    gguf_pattern = os.path.join(root, "ml", "unsloth", "output", "*.gguf")
    import glob
    gguf_files = sorted(glob.glob(gguf_pattern))
    gguf_path = gguf_files[-1] if gguf_files else "model.gguf"

    template_text = open(template, encoding="utf-8").read()
    modelfile_content = template_text.replace("{GGUF_PATH}", gguf_path)

    roles_to_build = [role] if role else AGENT_ROLES
    ok = True
    for r in roles_to_build:
        model_name = f"{workspace_name}-{r}:latest"
        mf_path = os.path.join(root, "ml", "unsloth", "output", f"Modelfile.{r}")
        os.makedirs(os.path.dirname(mf_path), exist_ok=True)
        with open(mf_path, "w", encoding="utf-8") as f:
            f.write(modelfile_content)
        if not _ollama_create(model_name, mf_path, root):
            ok = False

    return ok


def _cmd_exists(cmd: str) -> bool:
    import shutil
    return shutil.which(cmd) is not None


def main() -> int:
    parser = argparse.ArgumentParser(description="SDLC Framework auto-finetune pipeline")
    parser.add_argument("--root",           default=os.getcwd(), help="Repo root directory")
    parser.add_argument("--workspace",      default=None,        help="External workspace repo to collect from (e.g. ~/repos/flowboard)")
    parser.add_argument("--workspace-name", default=None,        help="Short name for Ollama model prefix (e.g. flowboard)")
    parser.add_argument("--role",           default=None,        choices=AGENT_ROLES + ["all"],
                        help="Train only a specific agent role (default: all)")
    parser.add_argument("--skip-collect", action="store_true", help="Skip data collection step")
    parser.add_argument("--skip-prepare", action="store_true", help="Skip dataset preparation step")
    parser.add_argument("--skip-train",   action="store_true", help="Skip Unsloth training step")
    parser.add_argument("--skip-ollama",  action="store_true", help="Skip ollama model rebuild")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    workspace_name = args.workspace_name or os.path.basename(root).lower().replace(" ", "-")
    roles = [args.role] if (args.role and args.role != "all") else AGENT_ROLES

    print(f"[finetune] Starting pipeline at {datetime.utcnow().isoformat()}Z")
    print(f"[finetune] Root: {root}  |  Roles: {', '.join(roles)}")

    failed = []

    # ── Collect ──────────────────────────────────────────────────────────────
    if not args.skip_collect:
        collect_root = root
        if args.workspace:
            # Collect from external workspace first, output into framework root
            ws = os.path.expanduser(args.workspace)
            collect_script = os.path.join(root, "scripts", "collect-training-data.py")
            ok = run(
                [sys.executable, collect_script, "--repo", ws, "git"],
                cwd=root,
                label=f"Collect training data from workspace {ws}",
            )
            if not ok:
                failed.append("collect-workspace")
        if not step_collect(collect_root):
            failed.append("collect")

    # ── Per-role: prepare → train → register ─────────────────────────────────
    for role in roles:
        print(f"\n[finetune] ── Role: {role} ──────────────────────────────────")

        if not args.skip_prepare:
            if not step_prepare(root, role):
                failed.append(f"prepare-{role}")
                print(f"[finetune] Dataset prep failed for {role} — skipping train")
                continue

        if not args.skip_train:
            if not step_finetune(root, role):
                failed.append(f"finetune-{role}")
                print(f"[finetune] Training failed for {role} — skipping ollama")
                continue

        if not args.skip_ollama:
            if not step_rebuild_ollama(root, role, workspace_name):
                failed.append(f"ollama-{role}")

    print(f"\n[finetune] Pipeline complete at {datetime.utcnow().isoformat()}Z")
    if failed:
        print(f"[finetune] Failed steps: {', '.join(failed)}")
        return 1

    print(f"[finetune] All steps succeeded — models: " +
          ", ".join(f"{workspace_name}-{r}:latest" for r in roles))
    return 0


if __name__ == "__main__":
    sys.exit(main())
