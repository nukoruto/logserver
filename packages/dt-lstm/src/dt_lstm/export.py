"""Model export and bundle utilities for dt-lstm."""

from __future__ import annotations

import json
import shutil
import subprocess
import tarfile
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, Mapping, Optional

import torch

from .model_def import ModelDefinition, load_definition, save_definition
from .modules import DeltaTimeModel, DeltaTimeModelConfig

DEFAULT_ALGO_VERSION = "1"


class ExportError(RuntimeError):
    """Raised when exporting a bundle fails."""


@dataclass
class BundleContents:
    """Resolved contents of an exported bundle."""

    temp_dir: Path
    state_dict_path: Path
    model_def: ModelDefinition
    train_meta: Mapping[str, object]
    calibration: Mapping[str, object]
    vocab_path: Optional[Path]
    torchscript_path: Optional[Path]
    code_hash: Optional[str]


def _ensure_exists(path: Path, description: str) -> None:
    if not path.exists():
        raise ExportError(f"{description} が見つかりません: {path}")


def _resolve_vocab_path(config: Mapping[str, object], explicit: Optional[Path]) -> Optional[Path]:
    if explicit is not None:
        _ensure_exists(explicit, "vocab.json")
        return explicit
    vocab_entry = config.get("vocab")
    if isinstance(vocab_entry, str):
        candidate = Path(vocab_entry)
        if candidate.exists():
            return candidate
    return None


def _resolve_train_meta(
    vocab_path: Optional[Path],
    explicit_meta: Optional[Path],
    config: Mapping[str, object],
) -> Mapping[str, object]:
    meta_path = explicit_meta
    if meta_path is None and vocab_path is not None:
        candidate = vocab_path.with_name("train_meta.json")
        if candidate.exists():
            meta_path = candidate
    if meta_path is None:
        data_meta = config.get("data")
        if isinstance(data_meta, Mapping):
            return dict(data_meta)
        raise ExportError("train_meta.json を特定できず、config.json から復元できませんでした")
    _ensure_exists(meta_path, "train_meta.json")
    return json.loads(meta_path.read_text(encoding="utf-8"))


def _resolve_calibration(calibration_path: Optional[Path]) -> Mapping[str, object]:
    if calibration_path is None:
        return {"temperature": 1.0, "source": "default"}
    _ensure_exists(calibration_path, "calib.json")
    return json.loads(calibration_path.read_text(encoding="utf-8"))


def _compute_code_hash() -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:  # pragma: no cover - git 未導入環境
        return None
    return result.stdout.strip() or None


def export_bundle(
    *,
    checkpoint_path: Path,
    output_path: Path,
    vocab_path: Optional[Path] = None,
    calibration_path: Optional[Path] = None,
    train_meta_path: Optional[Path] = None,
    algo_version: str = DEFAULT_ALGO_VERSION,
) -> Dict[str, object]:
    """Bundle checkpoint, configuration, and auxiliary assets into a tar archive."""

    checkpoint_path = checkpoint_path.expanduser().resolve()
    _ensure_exists(checkpoint_path, "チェックポイント")
    config_path = checkpoint_path.with_name("config.json")
    _ensure_exists(config_path, "config.json")
    config_data = json.loads(config_path.read_text(encoding="utf-8"))

    resolved_vocab = _resolve_vocab_path(config_data, vocab_path.expanduser().resolve() if vocab_path else None)
    calibration = _resolve_calibration(calibration_path.expanduser().resolve() if calibration_path else None)
    train_meta = _resolve_train_meta(
        resolved_vocab,
        train_meta_path.expanduser().resolve() if train_meta_path else None,
        config_data,
    )

    model_cfg = DeltaTimeModelConfig.from_dict(config_data.get("model", {}))
    model = DeltaTimeModel(model_cfg)
    state_dict = torch.load(checkpoint_path, map_location="cpu")
    try:
        model.load_state_dict(state_dict)
    except Exception as exc:  # pragma: no cover - validation
        raise ExportError(f"state_dict の読み込みに失敗しました: {exc}") from exc
    model.eval()

    metadata: Dict[str, object] = {
        "algo_ver": algo_version,
        "time_objective": config_data.get("time_objective"),
        "seed": config_data.get("seed"),
    }
    data_section = config_data.get("data")
    if isinstance(data_section, Mapping):
        metadata["data"] = dict(data_section)
    validation_section = config_data.get("validation")
    if isinstance(validation_section, Mapping):
        metadata["validation"] = dict(validation_section)
    training_section = config_data.get("training")
    if isinstance(training_section, Mapping):
        metadata["training"] = dict(training_section)
    definition = ModelDefinition(config=model_cfg, metadata={k: v for k, v in metadata.items() if v is not None})

    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        state_out = tmp_path / "state_dict.pt"
        torch.save(model.state_dict(), state_out)
        def_out = tmp_path / "model_def.json"
        save_definition(definition, def_out)

        train_meta_out = tmp_path / "train_meta.json"
        train_meta_out.write_text(json.dumps(train_meta, ensure_ascii=False, indent=2), encoding="utf-8")

        if resolved_vocab is not None:
            shutil.copy2(resolved_vocab, tmp_path / "vocab.json")

        calib_out = tmp_path / "calib.json"
        calib_out.write_text(json.dumps(calibration, ensure_ascii=False, indent=2), encoding="utf-8")

        code_hash = _compute_code_hash() or "unknown"
        (tmp_path / "code_hash.txt").write_text(code_hash + "\n", encoding="utf-8")

        class _WrappedModelNoTimes(torch.nn.Module):
            def __init__(self, base: DeltaTimeModel) -> None:
                super().__init__()
                self.base = base

            def forward(self, events: torch.Tensor, numeric: torch.Tensor, lengths: torch.Tensor):
                return self.base(events, numeric, lengths=lengths)

        class _WrappedModelWithTimes(torch.nn.Module):
            def __init__(self, base: DeltaTimeModel) -> None:
                super().__init__()
                self.base = base

            def forward(self, events: torch.Tensor, numeric: torch.Tensor, times: torch.Tensor, lengths: torch.Tensor):
                return self.base(events, numeric, times=times, lengths=lengths)

        use_times = model_cfg.arch == "phased_lstm"
        if use_times:
            wrapper: torch.nn.Module = _WrappedModelWithTimes(model)
        else:
            wrapper = _WrappedModelNoTimes(model)
        example_len = 3
        example_events = torch.zeros(1, example_len, dtype=torch.long)
        example_numeric = torch.zeros(1, example_len, model_cfg.numeric_dim, dtype=torch.float32)
        example_lengths = torch.tensor([example_len], dtype=torch.long)
        example_times = torch.zeros(1, example_len, dtype=torch.float32) if use_times else None
        try:
            if use_times:
                assert example_times is not None
                scripted = torch.jit.trace(
                    wrapper,
                    (example_events, example_numeric, example_times, example_lengths),
                    check_trace=False,
                    strict=False,
                )
            else:
                scripted = torch.jit.trace(
                    wrapper,
                    (example_events, example_numeric, example_lengths),
                    check_trace=False,
                    strict=False,
                )
        except Exception as exc:  # pragma: no cover - TorchScript 失敗
            raise ExportError(f"TorchScript 変換に失敗しました: {exc}") from exc
        torchscript_path = tmp_path / "model.ts"
        torch.jit.save(scripted, torchscript_path)

        with tarfile.open(output_path, "w") as archive:
            for file in tmp_path.iterdir():
                archive.add(file, arcname=file.name)

    payload = {
        "event": "export.completed",
        "out_path": str(output_path),
        "algo_ver": algo_version,
        "has_vocab": resolved_vocab is not None,
        "has_calibration": calibration_path is not None,
    }
    return payload


