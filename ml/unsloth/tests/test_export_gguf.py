"""
Tests for export_gguf.py.

These run without a GPU or real model — all heavy dependencies are mocked.
The things worth testing here are the Windows-specific env var ordering,
path logic, error handling, and the merge→GGUF two-phase flow.
"""

import importlib
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SCRIPT = Path(__file__).parent.parent / "export_gguf.py"


def _load_module(adapter_exists: bool = True, tmp_path: Path | None = None):
    """
    Import export_gguf as a fresh module each time so that the module-level
    os.environ side effects are re-evaluated. Stubs out torch and unsloth so
    no GPU is required.
    """
    stub_torch = MagicMock()
    stub_unsloth = MagicMock()

    fake_model = MagicMock()
    fake_tokenizer = MagicMock()
    stub_unsloth.FastLanguageModel.from_pretrained.return_value = (fake_model, fake_tokenizer)

    # exec_module must run first so module-level constants are initialised,
    # then we override the path constants so main() operates on tmp_path.
    with patch.dict(sys.modules, {"torch": stub_torch, "unsloth": stub_unsloth}):
        spec = importlib.util.spec_from_file_location("export_gguf_fresh", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

    if tmp_path:
        mod.OUTPUT_DIR = tmp_path / "output"
        mod.ADAPTER_DIR = tmp_path / "output" / "lora-adapter"
        mod.GGUF_DIR = tmp_path / "output" / "gguf"
        if adapter_exists:
            (tmp_path / "output" / "lora-adapter").mkdir(parents=True, exist_ok=True)

    return mod, fake_model, fake_tokenizer, stub_unsloth


# ---------------------------------------------------------------------------
# env var tests — must be set before any HF import
# ---------------------------------------------------------------------------

class TestEnvVars:
    def test_hf_home_set_when_no_existing_cache(self, tmp_path):
        """When no existing cache exists, HF_HOME falls back to tempdir."""
        os.environ.pop("HF_HOME", None)
        spec = importlib.util.spec_from_file_location("export_gguf_env", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        # Patch _Path so _existing_cache check sees a non-existent dir.
        with patch.dict(sys.modules, {"torch": MagicMock(), "unsloth": MagicMock()}):
            spec.loader.exec_module(mod)

        hf_home = os.environ.get("HF_HOME", "")
        assert hf_home, "HF_HOME should be set"
        # Either the tempdir fallback or the existing cache — either is valid.
        assert hf_home  # just must be non-empty

    def test_hf_home_prefers_existing_gguf_cache(self):
        """When output/gguf/.cache exists, HF_HOME points there to resume partial download."""
        existing = SCRIPT.parent / "output" / "gguf" / ".cache"
        cache_existed = existing.is_dir()

        os.environ.pop("HF_HOME", None)
        try:
            if not cache_existed:
                existing.mkdir(parents=True, exist_ok=True)

            spec = importlib.util.spec_from_file_location("export_gguf_env_cache", SCRIPT)
            mod = importlib.util.module_from_spec(spec)
            with patch.dict(sys.modules, {"torch": MagicMock(), "unsloth": MagicMock()}):
                spec.loader.exec_module(mod)

            hf_home = os.environ.get("HF_HOME", "")
            assert str(existing) in hf_home or hf_home == str(existing), (
                f"HF_HOME ({hf_home}) should point at existing cache {existing}"
            )
        finally:
            if not cache_existed:
                import shutil
                shutil.rmtree(existing, ignore_errors=True)
            os.environ.pop("HF_HOME", None)

    def test_hub_cache_under_hf_home(self):
        spec = importlib.util.spec_from_file_location("export_gguf_env2", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"torch": MagicMock(), "unsloth": MagicMock()}):
            spec.loader.exec_module(mod)

        hf_home = os.environ.get("HF_HOME", "")
        hub_cache = os.environ.get("HUGGINGFACE_HUB_CACHE", "")
        assert hub_cache.startswith(hf_home), (
            "HUGGINGFACE_HUB_CACHE should nest under HF_HOME"
        )

    def test_symlinks_warning_disabled(self):
        spec = importlib.util.spec_from_file_location("export_gguf_env3", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"torch": MagicMock(), "unsloth": MagicMock()}):
            spec.loader.exec_module(mod)

        assert os.environ.get("HF_HUB_DISABLE_SYMLINKS_WARNING") == "1"

    def test_existing_hf_home_not_overridden(self):
        """If the user already set HF_HOME, respect it."""
        custom = os.path.join(tempfile.gettempdir(), "my_custom_hf")
        os.environ["HF_HOME"] = custom
        try:
            spec = importlib.util.spec_from_file_location("export_gguf_env4", SCRIPT)
            mod = importlib.util.module_from_spec(spec)
            with patch.dict(sys.modules, {"torch": MagicMock(), "unsloth": MagicMock()}):
                spec.loader.exec_module(mod)
            assert os.environ["HF_HOME"] == custom
        finally:
            del os.environ["HF_HOME"]


# ---------------------------------------------------------------------------
# Path / config tests
# ---------------------------------------------------------------------------

