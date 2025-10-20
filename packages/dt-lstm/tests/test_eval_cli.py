from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pandas as pd
import pytest

torch = pytest.importorskip("torch")  # noqa: F401

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm import cli  # noqa: E402  pylint: disable=wrong-import-position


def _write_ground_truth(path: Path) -> None:
    data = {
        "timestamp_utc": [
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:00:01Z",
            "2024-01-01T00:00:02Z",
            "2024-01-01T00:00:03Z",
        ],
        "uid": ["u1"] * 4,
        "session_id": ["s1"] * 4,
        "anomaly_label": [0, 0, 1, 1],
    }
    frame = pd.DataFrame(data)
    frame.to_csv(path, index=False)


def _write_scored(path: Path) -> None:
    rows = [
        {
            "sequence_index": 0,
            "step_index": 0,
            "source": "stream.csv",
            "session_id": "s1",
            "uid": "u1",
            "timestamp": "2024-01-01T00:00:00Z",
            "target_id": 2,
            "target_token": "browse",
            "delta": 1.0,
            "censored": 0,
            "topk_mass": 0.7,
            "p_ev": 0.3,
            "p_time": 0.4,
            "fisher_statistic": 1.2,
            "combined_p": 0.2,
            "neglog10_p": -math.log10(0.2),
            "rmtpp_g": 0.1,
            "rmtpp_w": 0.5,
            "topk_hit": 1,
            "topk_rank": 1,
            "alarm_active": 0,
        },
        {
            "sequence_index": 0,
            "step_index": 1,
            "source": "stream.csv",
            "session_id": "s1",
            "uid": "u1",
            "timestamp": "2024-01-01T00:00:01Z",
            "target_id": 3,
            "target_token": "edit",
            "delta": 1.5,
            "censored": 0,
            "topk_mass": 0.65,
            "p_ev": 0.35,
            "p_time": 0.45,
            "fisher_statistic": 1.5,
            "combined_p": 0.15,
            "neglog10_p": -math.log10(0.15),
            "rmtpp_g": 0.05,
            "rmtpp_w": 0.4,
            "topk_hit": 1,
            "topk_rank": 2,
            "alarm_active": 0,
        },
        {
            "sequence_index": 0,
            "step_index": 2,
            "source": "stream.csv",
            "session_id": "s1",
            "uid": "u1",
            "timestamp": "2024-01-01T00:00:02Z",
            "target_id": 4,
            "target_token": "delete",
            "delta": 2.0,
            "censored": 0,
            "topk_mass": 0.4,
            "p_ev": 0.6,
            "p_time": 0.2,
            "fisher_statistic": 2.0,
            "combined_p": 0.02,
            "neglog10_p": -math.log10(0.02),
            "rmtpp_g": -0.2,
            "rmtpp_w": 0.6,
            "topk_hit": 0,
            "topk_rank": 0,
            "alarm_active": 1,
        },
        {
            "sequence_index": 0,
            "step_index": 3,
            "source": "stream.csv",
            "session_id": "s1",
            "uid": "u1",
            "timestamp": "2024-01-01T00:00:03Z",
            "target_id": 5,
            "target_token": "logout",
            "delta": 2.5,
            "censored": 0,
            "topk_mass": 0.35,
            "p_ev": 0.65,
            "p_time": 0.18,
            "fisher_statistic": 2.5,
            "combined_p": 0.01,
            "neglog10_p": -math.log10(0.01),
            "rmtpp_g": -0.25,
            "rmtpp_w": 0.65,
            "topk_hit": 0,
            "topk_rank": 0,
            "alarm_active": 1,
        },
    ]
    frame = pd.DataFrame(rows)
    frame.to_csv(path, index=False)


def test_eval_cli_produces_metrics(tmp_path: Path, capsys) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    ground_path = data_dir / "ground.csv"
    scored_path = tmp_path / "scored.csv"
    _write_ground_truth(ground_path)
    _write_scored(scored_path)
    metrics_path = tmp_path / "metrics.json"

    args = [
        "eval",
        "--in",
        str(ground_path),
        "--scored",
        str(scored_path),
        "--out",
        str(metrics_path),
        "--bins",
        "5",
    ]

    exit_code = cli.main(args)
    assert exit_code == 0
    output = capsys.readouterr().out.strip()
    payload = json.loads(output)
    assert payload["event"] == "eval.completed"
    assert Path(payload["metrics_path"]).exists()
    assert Path(payload["pr_curve_png"]).exists()
    assert Path(payload["calibration_png"]).exists()

    metrics_bytes = metrics_path.read_bytes()
    metrics = json.loads(metrics_bytes.decode("utf-8"))
    assert metrics["metrics"]["f1"] == pytest.approx(1.0, rel=1e-6)
    assert metrics["metrics"]["topk_accuracy"] == pytest.approx(0.5, rel=1e-6)
    assert metrics["counts"]["events"] == 4
    assert metrics["counts"]["positive_events"] == 2
    assert metrics["counts"]["predicted_positive_events"] == 2
    assert metrics["counts"]["detected_segments"] == 1
    assert metrics["metrics"]["average_detection_delay_sec"] == pytest.approx(0.0, abs=1e-6)

    # Deterministic outputs
    pr_path = Path(payload["pr_curve_png"])
    calib_path = Path(payload["calibration_png"])
    pr_bytes = pr_path.read_bytes()
    calib_bytes = calib_path.read_bytes()

    exit_code = cli.main(args)
    assert exit_code == 0
    assert metrics_bytes == metrics_path.read_bytes()
    assert pr_bytes == pr_path.read_bytes()
    assert calib_bytes == calib_path.read_bytes()
