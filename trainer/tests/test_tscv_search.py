import json
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_ROOT / "trainer" / "src"))

from logserver.training.search import _apply_temporal_exclusions


def _create_processed_dataset(root: Path) -> Path:
    processed_dir = root / "processed"
    processed_dir.mkdir()
    timestamps = pd.date_range("2024-01-01T00:00:00Z", periods=9, freq="min", tz="UTC")
    df = pd.DataFrame(
        {
            "event": [
                "login",
                "view",
                "logout",
                "login",
                "edit",
                "logout",
                "login",
                "delete",
                "logout",
            ],
            "delta_t": [0.0, 1.0, 2.0, 0.0, 1.0, 1.0, 0.0, 2.0, 1.0],
            "latency_ms": [100, 120, 130, 90, 95, 105, 110, 150, 140],
            "status": [200] * 9,
            "session_id": [
                "s1",
                "s1",
                "s1",
                "s2",
                "s2",
                "s2",
                "s3",
                "s3",
                "s3",
            ],
            "timestamp": timestamps,
            "anomaly_label": [0, 0, 0, 0, 1, 0, 0, 0, 1],
        }
    )
    df.to_csv(processed_dir / "events.csv", index=False)
    return processed_dir


def _write_split_file(root: Path, processed_dir: Path) -> Path:
    content = {
        "dataset": {
            "processed_dir": str(processed_dir),
            "label_column": "anomaly_label",
            "timestamp_column": "timestamp",
            "session_column": "session_id",
        },
        "folds": [
            {
                "name": "fold0",
                "train_sessions": ["s1"],
                "validation_sessions": ["s2"],
                "purge": {"minutes": 1},
                "embargo": 0,
            },
            {
                "name": "fold1",
                "train_sessions": ["s2"],
                "validation_sessions": ["s3"],
                "purge": 0,
                "embargo": {"seconds": 30},
            },
        ],
    }
    path = root / "splits.yaml"
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(content, handle)
    return path


def _write_search_space(root: Path) -> Path:
    space = {
        "trainer": {
            "batch_size": {"type": "choice", "values": [2]},
            "max_epochs": {"type": "choice", "values": [1]},
            "learning_rate": {"type": "choice", "values": [0.01]},
            "early_stopping_patience": {"type": "choice", "values": [1]},
            "device": {"type": "choice", "values": ["cpu"]},
        },
        "model": {
            "embedding_dim": {"type": "choice", "values": [8]},
            "hidden_size": {"type": "choice", "values": [8]},
            "num_layers": {"type": "choice", "values": [1]},
            "dropout": {"type": "choice", "values": [0.0]},
        },
        "features": {
            "extra": {"type": "choice", "values": [[]]},
            "smoothing_window": {"type": "choice", "values": [1]},
        },
    }
    path = root / "space.yaml"
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(space, handle)
    return path


def test_tscv_search_cli_produces_results(tmp_path: Path) -> None:
    processed_dir = _create_processed_dataset(tmp_path)
    splits = _write_split_file(tmp_path, processed_dir)
    space = _write_search_space(tmp_path)
    out_path = tmp_path / "result.json"

    subprocess.run(
        [
            sys.executable,
            "-m",
            "trainer.scripts.tscv",
            "search",
            "--splits",
            str(splits),
            "--space",
            str(space),
            "--n_trials",
            "2",
            "--metric",
            "ap",
            "--out",
            str(out_path),
            "--seed",
            "123",
        ],
        check=True,
    )

    assert out_path.exists(), "Summary JSON not created"
    with out_path.open("r", encoding="utf-8") as handle:
        summary = json.load(handle)
    assert summary["metric"] == "ap"
    assert summary["best_trial"]["status"] == "ok"
    assert summary["best_trial"]["metrics"]["ap"] is not None
    log_path = tmp_path / "result.jsonl"
    assert log_path.exists(), "JSONL log not created"
    with log_path.open("r", encoding="utf-8") as handle:
        lines = [line.strip() for line in handle if line.strip()]
    assert len(lines) == 2
    record = json.loads(lines[0])
    assert record["status"] == "ok"
    assert len(record["folds"]) == 2
    assert record["folds"][0]["metrics"]["ap"] is not None


def test_apply_temporal_exclusions_removes_purge_and_embargo() -> None:
    train_df = pd.DataFrame(
        {
            "session_id": ["train"] * 4,
            "timestamp": pd.to_datetime(
                [
                    "2024-01-01T00:00:00Z",
                    "2024-01-01T00:01:30Z",
                    "2024-01-01T00:04:30Z",
                    "2024-01-01T00:06:00Z",
                ],
                utc=True,
            ),
        }
    )
    val_df = pd.DataFrame(
        {
            "session_id": ["val", "val"],
            "timestamp": pd.to_datetime(
                ["2024-01-01T00:02:00Z", "2024-01-01T00:03:00Z"],
                utc=True,
            ),
        }
    )

    filtered, dropped = _apply_temporal_exclusions(
        train_df,
        val_df,
        timestamp_column="timestamp",
        session_column="session_id",
        purge_seconds=60.0,
        embargo_seconds=120.0,
    )

    assert dropped == 2
    assert list(filtered["timestamp"]) == [
        pd.Timestamp("2024-01-01T00:00:00Z", tz="UTC"),
        pd.Timestamp("2024-01-01T00:06:00Z", tz="UTC"),
    ]


def test_tscv_cli_help() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "trainer.scripts.tscv", "--help"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "cross-validation" in result.stdout.lower()
