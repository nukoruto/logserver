# -*- coding: utf-8 -*-
import json
import subprocess
import sys
from pathlib import Path

import pandas as pd

from trainer.logserver.features.encoders import build_feature_pack, encode_dataframe
from trainer.logserver.training.trainer import TrainerConfig, create_session_split, train_model


def test_train_model_produces_artifacts(tmp_path: Path) -> None:
    df = pd.DataFrame(
        {
            "event": ["login", "view", "logout", "login", "edit", "logout"],
            "delta_t": [0.0, 2.0, 3.0, 0.0, 1.0, 1.0],
            "latency_ms": [100, 150, 120, 90, 95, 110],
            "status": [200, 200, 200, 200, 200, 200],
            "session_id": ["s1", "s1", "s1", "s2", "s2", "s2"],
            "timestamp": pd.to_datetime(
                [
                    "2024-01-01T00:00:00Z",
                    "2024-01-01T00:01:00Z",
                    "2024-01-01T00:02:00Z",
                    "2024-01-02T00:00:00Z",
                    "2024-01-02T00:01:00Z",
                    "2024-01-02T00:02:00Z",
                ],
                utc=True,
            ),
        }
    )
    session_ids = df["session_id"].astype(str).tolist()
    timestamps = df["timestamp"].tolist()
    config = TrainerConfig(max_epochs=1, batch_size=2, validation_split=0.5, early_stopping_patience=1)
    split = create_session_split(session_ids, timestamps, config)
    train_df = df[df["session_id"].isin(split.train_ids)]
    pack = build_feature_pack(train_df, extra_features=None)
    encoded = encode_dataframe(df, pack)
    train_model(encoded, session_ids, pack, tmp_path, config, split=split)
    artifacts = list(tmp_path.glob("*/model.pt"))
    assert artifacts, "model.pt not found in run directory"
    repro = list(tmp_path.glob("*/repro.json"))
    assert repro, "repro.json not generated"


def test_train_model_with_response_bytes(tmp_path: Path) -> None:
    df = pd.DataFrame(
        {
            "event": ["login", "view", "logout", "login", "edit", "logout"],
            "delta_t": [0.0, 2.0, 3.0, 0.0, 1.0, 1.0],
            "latency_ms": [100, 150, 120, 90, 95, 110],
            "status": [200, 200, 200, 200, 200, 200],
            "response_bytes": [256, 512, 128, 256, 1024, 512],
            "session_id": ["s1", "s1", "s1", "s2", "s2", "s2"],
            "timestamp": pd.to_datetime(
                [
                    "2024-01-01T00:00:00Z",
                    "2024-01-01T00:01:00Z",
                    "2024-01-01T00:02:00Z",
                    "2024-01-02T00:00:00Z",
                    "2024-01-02T00:01:00Z",
                    "2024-01-02T00:02:00Z",
                ],
                utc=True,
            ),
        }
    )
    session_ids = df["session_id"].astype(str).tolist()
    timestamps = df["timestamp"].tolist()
    config = TrainerConfig(max_epochs=1, batch_size=2, validation_split=0.5, early_stopping_patience=1)
    split = create_session_split(session_ids, timestamps, config)
    train_df = df[df["session_id"].isin(split.train_ids)]
    pack = build_feature_pack(train_df, extra_features=None)
    encoded = encode_dataframe(df, pack)
    train_model(encoded, session_ids, pack, tmp_path, config, split=split)
    artifacts = list(tmp_path.glob("*/model.pt"))
    assert artifacts, "model.pt not found in run directory"
    metadata_files = list(tmp_path.glob("*/model_config.json"))
    assert metadata_files, "model_config.json not found"
    with metadata_files[0].open("r", encoding="utf-8") as handle:
        model_config = json.load(handle)
    assert "num_workers" in model_config
    assert "pin_memory" in model_config


def test_train_cli_help_succeeds() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "trainer.scripts.train", "--help"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "Train" in result.stdout
