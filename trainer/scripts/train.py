# -*- coding: utf-8 -*-
"""CLI for training the Δt-aware LSTM."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import yaml

from trainer.logserver.features.encoders import build_feature_pack, encode_dataframe
from trainer.logserver.training.trainer import TrainerConfig, train_model


def _load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def main(config_path: Path) -> None:
    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    model_cfg = config.get("model", {})
    train_cfg = config.get("training", {})
    logging_cfg = config.get("logging", {})

    processed_dir = Path(data_cfg.get("processed_dir", "data/processed"))
    df = pd.read_parquet(processed_dir / "events.parquet")
    feature_pack = build_feature_pack(df)
    encoded = encode_dataframe(df, feature_pack)
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
    train_model(encoded, session_ids, feature_pack, output_dir, trainer_config)


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Train Δt-aware LSTM model")
    parser.add_argument(
        "--config",
        default="trainer/configs/default.yaml",
        help="Path to YAML configuration",
    )
    args = parser.parse_args()
    main(Path(args.config))
