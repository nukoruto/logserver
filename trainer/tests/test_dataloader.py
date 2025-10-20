# -*- coding: utf-8 -*-
"""Tests for RFC4180 → tensor dataloader."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, List

import pandas as pd
import torch

from trainer.logserver.dataio import dataloader


def _build_dataframe(rows: Iterable[dict]) -> pd.DataFrame:
    return pd.DataFrame(list(rows))


def _write_csv(path: Path, frame: pd.DataFrame) -> None:
    frame.to_csv(path, index=False)


def _base_rows() -> List[dict]:
    return [
        {
            "timestamp_utc": "2024-01-01T00:00:03Z",
            "sid_final": "s-1",
            "uid": "u-1",
            "cat_id": 3,
            "z_clipped": 0.1,
            "lburst": 0.0,
            "m25": -0.1,
            "m50": 0.2,
            "m75": 0.4,
            "z_deseas": 0.0,
            "dt_sec": 1.5,
        },
        {
            "timestamp_utc": "2024-01-01T00:00:01Z",
            "sid_final": "s-1",
            "uid": "u-1",
            "cat_id": 1,
            "z_clipped": 0.0,
            "lburst": 0.0,
            "m25": -0.2,
            "m50": 0.0,
            "m75": 0.2,
            "z_deseas": 0.0,
            "dt_sec": 0.0,
        },
        {
            "timestamp_utc": "2024-01-01T00:00:05Z",
            "sid_final": "s-2",
            "uid": "u-1",
            "cat_id": 2,
            "z_clipped": 0.2,
            "lburst": 0.1,
            "m25": -0.05,
            "m50": 0.1,
            "m75": 0.3,
            "z_deseas": 0.1,
            "dt_sec": 3.5,
        },
    ]


def test_dataloader_is_deterministic_for_row_order(tmp_path: Path) -> None:
    frame = _build_dataframe(_base_rows())
    shuffled = frame.sample(frac=1.0, random_state=42)
    path_first = tmp_path / "events_first.csv"
    path_second = tmp_path / "events_second.csv"
    _write_csv(path_first, frame)
    _write_csv(path_second, shuffled)

    batch_first = dataloader.load_packed_sessions(path_first)
    batch_second = dataloader.load_packed_sessions(path_second)

    assert torch.equal(batch_first.categorical_padded, batch_second.categorical_padded)
    assert torch.equal(batch_first.numeric_padded, batch_second.numeric_padded)
    assert batch_first.session_ids == batch_second.session_ids


def test_causal_mask_masks_future_events(tmp_path: Path) -> None:
    frame = _build_dataframe(_base_rows())
    path = tmp_path / "events.csv"
    _write_csv(path, frame)

    batch = dataloader.load_packed_sessions(path)
    mask = batch.causal_mask
    lengths = batch.lengths.tolist()

    for row, length in enumerate(lengths):
        for i in range(length):
            for j in range(length):
                if j > i:
                    assert mask[row, i, j]
                else:
                    assert not mask[row, i, j]
        if mask.shape[1] > length:
            assert mask[row, length:, :].all()
            assert mask[row, :, length:].all()
    assert batch.session_end.sum().item() == len(lengths)


def test_derive_sessions_without_sid_final(tmp_path: Path) -> None:
    rows = _base_rows()
    for row in rows:
        row.pop("sid_final")
    frame = _build_dataframe(rows)
    path = tmp_path / "events.csv"
    _write_csv(path, frame)

    batch = dataloader.load_packed_sessions(path)
    assert len(batch.session_ids) == 2
    assert batch.session_ids[0].endswith("-0")
    assert batch.session_ids[1].endswith("-1")


def test_cli_emits_archive_and_metadata(tmp_path: Path, capsys) -> None:
    frame = _build_dataframe(_base_rows())
    path = tmp_path / "events.csv"
    _write_csv(path, frame)
    output = tmp_path / "packed.pt"

    exit_code = dataloader.main(
        [
            "--input",
            str(path),
            "--output",
            str(output),
        ]
    )
    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert exit_code == 0
    assert output.exists()
    assert payload["event"] == "dataloader_output"
    loaded = torch.load(output)
    assert "categorical_padded" in loaded
