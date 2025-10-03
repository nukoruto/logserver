# -*- coding: utf-8 -*-
from pathlib import Path

import pandas as pd

from src.dataio.sessionize import SessionConfig, sessionize


def test_sessionize_computes_delta(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp": [
                "2024-01-01T00:00:00Z",
                "2024-01-01T00:00:05Z",
                "2024-01-01T00:00:12Z",
            ],
            "user_id": ["u1", "u1", "u1"],
            "event": ["login", "view", "logout"],
        }
    )
    df.to_csv(raw_path, index=False)
    processed = sessionize(raw_path, tmp_path, SessionConfig())
    assert "delta_t" in processed.columns
    assert processed.loc[1, "delta_t"] == 5.0
    assert processed.loc[2, "delta_t"] == 7.0
