"""Tests for threshold CLI behaviours."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd
import pytest

from trainer.logserver.thresholds import ThresholdConfig, ThresholdStatus, resolve_threshold
from trainer.scripts import threshold as threshold_script


def _write_scores(
    path: Path,
    scores: list[float],
    annotations: list[int] | None = None,
    *,
    uid: str = "user-1",
    op_category: str = "READ",
) -> None:
    base_time = pd.Timestamp("2024-01-01T00:00:00Z")
    timestamps = [base_time + pd.Timedelta(seconds=i) for i in range(len(scores))]
    session_ids = ["session-1" for _ in scores]
    dt_values = [float("nan")] + [1.0 for _ in range(len(scores) - 1)]
    data = {
        "timestamp_utc": [ts.isoformat() for ts in timestamps],
        "uid": [uid for _ in scores],
        "session_id": session_ids,
        "op_category": [op_category for _ in scores],
        "anomaly_score": scores,
        "dt_sec": dt_values,
    }
    if annotations is not None:
        data["boundary_annotation"] = annotations
    df = pd.DataFrame(data)
    df.to_csv(path, index=False)


def _write_config(path: Path, processed_dir: Path) -> None:
    content = {
        "data": {"processed_dir": str(processed_dir)},
        "scoring": {"smoothing": "none"},
        "threshold": {
            "method": "quantile",
            "side": "upper",
            "transform": "score",
            "alpha": 0.5,
            "group_keys": ["uid", "op_category"],
            "normal_reference": "reference.csv",
        },
    }
    path.write_text(json.dumps(content), encoding="utf-8")


def _write_reference(path: Path, scores: list[float]) -> None:
    base_time = pd.Timestamp("2024-01-01T01:00:00Z")
    timestamps = [base_time + pd.Timedelta(seconds=i) for i in range(len(scores))]
    df = pd.DataFrame(
        {
            "timestamp_utc": [ts.isoformat() for ts in timestamps],
            "uid": ["user-1" for _ in scores],
            "session_id": ["session-ref" for _ in scores],
            "op_category": ["READ" for _ in scores],
            "anomaly_score": scores,
            "dt_sec": [float("nan")] + [1.0 for _ in range(len(scores) - 1)],
        }
    )
    df.to_csv(path, index=False)


def test_resolve_threshold_handles_nan_skip() -> None:
    result = resolve_threshold([float("nan"), float("nan")], ThresholdConfig(transform="score"), allow_small_sample=True)
    assert result.status == ThresholdStatus.SKIPPED
    assert result.fallback_reason == "no_finite_samples"


def test_run_success_writes_outputs(tmp_path: Path) -> None:
    processed_dir = tmp_path / "processed"
    processed_dir.mkdir()
    scores_path = processed_dir / "scores.csv"
    _write_scores(scores_path, [0.1, 0.9])
    reference_path = processed_dir / "reference.csv"
    _write_reference(reference_path, [0.05, 0.1, 0.2])
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, processed_dir)

    payload = threshold_script.run(config_path, on_error="abort")

    threshold_file = processed_dir / "threshold.json"
    labels_file = processed_dir / "scores_with_labels.csv"
    thresholds_file = processed_dir / "thresholds.json"
    assert threshold_file.exists()
    assert labels_file.exists()
    assert thresholds_file.exists()

    with threshold_file.open("r", encoding="utf-8") as handle:
        saved_meta = json.load(handle)
    assert saved_meta["status"] == "ok"
    assert saved_meta["anomaly_label_applied"] is True
    assert pytest.approx(saved_meta["threshold"], rel=1e-6) == 0.5
    assert saved_meta["reference_fpr"] == 0.0
    with scores_path.open("rb") as handle:
        expected_hash = hashlib.sha256(handle.read()).hexdigest()
    assert saved_meta["data_sha256"] == expected_hash
    assert payload["scoring_config"] == {"smoothing": "none"}

    with thresholds_file.open("r", encoding="utf-8") as handle:
        thresholds_meta = json.load(handle)
    assert thresholds_meta["thresholds"]
    global_entries = [entry for entry in thresholds_meta["thresholds"] if entry["group"] == []]
    assert len(global_entries) == 1
    assert pytest.approx(global_entries[0]["tau_hi"], rel=1e-6) == 0.5

    df_labels = pd.read_csv(labels_file)
    assert "anomaly_label" in df_labels.columns
    assert "tau_hi" in df_labels.columns
    assert df_labels["anomaly_label"].sum() >= 1


def test_run_skips_when_no_valid_scores(tmp_path: Path) -> None:
    processed_dir = tmp_path / "processed"
    processed_dir.mkdir()
    scores_path = processed_dir / "scores.csv"
    _write_scores(scores_path, [float("nan")])
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, processed_dir)

    payload = threshold_script.run(config_path, on_error="abort")

    assert payload["status"] == "skipped"
    threshold_file = processed_dir / "threshold.json"
    labels_file = processed_dir / "scores_with_labels.csv"
    assert threshold_file.exists()
    assert not labels_file.exists()
    with threshold_file.open("r", encoding="utf-8") as handle:
        saved_meta = json.load(handle)
    assert saved_meta["anomaly_label_applied"] is False
    assert saved_meta["threshold"] is None


def test_run_abort_removes_partial_outputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    processed_dir = tmp_path / "processed"
    processed_dir.mkdir()
    scores_path = processed_dir / "scores.csv"
    _write_scores(scores_path, [0.3, 0.7])
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, processed_dir)

    monkeypatch.setattr(threshold_script.json, "dump", lambda *args, **kwargs: (_ for _ in ()).throw(TypeError("boom")))

    with pytest.raises(TypeError):
        threshold_script.run(config_path, on_error="abort")

    assert not any(processed_dir.glob("*.partial"))
    assert not (processed_dir / "threshold.json").exists()
    assert not (processed_dir / "scores_with_labels.csv").exists()


def test_run_keep_partial_preserves_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    processed_dir = tmp_path / "processed"
    processed_dir.mkdir()
    scores_path = processed_dir / "scores.csv"
    _write_scores(scores_path, [0.2, 0.8])
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, processed_dir)

    monkeypatch.setattr(threshold_script.json, "dump", lambda *args, **kwargs: (_ for _ in ()).throw(TypeError("boom")))

    with pytest.raises(TypeError):
        threshold_script.run(config_path, on_error="keep-partial")

    partial_files = list(processed_dir.glob("*.partial"))
    assert partial_files, "partial files should be preserved"
    for path in partial_files:
        assert path.is_file()
    assert not (processed_dir / "threshold.json").exists()
    assert not (processed_dir / "scores_with_labels.csv").exists()


def test_run_dump_eval_and_hist(tmp_path: Path) -> None:
    processed_dir = tmp_path / "processed"
    processed_dir.mkdir()
    scores_path = processed_dir / "scores.csv"
    _write_scores(scores_path, [0.1, 0.9, 0.8, 0.2], annotations=[0, 1, 1, 0])
    reference_path = processed_dir / "reference.csv"
    _write_reference(reference_path, [0.05, 0.08, 0.12, 0.15])
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, processed_dir)

    eval_path = processed_dir / "boundary_eval.json"
    hist_path = processed_dir / "hist.json"

    payload = threshold_script.run(
        config_path,
        on_error="abort",
        dump_eval_path=eval_path,
        dump_hist_path=hist_path,
        hist_bins=4,
    )

    assert eval_path.exists()
    assert hist_path.exists()

    with eval_path.open("r", encoding="utf-8") as handle:
        eval_payload = json.load(handle)
    assert eval_payload["status"] == "ok"
    assert pytest.approx(eval_payload["metrics"]["f1"], rel=1e-6) == 1.0
    assert pytest.approx(eval_payload["metrics"]["jaccard"], rel=1e-6) == 1.0
    assert pytest.approx(eval_payload["metrics"]["variation_of_information"], rel=1e-6) == 0.0

    with hist_path.open("r", encoding="utf-8") as handle:
        hist_payload = json.load(handle)
    assert hist_payload["status"] == "ok"
    assert hist_payload["bins"] == 4
    assert len(hist_payload["counts"]) == 4
    assert len(hist_payload["bin_edges"]) == 5
    assert hist_payload["summary"]["count"] == 4
    assert payload["reference_fpr"] == 0.0


def test_run_dump_eval_missing_annotation(tmp_path: Path) -> None:
    processed_dir = tmp_path / "processed"
    processed_dir.mkdir()
    scores_path = processed_dir / "scores.csv"
    _write_scores(scores_path, [0.1, 0.9])
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, processed_dir)

    eval_path = processed_dir / "boundary_eval.json"

    threshold_script.run(
        config_path,
        on_error="abort",
        dump_eval_path=eval_path,
    )

    assert eval_path.exists()
    with eval_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    assert payload["status"] == "skipped"
    assert payload["reason"] == "annotation_column_missing"
