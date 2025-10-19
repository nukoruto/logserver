"""Tests for the dt-lstm train command."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import yaml

torch = pytest.importorskip("torch")  # noqa: F841 - used for availability check

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm import cli  # noqa: E402  pylint: disable=wrong-import-position


def _write_csv(path: Path, rows: str) -> None:
    path.write_text(rows, encoding="utf-8")


def test_cli_train_emits_artifacts(tmp_path, capsys):
    train_dir = tmp_path / "train_feat"
    val_dir = tmp_path / "val_feat"
    out_dir = tmp_path / "ml" / "checkpoints"
    train_dir.mkdir(parents=True)
    val_dir.mkdir(parents=True)

    train_rows = """timestamp_utc,sid_final,uid,cat_id,z_clipped,lburst,m25,m50,m75,z_deseas,dt_sec
2024-01-01T00:00:00Z,s-1,u-1,1,0.1,0,0,0,0,0,0.0
2024-01-01T00:00:01Z,s-1,u-1,2,0.2,0,0,0,0,0,1.0
2024-01-01T00:00:03Z,s-1,u-1,3,0.3,0,0,0,0,0,2.0
2024-01-02T00:00:00Z,s-2,u-2,1,0.1,0,0,0,0,0,0.0
2024-01-02T00:00:01Z,s-2,u-2,4,0.4,0,0,0,0,0,1.0
2024-01-02T00:00:05Z,s-2,u-2,2,0.2,0,0,0,0,0,4.0
"""
    val_rows = """timestamp_utc,sid_final,uid,cat_id,z_clipped,lburst,m25,m50,m75,z_deseas,dt_sec
2024-01-03T00:00:00Z,s-3,u-3,1,0.1,0,0,0,0,0,0.0
2024-01-03T00:00:01Z,s-3,u-3,2,0.2,0,0,0,0,0,1.0
2024-01-03T00:00:04Z,s-3,u-3,3,0.3,0,0,0,0,0,3.0
"""
    _write_csv(train_dir / "train.csv", train_rows)
    _write_csv(val_dir / "val.csv", val_rows)

    exit_code = cli.main(
        [
            "train",
            "--train",
            str(train_dir / "*.csv"),
            "--val",
            str(val_dir / "*.csv"),
            "--arch",
            "lstm",
            "--time-head",
            "rmtpp",
            "--time-objective",
            "rmtpp",
            "--epochs",
            "2",
            "--bs",
            "2",
            "--lr",
            "1e-2",
            "--scheduler",
            "none",
            "--early",
            "2",
            "--uncertainty-weight",
            "on",
            "--amp",
            "off",
            "--clip-grad",
            "1.0",
            "--scheduled-sampling",
            "0.1",
            "--focal-gamma",
            "1.5",
            "--label-smoothing",
            "0.1",
            "--seed",
            "123",
            "--out",
            str(out_dir),
        ]
    )

    assert exit_code == 0
    stdout = capsys.readouterr().out.strip()
    payload = json.loads(stdout)
    assert payload["event"] == "train.completed"
    model_path = Path(payload["model_path"])
    optimizer_path = Path(payload["optimizer_path"])
    config_path = Path(payload["config_path"])
    history_path = Path(payload["history_path"])
    assert model_path.exists()
    assert optimizer_path.exists()
    assert config_path.exists()
    assert history_path.exists()

    history = json.loads(history_path.read_text(encoding="utf-8"))
    assert "train_loss" in history
    assert len(history["train_loss"]) >= 1

    config = json.loads(config_path.read_text(encoding="utf-8"))
    assert config["training"]["uncertainty_weighting"] is True
    assert config["time_objective"] == "rmtpp"

    model_bytes = model_path.read_bytes()
    optim_bytes = optimizer_path.read_bytes()
    history_bytes = history_path.read_bytes()

    exit_code = cli.main(
        [
            "train",
            "--train",
            str(train_dir / "*.csv"),
            "--val",
            str(val_dir / "*.csv"),
            "--arch",
            "lstm",
            "--time-head",
            "rmtpp",
            "--time-objective",
            "rmtpp",
            "--epochs",
            "2",
            "--bs",
            "2",
            "--lr",
            "1e-2",
            "--scheduler",
            "none",
            "--early",
            "2",
            "--uncertainty-weight",
            "on",
            "--amp",
            "off",
            "--clip-grad",
            "1.0",
            "--scheduled-sampling",
            "0.1",
            "--focal-gamma",
            "1.5",
            "--label-smoothing",
            "0.1",
            "--seed",
            "123",
            "--out",
            str(out_dir),
        ]
    )
    assert exit_code == 0
    assert model_bytes == model_path.read_bytes()
    assert optim_bytes == optimizer_path.read_bytes()
    assert history_bytes == history_path.read_bytes()


def test_cli_train_uses_yaml_config(tmp_path, capsys):
    train_dir = tmp_path / "train_feat"
    val_dir = tmp_path / "val_feat"
    out_dir = tmp_path / "ml" / "checkpoints"
    train_dir.mkdir(parents=True)
    val_dir.mkdir(parents=True)

    train_rows = """timestamp_utc,sid_final,uid,cat_id,z_clipped,dt_sec
