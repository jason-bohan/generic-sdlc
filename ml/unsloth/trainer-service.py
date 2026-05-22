"""
trainer-service.py  —  SDLC Framework continuous training loop.

Watches the aider_dataset.jsonl for new examples. When enough have
accumulated (MIN_NEW_EXAMPLES), runs the full pipeline:

  collect (git) → prepare SFT + DPO data → SFT → DPO → export GGUF → ollama create

Run from the repo root in the ml/unsloth venv:

    cd C:/repos/SDLC Framework
    .venv\\Scripts\\activate   (or ml\\unsloth\\.venv\\Scripts\\activate)
    python ml/unsloth/trainer-service.py [--once] [--force]

Flags:
  --once   Run pipeline once and exit (no scheduling loop)
  --force  Skip the MIN_NEW_EXAMPLES threshold check
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from datetime import datetime

# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────
HERE       = Path(__file__).parent
REPO_ROOT  = HERE.parent.parent
SCRIPTS    = REPO_ROOT / "scripts"
ML_DIR     = HERE

DATASET_FILE   = REPO_ROOT / "aider_dataset.jsonl"
STATE_FILE     = ML_DIR / "output" / "trainer-state.json"
LOG_FILE       = ML_DIR / "output" / "trainer.log"
MODELFILE_TMPL = ML_DIR / "Modelfile.template"
MODELFILE_OUT  = ML_DIR / "Modelfile"

OLLAMA_MODEL_NAME = "sdlc-framework-tuned"
MIN_NEW_EXAMPLES  = 50    # retrain when this many new examples accumulate
CHECK_INTERVAL_S  = 1800  # how often to check (30 min)
SKIP_DPO          = False  # set True to skip DPO step (faster, less stable)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def count_jsonl(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        return sum(1 for l in path.read_text(encoding="utf-8", errors="replace").splitlines() if l.strip())
    except Exception:
        return 0


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"trained_on_count": 0, "last_run": None, "runs": 0, "last_model": None}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def run_step(name: str, cmd: list[str], cwd: Path = REPO_ROOT) -> bool:
    log.info(f"[{name}] running: {' '.join(str(c) for c in cmd)}")
    t0 = time.time()
    result = subprocess.run(cmd, cwd=str(cwd), text=True, encoding="utf-8", errors="replace")
    elapsed = time.time() - t0
    if result.returncode == 0:
        log.info(f"[{name}] done in {elapsed:.1f}s")
        return True
    log.error(f"[{name}] FAILED (exit {result.returncode}) after {elapsed:.1f}s")
    return False


def find_gguf() -> Path | None:
    gguf_dir = ML_DIR / "output" / "gguf"
    if not gguf_dir.exists():
        return None
    gguf_files = sorted(gguf_dir.glob("*.gguf"), key=lambda p: p.stat().st_size, reverse=True)
    return gguf_files[0] if gguf_files else None


def write_modelfile(gguf_path: Path) -> bool:
    if not MODELFILE_TMPL.exists():
        log.error(f"Modelfile template not found: {MODELFILE_TMPL}")
        return False
    tmpl = MODELFILE_TMPL.read_text(encoding="utf-8")
    filled = tmpl.replace("{GGUF_PATH}", str(gguf_path).replace("\\", "/"))
    MODELFILE_OUT.write_text(filled, encoding="utf-8")
    log.info(f"Modelfile written → {MODELFILE_OUT}")
    return True


def python() -> str:
    """Python executable — prefers the ml/unsloth venv if it exists."""
    venv_py = ML_DIR / ".venv" / "Scripts" / "python.exe"
    if venv_py.exists():
        return str(venv_py)
    return sys.executable


# ──────────────────────────────────────────────────────────────────────────────
# Pipeline steps
# ──────────────────────────────────────────────────────────────────────────────

def step_collect() -> bool:
    return run_step(
        "collect",
        [python(), str(SCRIPTS / "collect-training-data.py"), "git"],
    )


def step_prepare_sft() -> bool:
    return run_step(
        "prepare-sft",
        [python(), str(SCRIPTS / "prepare-unsloth-data.py")],
    )


def step_prepare_dpo() -> bool:
    return run_step(
        "prepare-dpo",
        [python(), str(SCRIPTS / "prepare-dpo-dataset.py")],
    )


def step_train_sft() -> bool:
    return run_step("train-sft", [python(), "train.py"], cwd=ML_DIR)


def step_train_dpo() -> bool:
    return run_step("train-dpo", [python(), "train-dpo.py"], cwd=ML_DIR)


def step_export() -> bool:
    return run_step("export-gguf", [python(), "export_gguf.py"], cwd=ML_DIR)


def step_deploy() -> bool:
    gguf = find_gguf()
    if not gguf:
        log.error("No GGUF file found — skipping deploy")
        return False

    if not write_modelfile(gguf):
        return False

    ok = run_step(
        "ollama-create",
        ["ollama", "create", OLLAMA_MODEL_NAME, "-f", str(MODELFILE_OUT)],
    )
    if ok:
        log.info(f"Model deployed: ollama run {OLLAMA_MODEL_NAME}")
    return ok


# ──────────────────────────────────────────────────────────────────────────────
# Full pipeline
# ──────────────────────────────────────────────────────────────────────────────

def run_pipeline() -> bool:
    log.info("=" * 60)
    log.info("Starting training pipeline")
    t0 = time.time()

    steps = [
        ("collect",      step_collect),
        ("prepare-sft",  step_prepare_sft),
        ("train-sft",    step_train_sft),
    ]
    if not SKIP_DPO:
        steps += [
            ("prepare-dpo", step_prepare_dpo),
            ("train-dpo",   step_train_dpo),
        ]
    steps += [
        ("export",  step_export),
        ("deploy",  step_deploy),
    ]

    failed_at = None
    for name, fn in steps:
        if not fn():
            failed_at = name
            break

    elapsed = time.time() - t0
    if failed_at:
        log.error(f"Pipeline FAILED at '{failed_at}' after {elapsed:.1f}s")
        return False

    log.info(f"Pipeline COMPLETE in {elapsed:.1f}s")
    return True


# ──────────────────────────────────────────────────────────────────────────────
# Scheduler loop
# ──────────────────────────────────────────────────────────────────────────────

def should_run(state: dict, force: bool) -> bool:
    if force:
        return True
    current = count_jsonl(DATASET_FILE)
    new = current - state.get("trained_on_count", 0)
    if new >= MIN_NEW_EXAMPLES:
        log.info(f"Threshold met: {new} new examples (need {MIN_NEW_EXAMPLES})")
        return True
    log.info(f"Not enough new examples yet: {new}/{MIN_NEW_EXAMPLES} — sleeping")
    return False


def main():
    parser = argparse.ArgumentParser(description="SDLC Framework continuous trainer service")
    parser.add_argument("--once",  action="store_true", help="Run pipeline once and exit")
    parser.add_argument("--force", action="store_true", help="Skip threshold check and run now")
    args = parser.parse_args()

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    log.info("SDLC Framework trainer service starting")
    log.info(f"Dataset : {DATASET_FILE}")
    log.info(f"GGUF dir: {ML_DIR / 'output' / 'gguf'}")
    log.info(f"Ollama  : {OLLAMA_MODEL_NAME}")
    log.info(f"Skip DPO: {SKIP_DPO}")
    log.info(f"Threshold: {MIN_NEW_EXAMPLES} new examples")

    if args.once:
        state = load_state()
        if should_run(state, args.force):
            success = run_pipeline()
            if success:
                state["trained_on_count"] = count_jsonl(DATASET_FILE)
                state["last_run"] = datetime.utcnow().isoformat()
                state["runs"] = state.get("runs", 0) + 1
                state["last_model"] = OLLAMA_MODEL_NAME
                save_state(state)
        return

    log.info(f"Scheduler loop — checking every {CHECK_INTERVAL_S}s")
    while True:
        try:
            state = load_state()
            if should_run(state, False):
                success = run_pipeline()
                if success:
                    state["trained_on_count"] = count_jsonl(DATASET_FILE)
                    state["last_run"] = datetime.utcnow().isoformat()
                    state["runs"] = state.get("runs", 0) + 1
                    state["last_model"] = OLLAMA_MODEL_NAME
                    save_state(state)
        except Exception as e:
            log.exception(f"Unexpected error in scheduler: {e}")

        time.sleep(CHECK_INTERVAL_S)


if __name__ == "__main__":
    main()
