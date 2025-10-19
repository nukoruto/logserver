"""Configuration helpers for the ``tscv run-all`` workflow."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

import yaml

from .config import RollingOriginSplitConfig


@dataclass(frozen=True)
class RunAllSettings:
    """Structured settings loaded from a ``tscv`` run-all YAML file."""

    dt_preproc_bin: str
    dt_anom_bin: str
    dt_lstm_bin: str
    lstm_cfg: Path | None
    subsets: tuple[str, ...]
    fisher_bins: int
    split_params: Mapping[str, object]

    def build_split_config(self, input_path: Path, output_dir: Path, seed: int) -> RollingOriginSplitConfig:
        """Instantiate :class:`RollingOriginSplitConfig` from stored parameters."""

        params = self.split_params
        required_keys = ("train_size", "val_size", "step_size")
        for key in required_keys:
            if key not in params:
                raise ValueError(f"Missing required split parameter: {key}")
        return RollingOriginSplitConfig(
            input_path=input_path,
            output_dir=output_dir,
            session_column=str(params.get("session_column", "session_id")),
            timestamp_column=str(params.get("timestamp_column", "timestamp_utc")),
            label_column=params.get("label_column"),
            train_size=int(params["train_size"]),
            val_size=int(params["val_size"]),
            test_size=int(params.get("test_size", 0)),
            step_size=int(params["step_size"]),
            purge_count=int(params.get("purge_count", 0)),
            embargo_count=int(params.get("embargo_count", 0)),
            max_folds=_optional_int(params.get("max_folds")),
            seed=seed,
        )


def _optional_int(value: object | None) -> int | None:
    if value in (None, "", "null"):
        return None
    return int(value)


def _ensure_sequence(value: object | None, *, field: str) -> Sequence[str]:
    if value is None:
        return ()
    if isinstance(value, (list, tuple)):
        return tuple(str(item) for item in value)
    raise ValueError(f"Field '{field}' must be a sequence of strings")


def load_run_all_settings(path: Path) -> RunAllSettings:
    """Load :class:`RunAllSettings` from YAML."""

    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError("Run-all configuration must be a mapping")

    split_section = payload.get("split")
    if not isinstance(split_section, Mapping):
        raise ValueError("Run-all configuration requires a 'split' mapping")

    binaries = payload.get("binaries", {})
    if not isinstance(binaries, Mapping):
        raise ValueError("Run-all configuration 'binaries' must be a mapping if provided")

    dt_preproc_bin = str(binaries.get("dt_preproc", "dt-preproc"))
    dt_anom_bin = str(binaries.get("dt_anom", "dt-anom"))
    dt_lstm_bin = str(binaries.get("dt_lstm", "dt-lstm"))

    lstm_section = payload.get("lstm", {})
    if not isinstance(lstm_section, Mapping):
        raise ValueError("Run-all configuration 'lstm' must be a mapping if provided")
    lstm_cfg_value = lstm_section.get("cfg")
    lstm_cfg = Path(lstm_cfg_value).expanduser().resolve() if lstm_cfg_value else None

    eval_section = payload.get("eval", {})
    if not isinstance(eval_section, Mapping):
        raise ValueError("Run-all configuration 'eval' must be a mapping if provided")
    subsets = _ensure_sequence(eval_section.get("subsets", ("validation", "test")), field="eval.subsets")
    fisher_bins = int(eval_section.get("bins", 15))

    return RunAllSettings(
        dt_preproc_bin=dt_preproc_bin,
        dt_anom_bin=dt_anom_bin,
        dt_lstm_bin=dt_lstm_bin,
        lstm_cfg=lstm_cfg,
        subsets=tuple(subsets),
        fisher_bins=fisher_bins,
        split_params=split_section,
    )


__all__ = ["RunAllSettings", "load_run_all_settings"]