2024-01-01T00:00:00Z,s-1,u-1,1,0.1,0.0
2024-01-01T00:00:01Z,s-1,u-1,2,0.2,1.0
2024-01-01T00:00:03Z,s-1,u-1,3,0.3,2.0
"""
    val_rows = """timestamp_utc,sid_final,uid,cat_id,z_clipped,dt_sec
2024-01-02T00:00:00Z,s-2,u-2,1,0.1,0.0
2024-01-02T00:00:02Z,s-2,u-2,3,0.4,2.0
2024-01-02T00:00:05Z,s-2,u-2,2,0.2,3.0
"""
    _write_csv(train_dir / "train.csv", train_rows)
    _write_csv(val_dir / "val.csv", val_rows)

    cfg = {
        "data": {
            "numeric_columns": ["dt_sec", "z_clipped"],
            "delta_column": "dt_sec",
            "idle_timeout": 600.0,
        },
        "model": {
            "arch": "lstm",
            "time_head": "rmtpp",
            "embedding_dim": 16,
            "hidden_size": 16,
            "num_layers": 1,
            "dropout": 0.0,
            "mlp_hidden": [],
            "mlp_activation": "relu",
            "mlp_dropout": 0.0,
            "delta_index": 0,
            "rmtpp_eps": 1e-6,
        },
        "training": {
            "epochs": 1,
            "batch_size": 2,
            "learning_rate": 0.01,
            "min_learning_rate": 0.001,
            "scheduler": "none",
            "early_stopping": 1,
            "clip_grad": 0.5,
            "amp_level": "O1",
            "scheduled_sampling": 0.0,
            "uncertainty_weighting": True,
            "focal_gamma": None,
            "label_smoothing": 0.0,
            "num_workers": 0,
        },
        "time_objective": "rmtpp",
        "calibration": {"batch_size": 2, "bins": 5, "max_k": 3},
        "inference": {"topk": 2},
    }
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(yaml.safe_dump(cfg), encoding="utf-8")

    exit_code = cli.main(
        [
            "train",
            "--train",
            str(train_dir / "*.csv"),
            "--dev",
            str(val_dir / "*.csv"),
            "--cfg",
            str(cfg_path),
            "--out",
            str(out_dir),
        ]
    )
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["event"] == "train.completed"
    assert Path(payload["model_path"]).exists()
    assert payload["config_source"] == str(cfg_path.resolve())

    config_path = Path(payload["config_path"])
    config = json.loads(config_path.read_text(encoding="utf-8"))
    assert config["training"]["amp_level"] == "O1"
    assert config["training"]["uncertainty_weighting"] is True
    assert config["model"]["hidden_size"] == 16
