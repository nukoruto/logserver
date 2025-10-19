from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np
import pandas as pd

from dt_cv.cli import main as cli_main


def _write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    headers = sorted(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def _dev_rows() -> list[dict[str, object]]:
    return [
        {
            "timestamp_utc": "2024-03-01T00:00:00Z",
            "uid": "u1",
            "session_id": "s1",
            "anomaly_label": 0,
            "neglog10_p": 1.2,
        },
        {
            "timestamp_utc": "2024-03-01T00:00:05Z",
            "uid": "u1",
            "session_id": "s1",
            "anomaly_label": 1,
            "neglog10_p": 2.4,
        },
        {
            "timestamp_utc": "2024-03-01T00:00:10Z",
            "uid": "u1",
            "session_id": "s1",
            "anomaly_label": 1,
            "neglog10_p": 2.1,
        },
        {
            "timestamp_utc": "2024-03-01T00:05:00Z",
            "uid": "u2",
            "session_id": "s2",
            "anomaly_label": 0,
            "neglog10_p": 1.0,
        },
    ]


def _dev_lstm_rows() -> list[dict[str, object]]:
    return [
        {
            "timestamp_utc": "2024-03-01T00:00:00Z",
            "uid": "u1",
            "session_id": "s1",
            "anomaly_label": 0,
            "neglog10_p_lstm": 0.8,
        },
        {
            "timestamp_utc": "2024-03-01T00:00:05Z",
            "uid": "u1",
            "session_id": "s1",
            "anomaly_label": 1,
            "neglog10_p_lstm": 1.5,
        },
        {
            "timestamp_utc": "2024-03-01T00:00:10Z",
            "uid": "u1",
            "session_id": "s1",
            "anomaly_label": 1,
            "neglog10_p_lstm": 1.4,
        },
        {
            "timestamp_utc": "2024-03-01T00:05:00Z",
            "uid": "u2",
            "session_id": "s2",
            "anomaly_label": 0,
            "neglog10_p_lstm": 0.7,
        },
    ]


def test_cli_fuse_creates_calibration_and_scores(tmp_path: Path) -> None:
    anom_path = tmp_path / "dev_anom.csv"
    lstm_path = tmp_path / "dev_lstm.csv"
    out_path = tmp_path / "dev_fused.csv"
    calib_path = tmp_path / "dev_calib.json"
    _write_csv(anom_path, _dev_rows())
    _write_csv(lstm_path, _dev_lstm_rows())

    argv = [
        "fuse",
        "--anom",
        str(anom_path),
        "--lstm",
        str(lstm_path),
        "--method",
        "fisher",
        "--dev-calib",
        str(calib_path),
        "--out",
        str(out_path),
        "--objective",
        "f1",
    ]
    assert cli_main(argv) == 0

    assert calib_path.exists()
    payload = json.loads(calib_path.read_text(encoding="utf-8"))
    assert payload["method"] == "fisher"
    assert payload["objective"] == "f1"
    assert payload["threshold"] > 0

    frame = pd.read_csv(out_path)
    assert "neglog10_p_fisher" in frame.columns
    assert "alarm_fisher" in frame.columns
    assert frame["alarm_fisher"].isin({0, 1}).all()

    labels = frame["anomaly_label"].to_numpy(dtype=float)
    preds = frame["alarm_fisher"].to_numpy(dtype=int)
    assert np.logical_and(preds == 1, labels == 1).sum() >= 1


def test_cli_fuse_reuses_calibration_without_labels(tmp_path: Path) -> None:
    anom_dev = tmp_path / "dev_anom.csv"
    lstm_dev = tmp_path / "dev_lstm.csv"
    out_dev = tmp_path / "dev_fused.csv"
    calib_path = tmp_path / "dev_calib.json"
    _write_csv(anom_dev, _dev_rows())
    _write_csv(lstm_dev, _dev_lstm_rows())

    assert (
        cli_main(
            [
                "fuse",
                "--anom",
                str(anom_dev),
                "--lstm",
                str(lstm_dev),
                "--method",
                "fisher",
                "--dev-calib",
                str(calib_path),
                "--out",
                str(out_dev),
                "--objective",
                "f1",
            ]
        )
        == 0
    )

    anom_test = tmp_path / "test_anom.csv"
    lstm_test = tmp_path / "test_lstm.csv"
    out_test = tmp_path / "test_fused.csv"
    test_rows = [row.copy() for row in _dev_rows()]
    for row in test_rows:
        row.pop("anomaly_label")
        row["neglog10_p"] = float(row["neglog10_p"]) + 0.01
    lstm_rows = [row.copy() for row in _dev_lstm_rows()]
    for row in lstm_rows:
        row.pop("anomaly_label")
        row["neglog10_p_lstm"] = float(row["neglog10_p_lstm"]) + 0.02
    _write_csv(anom_test, test_rows)
    _write_csv(lstm_test, lstm_rows)

    assert (
        cli_main(
            [
                "fuse",
                "--anom",
                str(anom_test),
                "--lstm",
                str(lstm_test),
                "--method",
                "fisher",
                "--dev-calib",
                str(calib_path),
                "--out",
                str(out_test),
            ]
        )
        == 0
    )

    fused_test = pd.read_csv(out_test)
    assert "alarm_fisher" in fused_test.columns
    assert fused_test["alarm_fisher"].isin({0, 1}).all()
    dev_payload = json.loads(calib_path.read_text(encoding="utf-8"))
    threshold = float(dev_payload["threshold"])
    assert np.isclose((fused_test["neglog10_p_fisher"] >= threshold).astype(int).to_numpy(), fused_test["alarm_fisher"].to_numpy()).all()
