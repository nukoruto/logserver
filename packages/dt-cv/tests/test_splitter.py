from __future__ import annotations

from pathlib import Path

import pandas as pd

from dt_cv.cli import main as cli_main


def _create_dataset(path: Path, sessions: int) -> None:
    rows = []
    for session in range(sessions):
        session_id = f"s{session:03d}"
        uid = f"u{session % 3:02d}"
        for index in range(3):
            timestamp = f"2024-01-0{1 + session % 5}T0{index}:00:00Z"
            rows.append(
                {
                    "timestamp_utc": timestamp,
                    "uid": uid,
                    "session_id": session_id,
                    "method": "GET",
                    "path": "/resource",
                    "referer": "",
                    "user_agent": "test",
                    "ip": "127.0.0.1",
                    "op_category": "READ",
                    "anomaly_label": int((session + index) % 7 == 0),
                }
            )
    frame = pd.DataFrame(rows)
    frame.to_csv(path, index=False)


def test_split_creates_expected_structure(tmp_path: Path) -> None:
    data_path = tmp_path / "dataset.csv"
    _create_dataset(data_path, sessions=10)
    output_dir = tmp_path / "folds"
    argv = [
        "split",
        "--input",
        str(data_path),
        "--output",
        str(output_dir),
        "--train-size",
        "4",
        "--val-size",
        "2",
        "--step-size",
        "2",
        "--purge",
        "1",
        "--embargo",
        "1",
        "--seed",
        "123",
    ]
    exit_code = cli_main(argv)
    assert exit_code == 0
    splits_yaml = output_dir / "splits.yaml"
    assert splits_yaml.exists()
    fold_dirs = sorted(path for path in output_dir.iterdir() if path.is_dir())
    assert len(fold_dirs) >= 1
    for fold_dir in fold_dirs:
        raw_dir = fold_dir / "raw"
        assert (raw_dir / "train.csv").exists()
        assert (raw_dir / "validation.csv").exists()
