# -*- coding: utf-8 -*-
from pathlib import Path

import pandas as pd

from src.features.encoders import build_feature_pack, encode_dataframe
from src.training.trainer import TrainerConfig, train_model


def test_train_model_produces_artifacts(tmp_path: Path) -> None:
    df = pd.DataFrame(
        {
            "event": ["login", "view", "logout", "login", "edit", "logout"],
            "delta_t": [0.0, 2.0, 3.0, 0.0, 1.0, 1.0],
            "latency_ms": [100, 150, 120, 90, 95, 110],
            "status": [200, 200, 200, 200, 200, 200],
            "session_id": ["s1", "s1", "s1", "s2", "s2", "s2"],
        }
    )
    pack = build_feature_pack(df)
    encoded = encode_dataframe(df, pack)
    session_ids = df["session_id"].tolist()
    config = TrainerConfig(max_epochs=1, batch_size=2, validation_split=0.5, early_stopping_patience=1)
    train_model(encoded, session_ids, pack, tmp_path, config)
    artifacts = list(tmp_path.glob("*/model.pt"))
    assert artifacts, "model.pt not found in run directory"
