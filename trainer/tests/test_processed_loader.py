# -*- coding: utf-8 -*-
"""Tests for processed event loading utilities."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from trainer.logserver.dataio.processed import load_processed_events


def _write_csv(tmp_path: Path) -> None:
    df = pd.DataFrame(
        {
            "timestamp": ["2024-01-01T00:00:00+00:00"],
            "session_id": ["s-1"],
            "event": ["login"],
            "delta_t": [0.0],
        }
    )
    df.to_csv(tmp_path / "events.csv", index=False)


def test_load_processed_events_uses_csv_when_parquet_missing(tmp_path: Path) -> None:
    _write_csv(tmp_path)
    loaded = load_processed_events(tmp_path)
    assert loaded.shape[0] == 1
    assert str(loaded.loc[0, "session_id"]) == "s-1"
    assert str(loaded.loc[0, "event"]) == "login"
    assert str(loaded.loc[0, "timestamp"]) == "2024-01-01 00:00:00+00:00"


def test_load_processed_events_fallback_on_parquet_error(monkeypatch, tmp_path: Path) -> None:
    _write_csv(tmp_path)
    parquet_path = tmp_path / "events.parquet"
    parquet_path.write_text("not-real-parquet", encoding="utf-8")

    monkeypatch.setattr(
        "trainer.logserver.dataio.processed.pd.read_parquet",
        lambda *args, **kwargs: (_ for _ in ()).throw(ImportError("pyarrow missing")),
    )

    loaded = load_processed_events(tmp_path)
    assert loaded.shape[0] == 1
