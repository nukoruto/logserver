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

    report_dir = tmp_path / "tscv_report"
    assert (
        cli_main(
            [
                "report",
                "--splits",
                str(splits_path),
                "--summary",
                str(summary_dir),
                "--fold-artifacts",
                str(folds_dir),
                "--out",
                str(report_dir),
                "--subsets",
                "validation",
                "test",
            ]
        )
        == 0
    )
    report = splits_path.parent / "cv_report.json"
    assert report.exists()
    summary = json.loads(report.read_text(encoding="utf-8"))
    assert "fisher" in summary
    assert "validation" in summary["fisher"]
    results_md = report_dir / "results.md"
    assert results_md.exists()
    assert "閾値" in results_md.read_text(encoding="utf-8")
    env_txt = report_dir / "env.txt"
    assert env_txt.exists()
    assert "DT_GLOBAL_SEED" in env_txt.read_text(encoding="utf-8")
    packaged_scores = report_dir / "fold_000" / "anom" / "validation_scores.csv"
    assert packaged_scores.exists()

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


def test_run_all_resume(tmp_path: Path) -> None:
    dataset_path = _dataset(tmp_path)
    bins = _binaries()
    cfg_path = tmp_path / "tscv_config.yaml"
    repo_root = Path(__file__).resolve().parents[3]
    cfg_lines = [
        "version: 1",
        "split:",
        "  session_column: session_id",
        "  timestamp_column: timestamp_utc",
        "  label_column: anomaly_label",
        "  train_size: 4",
        "  val_size: 2",
        "  test_size: 1",
        "  step_size: 1",
        "  purge_count: 1",
        "  embargo_count: 1",
        "binaries:",
        f"  dt_preproc: {bins['dt_preproc']}",
        f"  dt_anom: {bins['dt_anom']}",
        f"  dt_lstm: {bins['dt_lstm']}",
        "lstm:",
        f"  cfg: {repo_root / 'configs' / 'best_from_search.yaml'}",
        "eval:",
        "  subsets: [validation, test]",
        "  bins: 15",
    ]
    cfg_path.write_text("\n".join(cfg_lines) + "\n", encoding="utf-8")
    out_dir = tmp_path / "artifacts"
    report_dir = tmp_path / "reports"
    args = [
        "run-all",
        "--in",
        str(dataset_path),
        "--cfg",
        str(cfg_path),
        "--out",
        str(out_dir),
        "--report",
        str(report_dir),
        "--seed",
        "7",
        "--gpu-mode",
        "cpu",
    ]
    assert cli_main(args) == 0
    results_path = report_dir / "results.md"
    assert results_path.exists()
    preproc_index = json.loads((out_dir / "fold_000" / "preproc" / "artifacts_index.json").read_text(encoding="utf-8"))
    entry_count = len(preproc_index.get("entries", []))
    first_results = results_path.read_text(encoding="utf-8")
    resume_args = args + ["--resume"]
    assert cli_main(resume_args) == 0
    preproc_index_after = json.loads((out_dir / "fold_000" / "preproc" / "artifacts_index.json").read_text(encoding="utf-8"))
    assert len(preproc_index_after.get("entries", [])) == entry_count
    second_results = results_path.read_text(encoding="utf-8")
    assert "閾値" in first_results
    assert "閾値" in second_results
