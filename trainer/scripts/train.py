# -*- coding: utf-8 -*-
"""CLI for training the Δt-aware LSTM."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Sequence

import yaml

from trainer.logserver.dataio.processed import load_processed_events
from trainer.logserver.features.encoders import build_feature_pack, encode_dataframe
from trainer.logserver.training.trainer import (
    SessionSplit,
    TrainerConfig,
    create_session_split,
    train_model,
)


def _load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def _normalize_features(features: Sequence[str] | None) -> Sequence[str]:
    return [feature.lower() for feature in (features or []) if feature]


def _select_training_rows(df: pd.DataFrame, split: SessionSplit) -> pd.DataFrame:
    if not split.train_ids:
        return df.copy()
    mask = df["session_id"].astype(str).isin(set(split.train_ids))
    subset = df.loc[mask].copy()
    if subset.empty:
        raise RuntimeError("Training split is empty after applying session mask")
    return subset


def _log_feature_usage(feature_pack, requested: Sequence[str]) -> None:
    logger = logging.getLogger(__name__)
    dt_keys = {"z", "z_deseas", "lburst", "m25", "m50", "m75"}
    using_dt = [name for name in feature_pack.numeric_features if name in dt_keys]
    requested_set = {name.lower() for name in requested}
    if "dt" in requested_set:
        payload = {
            "event": "feature_selection",
            "mode": "dt",
            "using_features": using_dt,
        }
        if not using_dt:
            payload["fallback"] = "basic"
        logger.info(json.dumps(payload, ensure_ascii=False))


def main(config_path: Path, features: Sequence[str] | None = None) -> None:
    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    model_cfg = config.get("model", {})
    train_cfg = config.get("training", {})
    logging_cfg = config.get("logging", {})

    log_level = logging_cfg.get("level", "INFO")
    logging.basicConfig(level=getattr(logging, str(log_level).upper(), logging.INFO))

    processed_dir = Path(data_cfg.get("processed_dir", "data/processed"))
    df = load_processed_events(processed_dir)
    session_ids = df["session_id"].astype(str).tolist()

    trainer_config = TrainerConfig(
        batch_size=int(train_cfg.get("batch_size", 64)),
        max_epochs=int(train_cfg.get("max_epochs", 20)),
        learning_rate=float(train_cfg.get("learning_rate", 1e-3)),
        validation_split=float(train_cfg.get("validation_split", 0.1)),
        early_stopping_patience=int(train_cfg.get("early_stopping_patience", 3)),
        seed=int(train_cfg.get("seed", 42)),
        embedding_dim=int(model_cfg.get("embedding_dim", 64)),
        hidden_size=int(model_cfg.get("hidden_size", 64)),
        num_layers=int(model_cfg.get("num_layers", 1)),
        dropout=float(model_cfg.get("dropout", 0.1)),
        device=train_cfg.get("device", "cpu"),
    )

    output_dir = Path(logging_cfg.get("dir", "runs"))
    output_dir.mkdir(parents=True, exist_ok=True)
    feature_flags = _normalize_features(features)
    split = create_session_split(session_ids, trainer_config)
    training_df = _select_training_rows(df, split)
    feature_pack = build_feature_pack(training_df, extra_features=feature_flags)
    _log_feature_usage(feature_pack, feature_flags)
    encoded = encode_dataframe(df, feature_pack)
    train_model(encoded, session_ids, feature_pack, output_dir, trainer_config, split=split)


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Train Δt-aware LSTM model")
    parser.add_argument(
        "--config",
        default="trainer/configs/default.yaml",
        help="Path to YAML configuration",
    )
    parser.add_argument(
        "--features",
        default="",
        help="Comma separated feature switches (e.g. dt)",
    )
    args = parser.parse_args()
    feature_list = [item.strip() for item in args.features.split(",") if item.strip()]
    main(Path(args.config), feature_list)
