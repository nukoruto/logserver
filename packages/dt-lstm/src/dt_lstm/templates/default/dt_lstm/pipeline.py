"""LSTM 異常検知パイプラインの雛形。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Sequence

import pandas as pd

from dt_lstm.engine import DTLSTMEngine, RuntimeContext
from dt_lstm.trainer import TrainerConfig, TrainingArtifacts, train_model
from dt_lstm.utils.fs import ensure_dir


def _read_split(path: Path) -> List[str]:
    if not path.exists() or not path.is_file():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _filter_sessions(df: pd.DataFrame, sessions: Sequence[str]) -> pd.DataFrame:
    if not sessions:
        return df.iloc[0:0].copy()
    mask = df["session_id"].astype(str).isin(set(map(str, sessions)))
    return df.loc[mask].reset_index(drop=True)


def _load_processed_events(processed_dir: Path) -> pd.DataFrame:
    parquet_path = processed_dir / "events.parquet"
    csv_path = processed_dir / "events.csv"
    if parquet_path.exists():
        return pd.read_parquet(parquet_path)
    if csv_path.exists():
        return pd.read_csv(csv_path)
    raise FileNotFoundError(
        f"Processed events not found under {processed_dir} (expected events.parquet or events.csv)"
    )


def _write_vocab(train_df: pd.DataFrame, vocab_cfg: Dict[str, str]) -> None:
    if not vocab_cfg:
        return
    field = vocab_cfg.get("field")
    path = vocab_cfg.get("path")
    if not field or not path:
        return
    if field not in train_df.columns:
        raise RuntimeError(f"Vocabulary field '{field}' is missing from training dataset")
    values = sorted({str(value) for value in train_df[field].dropna().tolist()})
    target = Path(path)
    ensure_dir(target.parent)
    payload = {"field": field, "values": values}
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def run_pipeline(cfg) -> TrainingArtifacts:
    processed = Path(cfg["data"]["processed_dir"])
    logging_dir = ensure_dir(cfg["logging"]["dir"])
    artifacts_dir = ensure_dir(cfg["artifacts"]["dir"])

    df = _load_processed_events(processed)
    if df.empty:
        raise RuntimeError(f"No processed events available under {processed}")

    splits_cfg = cfg["data"].get("splits", {})
    train_path = splits_cfg.get("train")
    dev_path = splits_cfg.get("dev")
    test_path = splits_cfg.get("test")

    train_ids = _read_split(Path(train_path)) if train_path else []
    dev_ids = _read_split(Path(dev_path)) if dev_path else []
    test_ids = _read_split(Path(test_path)) if test_path else []

    if "session_id" not in df.columns:
        raise RuntimeError("Processed dataset must include session_id column")

    train_ds = _filter_sessions(df, train_ids) if train_ids else df.copy()
    dev_ds = _filter_sessions(df, dev_ids)
    test_ds = _filter_sessions(df, test_ids)

    _write_vocab(train_ds, cfg["data"].get("vocab", {}))

    files_cfg = cfg["logging"].get("files", {})
    checkpoints_cfg = cfg["artifacts"].get("checkpoints", {})
    exports_cfg = cfg["artifacts"].get("exports", {})

    tc = TrainerConfig(
        device_pref=str(cfg["device"].get("prefer", "auto")),
        gpu_mode=cfg["device"].get("gpu_mode"),
        batch_size=int(cfg["data"]["loader"].get("batch_size", 16)),
        bptt_len=int(cfg["data"]["loader"].get("bptt_len", 32)),
        model_arch=str(cfg["model"].get("arch", "lstm_delta")),
        emb_dim=int(cfg["model"].get("emb_dim", 32)),
        hidden_dim=int(cfg["model"].get("hidden_dim", 64)),
        num_layers=int(cfg["model"].get("num_layers", 1)),
        logging_dir=str(logging_dir),
        artifacts_dir=str(artifacts_dir),
        files={"history": files_cfg.get("history", "history.json"), "metrics": files_cfg.get("metrics", "metrics.json"), "repro": files_cfg.get("repro", "repro.json")},
        checkpoints={"best": checkpoints_cfg.get("best", "model.pt"), "last": checkpoints_cfg.get("last", "model_last.pt")},
        exports=exports_cfg,
        max_epochs=int(cfg["train"].get("max_epochs", 3)),
        lr=float(cfg["train"].get("lr", 1e-3)),
        optimizer=str(cfg["train"].get("optimizer", "adam")),
    )

    artifacts = train_model(tc, train_ds, dev_ds, test_ds)
    return artifacts


class ProjectPipeline:
    """Project-level pipeline orchestrating runtime configuration and training."""

    def __init__(self, config: Dict[str, object]) -> None:
        self._config = config
        runtime_cfg = config.get("runtime", {}) if isinstance(config, dict) else {}
        device_section = config.get("device", {}) if isinstance(config, dict) else {}
        device_request = str(runtime_cfg.get("device", device_section.get("prefer", "auto")))
        gpu_mode = runtime_cfg.get("gpu_mode") or device_section.get("gpu_mode")
        self._engine = DTLSTMEngine(
            seed=int(runtime_cfg.get("seed", 42)),
            device=device_request,
            gpu_mode=gpu_mode,
        )
        self._runtime: RuntimeContext | None = None

    def setup(self) -> RuntimeContext:
        self._runtime = self._engine.configure()
        return self._runtime

    def train(self) -> TrainingArtifacts:
        if self._runtime is None:
            self.setup()
        return run_pipeline(self._config)
