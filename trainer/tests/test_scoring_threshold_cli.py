"""Tests for threshold CLI behaviours."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd
import pytest

from trainer.logserver.scoring.threshold import ThresholdConfig, compute_threshold
from trainer.scripts import threshold as threshold_script


def _write_scores(path: Path, scores: list[float]) -> None:
    df = pd.DataFrame({"anomaly_score": scores})
    df.to_csv(path, index=False)


def _write_config(path: Path, processed_dir: Path) -> None:
    content = {
        "data": {"processed_dir": str(processed_dir)},
        "scoring": {"smoothing": "none"},
        "threshold": {"method": "quantile", "quantile": 0.5},
    }
    path.write_text(json.dumps(content), encoding="utf-8")


def test_compute_threshold_handles_nan_skip() -> None:
    threshold, meta = compute_threshold([float("nan"), float("nan")], ThresholdConfig())
    assert threshold is None
    assert meta["status"] == "skipped"
    assert meta["reason"] == "no_finite_scores"


def test_run_success_writes_outputs(tmp_path: Path) -> None:
    processed_dir = tmp_path / "processed"
    processed_dir.mkdir()
    scores_path = processed_dir / "scores.csv"
    _write_scores(scores_path, [0.1, 0.9])
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, processed_dir)

    payload = threshold_script.run(config_path, on_error="abort")

    threshold_file = processed_dir / "threshold.json"
    labels_file = processed_dir / "scores_with_labels.csv"
    assert threshold_file.exists()
    assert labels_file.exists()

    with threshold_file.open("r", encoding="utf-8") as handle:
        saved_meta = json.load(handle)
    assert saved_meta["status"] == "ok"
    assert saved_meta["anomaly_label_applied"] is True
    assert pytest.approx(saved_meta["threshold"], rel=1e-6) == 0.5
    with scores_path.open("rb") as handle:
        expected_hash = hashlib.sha256(handle.read()).hexdigest()
    assert saved_meta["data_sha256"] == expected_hash
    assert payload["scoring_config"] == {"smoothing": "none"}


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