def _is_within(path: Path, base: Path) -> bool:
    try:
        path.relative_to(base)
    except ValueError:
        return False
    return True


def _safe_extract_all(archive: tarfile.TarFile, destination: Path) -> None:
    dest = destination.resolve()
    for member in archive.getmembers():
        member_path = dest / member.name
        resolved_member_path = member_path.resolve(strict=False)
        if not _is_within(resolved_member_path, dest):
            raise ExportError("アーカイブに無効なパスが含まれています")

        if member.issym() or member.islnk():
            link_target = Path(member.linkname)
            if link_target.is_absolute():
                resolved_link_target = link_target.resolve(strict=False)
            else:
                resolved_link_target = (member_path.parent / link_target).resolve(strict=False)

            if not _is_within(resolved_link_target, dest):
                raise ExportError("アーカイブに無効なリンクが含まれています")

    archive.extractall(dest)


@contextmanager
def load_bundle(bundle_path: Path) -> Iterator[BundleContents]:
    """Context manager that extracts a bundle into a temporary directory."""

    bundle_path = bundle_path.expanduser().resolve()
    _ensure_exists(bundle_path, "エクスポートバンドル")
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        with tarfile.open(bundle_path, "r") as archive:
            _safe_extract_all(archive, tmp_path)

        state_path = tmp_path / "state_dict.pt"
        _ensure_exists(state_path, "state_dict.pt")
        model_def_path = tmp_path / "model_def.json"
        _ensure_exists(model_def_path, "model_def.json")
        definition = load_definition(model_def_path)

        train_meta_path = tmp_path / "train_meta.json"
        train_meta: Mapping[str, object] = {}
        if train_meta_path.exists():
            train_meta = json.loads(train_meta_path.read_text(encoding="utf-8"))

        calib_path = tmp_path / "calib.json"
        calibration = {"temperature": 1.0}
        if calib_path.exists():
            calibration = json.loads(calib_path.read_text(encoding="utf-8"))

        vocab_candidate = tmp_path / "vocab.json"
        vocab_file = vocab_candidate if vocab_candidate.exists() else None

        torchscript_candidate = tmp_path / "model.ts"
        torchscript_file = torchscript_candidate if torchscript_candidate.exists() else None

        code_hash_path = tmp_path / "code_hash.txt"
        code_hash = code_hash_path.read_text(encoding="utf-8").strip() if code_hash_path.exists() else None

        yield BundleContents(
            temp_dir=tmp_path,
            state_dict_path=state_path,
            model_def=definition,
            train_meta=train_meta,
            calibration=calibration,
            vocab_path=vocab_file,
            torchscript_path=torchscript_file,
            code_hash=code_hash,
        )

