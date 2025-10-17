# -*- coding: utf-8 -*-
from pathlib import Path

import pandas as pd
import pytest

from trainer.logserver.dataio.sessionize import (
    SessionConfig,
    SessionizeError,
    iter_sessionized_frames,
    load_events,
    sessionize,
)


def test_sessionize_computes_delta(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp": [
                "2024-01-01T00:00:00Z",
                "2024-01-01T00:00:05Z",
                "2024-01-01T00:00:12Z",
            ],
            "uid": ["u1", "u1", "u1"],
            "event": ["login", "view", "logout"],
        }
    )
    df.to_csv(raw_path, index=False)
    processed = sessionize(raw_path, tmp_path, SessionConfig())
    assert "delta_t" in processed.columns
    assert processed.loc[1, "delta_t"] == 5.0
    assert processed.loc[2, "delta_t"] == 7.0


@pytest.mark.parametrize("forbidden_column", ["jwt", "Authorization", "Cookie"])
def test_sessionize_rejects_raw_token_columns(tmp_path: Path, forbidden_column: str) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp": ["2024-01-01T00:00:00Z"],
            "uid": ["u1"],
            "event": ["login"],
            forbidden_column: ["header.payload.signature"],
        }
    )
    df.to_csv(raw_path, index=False)

    with pytest.raises(SessionizeError) as excinfo:
        sessionize(raw_path, tmp_path, SessionConfig())
    assert f"Forbidden column '{forbidden_column}'" in str(excinfo.value)


def test_load_events_chunk_iteration(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp": ["2024-01-01T00:00:00Z", "2024-01-01T00:00:01Z", "2024-01-01T00:00:02Z"],
            "uid": ["u1", "u1", "u2"],
            "event": ["login", "view", "logout"],
        }
    )
    df.to_csv(raw_path, index=False)
    iterator = load_events(raw_path, chunksize=2, collect=False)
    frames = list(iterator)
    assert len(frames) == 2
    assert sum(len(frame) for frame in frames) == len(df)


def test_iter_sessionized_frames_streams(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp": [
                "2024-01-01T00:00:00Z",
                "2024-01-01T00:00:01Z",
                "2024-01-01T00:00:03Z",
                "2024-01-01T00:05:00Z",
            ],
            "uid": ["u1", "u1", "u1", "u1"],
            "event": ["login", "view", "edit", "logout"],
        }
    )
    df.to_csv(raw_path, index=False)
    config = SessionConfig(idle_timeout=60, tz="UTC", chunksize=2)
    chunks = list(iter_sessionized_frames(raw_path, config))
    assert len(chunks) == 2
    total = sum(len(chunk) for chunk in chunks)
    assert total == len(df)
    combined = pd.concat(chunks, ignore_index=True)
    assert combined.iloc[0]["delta_t"] == 0.0
    assert combined.iloc[1]["delta_t"] == 1.0
    assert combined.iloc[3]["delta_t"] == 0.0