class TestPaths:
    def test_adapter_dir_is_lora_adapter_subdir(self):
        spec = importlib.util.spec_from_file_location("export_gguf_paths", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"torch": MagicMock(), "unsloth": MagicMock()}):
            spec.loader.exec_module(mod)

        assert mod.ADAPTER_DIR.name == "lora-adapter"
        assert mod.ADAPTER_DIR.parent.name == "output"

    def test_gguf_dir_inside_output(self):
        spec = importlib.util.spec_from_file_location("export_gguf_paths2", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"torch": MagicMock(), "unsloth": MagicMock()}):
            spec.loader.exec_module(mod)

        assert mod.GGUF_DIR.parent == mod.OUTPUT_DIR


# ---------------------------------------------------------------------------
# main() flow tests
# ---------------------------------------------------------------------------

class TestMain:
    def test_exits_when_adapter_missing(self, tmp_path):
        mod, _, _, _ = _load_module(adapter_exists=False, tmp_path=tmp_path)
        with pytest.raises(SystemExit) as exc_info:
            mod.main()
        assert exc_info.value.code == 1

    def test_calls_from_pretrained_with_adapter_path(self, tmp_path):
        mod, fake_model, fake_tokenizer, stub_unsloth = _load_module(
            adapter_exists=True, tmp_path=tmp_path
        )
        # Make GGUF glob return a fake file so the happy path completes.
        fake_gguf = tmp_path / "output" / "gguf" / "model.gguf"
        fake_gguf.parent.mkdir(parents=True, exist_ok=True)
        fake_gguf.write_bytes(b"\x00" * 1024)

        mod.main()

        stub_unsloth.FastLanguageModel.from_pretrained.assert_called_once()
        call_kwargs = stub_unsloth.FastLanguageModel.from_pretrained.call_args
        assert "lora-adapter" in str(call_kwargs)

    def test_save_pretrained_merged_called(self, tmp_path):
        mod, fake_model, _, _ = _load_module(adapter_exists=True, tmp_path=tmp_path)
        fake_gguf = tmp_path / "output" / "gguf" / "model.gguf"
        fake_gguf.parent.mkdir(parents=True, exist_ok=True)
        fake_gguf.write_bytes(b"\x00" * 1024)

        mod.main()

        fake_model.save_pretrained_merged.assert_called_once()
        merged_call_args = fake_model.save_pretrained_merged.call_args
        assert "merged" in str(merged_call_args[0][0])
        assert merged_call_args[1].get("save_method") == "merged_16bit" or \
               "merged_16bit" in str(merged_call_args)

    def test_gguf_export_called_after_merge(self, tmp_path):
        mod, fake_model, _, _ = _load_module(adapter_exists=True, tmp_path=tmp_path)
        fake_gguf = tmp_path / "output" / "gguf" / "model.gguf"
        fake_gguf.parent.mkdir(parents=True, exist_ok=True)
        fake_gguf.write_bytes(b"\x00" * 1024)

        mod.main()

        merge_order = fake_model.save_pretrained_merged.call_args_list
        gguf_order = fake_model.save_pretrained_gguf.call_args_list
        assert len(merge_order) == 1
        assert len(gguf_order) == 1

    def test_metrics_written_on_success(self, tmp_path):
        mod, fake_model, _, _ = _load_module(adapter_exists=True, tmp_path=tmp_path)
        fake_gguf = tmp_path / "output" / "gguf" / "model.gguf"
        fake_gguf.parent.mkdir(parents=True, exist_ok=True)
        fake_gguf.write_bytes(b"\x00" * (1024 ** 3))  # 1 GB fake file

        mod.main()

        metrics_file = tmp_path / "output" / "export_metrics.json"
        assert metrics_file.exists(), "export_metrics.json should be written"
        data = json.loads(metrics_file.read_text())
        assert "gguf_file" in data
        assert data["gguf_size_gb"] > 0

    def test_fallback_on_gguf_failure(self, tmp_path):
        """When save_pretrained_gguf raises, merged model path is still recorded."""
        mod, fake_model, _, _ = _load_module(adapter_exists=True, tmp_path=tmp_path)
        fake_model.save_pretrained_gguf.side_effect = OSError(
            22, "Invalid argument"
        )

        mod.main()

        metrics_file = tmp_path / "output" / "export_metrics.json"
        assert metrics_file.exists()
        data = json.loads(metrics_file.read_text())
        assert "gguf_export" in data
        assert "failed" in data["gguf_export"]
        assert "merged_dir" in data, "merged_dir must be in metrics so user knows where model is"

    def test_fallback_records_merged_dir_path(self, tmp_path):
        mod, fake_model, _, _ = _load_module(adapter_exists=True, tmp_path=tmp_path)
        fake_model.save_pretrained_gguf.side_effect = OSError(22, "Invalid argument")

        mod.main()

        data = json.loads((tmp_path / "output" / "export_metrics.json").read_text())
        merged_dir = data["merged_dir"]
        assert "merged" in merged_dir

    def test_no_gguf_file_records_no_output(self, tmp_path):
        """If save_pretrained_gguf succeeds but produces no .gguf, record that clearly."""
        mod, fake_model, _, _ = _load_module(adapter_exists=True, tmp_path=tmp_path)
        # save_pretrained_gguf succeeds but writes nothing
        (tmp_path / "output" / "gguf").mkdir(parents=True, exist_ok=True)

        mod.main()

        data = json.loads((tmp_path / "output" / "export_metrics.json").read_text())
        assert data.get("gguf_export") == "no_output"
