from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from dt_cv.cli import main as cli_main

ASSET_DIR = Path(__file__).parent / "assets"


def _dataset(tmp_path: Path) -> Path:
    rows = []
    for session in range(8):
        session_id = f"sess{session:02d}"
        uid = f"user{session % 2}"
        for step in range(4):
            rows.append(
                {
                    "timestamp_utc": f"2024-02-{1 + session:02d}T0{step}:00:00Z",
                    "uid": uid,
                    "session_id": session_id,
                    "method": "GET",
                    "path": "/demo",
                    "referer": "",
                    "user_agent": "pytest",
                    "ip": "127.0.0.1",
                    "op_category": "READ",
                    "anomaly_label": 1 if (session + step) % 5 == 0 else 0,
                }
            )
    frame = pd.DataFrame(rows)
    path = tmp_path / "dataset.csv"
    frame.to_csv(path, index=False)
    return path


def _run_split(tmp_path: Path) -> Path:
    data_path = _dataset(tmp_path)
    output_dir = tmp_path / "cv"
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
        "--test-size",
        "1",
        "--step-size",
        "1",
        "--purge",
        "1",
        "--embargo",
        "1",
    ]
    assert cli_main(argv) == 0
    return output_dir / "splits.yaml"


def _binaries() -> dict[str, str]:
    return {
        "dt_preproc": str(ASSET_DIR / "dummy_dt_preproc.py"),
        "dt_anom": str(ASSET_DIR / "dummy_dt_anom.py"),
        "dt_lstm": str(ASSET_DIR / "dummy_dt_lstm.py"),
    }


def test_train_eval_report_pipeline(tmp_path: Path) -> None:
    splits_path = _run_split(tmp_path)
    bins = _binaries()

    assert (
        cli_main(
            [
                "train",
                "--splits",
                str(splits_path),
                "--dt-preproc",
                bins["dt_preproc"],
                "--dt-anom",
                bins["dt_anom"],
                "--dt-lstm",
                bins["dt_lstm"],
                "--seed",
                "7",
                "--gpu-mode",
                "cpu",
            ]
        )
        == 0
    )
    folds_dir = splits_path.parent
    for fold_dir in sorted(path for path in folds_dir.iterdir() if path.is_dir() and path.name.startswith("fold_")):
        preproc_dir = fold_dir / "preproc"
        assert (preproc_dir / "stats.json").exists()
        assert (preproc_dir / "env.txt").exists()
        index_path = preproc_dir / "artifacts_index.json"
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        assert any(entry["name"].endswith("preproc.fit") for entry in payload["entries"])
        lstm_dir = fold_dir / "lstm"
        assert (lstm_dir / "calib.json").exists()

    assert (
        cli_main(
            [
                "eval",
                "--splits",
                str(splits_path),
                "--dt-anom",
                bins["dt_anom"],
                "--dt-lstm",
                bins["dt_lstm"],
                "--seed",
                "7",
                "--gpu-mode",
                "cpu",
            ]
        )
        == 0
    )

    for fold_dir in sorted(path for path in folds_dir.iterdir() if path.is_dir() and path.name.startswith("fold_")):
        metrics_path = fold_dir / "metrics" / "validation.json"
        assert metrics_path.exists()
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
        assert "methods" in metrics
        for method in ("dt_anom", "dt_lstm", "fisher"):
            assert method in metrics["methods"]
            method_payload = metrics["methods"][method]
            assert "metrics" in method_payload
            assert method_payload["metrics"]["average_precision"] is not None
            assert method_payload["metrics"]["f1"] >= 0
            assert "macro_user" in method_payload
        fisher_scores = pd.read_csv(fold_dir / "fisher" / "validation_scores.csv")
        assert "prediction_dt_anom" in fisher_scores.columns
        assert "prediction_dt_lstm" in fisher_scores.columns
        anom_payload = metrics["methods"]["dt_anom"]
        calib = anom_payload.get("calibration")
        if calib is not None:
            assert "alpha" in calib and "empirical_q" in calib

    assert (
        cli_main(
            [
                "report",
                "--splits",
                str(splits_path),
            ]
        )
        == 0
    )
    report = splits_path.parent / "cv_report.json"
    assert report.exists()
    summary = json.loads(report.read_text(encoding="utf-8"))
    assert "fisher" in summary
    assert "validation" in summary["fisher"]

    summary_dir = tmp_path / "summary"
    assert (
        cli_main(
            [
                "eval",
                "--fold-artifacts",
                str(folds_dir),
                "--bootstrap",
                "none",
                "--out",
                str(summary_dir),
                "--bootstrap-samples",
                "0",
                "--seed",
                "7",
            ]
        )
        == 0
    )
    summary_payload = json.loads((summary_dir / "metrics_summary.json").read_text(encoding="utf-8"))
    assert summary_payload["config"]["bootstrap"] == "none"
    assert "validation" in summary_payload["subsets"]
    fisher_summary = summary_payload["subsets"]["validation"]["fisher"]
    assert fisher_summary["metrics"]["average_precision"]["fold_mean"] is not None

    bootstrap_dir = tmp_path / "summary_bootstrap"
    assert (
        cli_main(
            [
                "eval",
                "--fold-artifacts",
                str(folds_dir),
                "--bootstrap",
                "stationary",
                "--block-mean",
                "2",
                "--bootstrap-samples",
                "5",
                "--out",
                str(bootstrap_dir),
                "--seed",
                "7",
            ]
        )
        == 0
    )
    bootstrap_payload = json.loads((bootstrap_dir / "metrics_summary.json").read_text(encoding="utf-8"))
    fisher_bootstrap = bootstrap_payload["subsets"]["validation"]["fisher"]
    sample_count = fisher_bootstrap["metrics"]["average_precision"]["bootstrap_sample_count"]
    assert 0 < sample_count <= 5
