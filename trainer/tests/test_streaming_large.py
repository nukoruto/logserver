# -*- coding: utf-8 -*-
"""Large scale streaming tests for sessionization and scoring."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Dict, Iterable

import numpy as np
import pandas as pd
import pytest

from trainer.logserver.dataio.sessionize import SessionConfig, sessionize
from trainer.logserver.dataio.processed import load_processed_events
from trainer.scripts import score as score_cli
from trainer.logserver.features.encoders import (
    ContinuousNormalizer,
    EventVocabulary,
    FeaturePack,
)
from trainer.logserver.scoring.anomaly import ScoringConfig

try:  # pragma: no cover - optional module check
    import resource
except ImportError:  # pragma: no cover - Windows fallback
    resource = None  # type: ignore[assignment]


ROWS = 1_000_000
CHUNKSIZE = 200_000
MEMORY_LIMIT_KB = 1_200_000
TIME_LIMIT_SECONDS = 180.0


def _make_large_raw_csv(path: Path, rows: int = ROWS) -> None:
    rng = np.random.default_rng(42)
    timestamps = pd.date_range("2024-01-01", periods=rows, freq="s", tz="UTC")
    events = np.array(["login", "view", "edit", "logout"], dtype=object)
    event_seq = events[rng.integers(0, len(events), size=rows)]
    uids = np.array([f"user_{i % 1000}" for i in range(rows)], dtype=object)
    df = pd.DataFrame(
        {
            "timestamp": timestamps,
            "uid": uids,
            "event": event_seq,
            "latency_ms": rng.integers(50, 150, size=rows),
            "status": np.full(rows, 200, dtype=np.int32),
            "response_bytes": rng.integers(256, 4096, size=rows),
        }
    )
    df.to_csv(path, index=False)


def _read_total_rows(iterator: Iterable[pd.DataFrame]) -> int:
    total = 0
    for frame in iterator:
        total += len(frame)
    return total


@pytest.fixture(scope="module")
def large_raw_dataset(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("large_raw") / "raw.csv"
    _make_large_raw_csv(path)
    return path


def test_sessionize_streaming_large(tmp_path: Path, large_raw_dataset: Path) -> None:
    pytest.importorskip("pyarrow")
    raw_path = large_raw_dataset
    processed_dir = tmp_path / "processed"
    config = SessionConfig(idle_timeout=1800, tz="UTC", chunksize=CHUNKSIZE, use_pyarrow=True)
    start_time = time.perf_counter()
    start_mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource else 0
    sessionize(raw_path, processed_dir, config, collect_output=False)
    duration = time.perf_counter() - start_time
    end_mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource else start_mem
    assert duration < TIME_LIMIT_SECONDS
    if resource:
        assert end_mem < MEMORY_LIMIT_KB
    assert (processed_dir / "events.csv").exists()
    iterator = load_processed_events(processed_dir, chunksize=CHUNKSIZE, use_pyarrow=True, collect=False)
    assert _read_total_rows(iterator) == ROWS


class _DummyScorer:
    def __init__(self, pack: FeaturePack):
        self.feature_pack = pack

    @classmethod
    def from_run(cls, run_dir: Path, config: ScoringConfig) -> "_DummyScorer":
        vocab = EventVocabulary()
        for token in ["<pad>", "<unk>", "login", "view", "edit", "logout"]:
            vocab.add_token(token)
        delta_norm = ContinuousNormalizer(mean=1.0, std=1.0)
        latency_norm = ContinuousNormalizer(mean=100.0, std=10.0)
        pack = FeaturePack(
            event_vocab=vocab,
            delta_normalizer=delta_norm,
            latency_normalizer=latency_norm,
            delta_epsilon=1e-6,
            numeric_features=["delta_t", "latency", "status"],
            feature_sources={"delta_t": "delta_t", "latency": "latency_ms", "status": "status"},
            additional_normalizers={},
        )
        return cls(pack)

    def score(self, encoded: Dict[str, np.ndarray], session_ids: Iterable[str]) -> Dict[str, np.ndarray]:
        session_map: Dict[str, list[int]] = {}
        for index, session_id in enumerate(session_ids):
            session_map.setdefault(str(session_id), []).append(index)
        scores: Dict[str, np.ndarray] = {}
        for session_id, indices in session_map.items():
            scores[session_id] = np.full(len(indices), 0.5, dtype=np.float32)
        return scores


def test_score_streaming_large(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    large_raw_dataset: Path,
) -> None:
    pytest.importorskip("pyarrow")
    raw_path = large_raw_dataset
    processed_dir = tmp_path / "processed"
    runs_dir = tmp_path / "runs" / "latest"
    runs_dir.mkdir(parents=True)
    session_config = SessionConfig(idle_timeout=1800, tz="UTC", chunksize=CHUNKSIZE, use_pyarrow=True)
    sessionize(raw_path, processed_dir, session_config, collect_output=False)
    monkeypatch.setattr(score_cli.AnomalyScorer, "from_run", classmethod(lambda cls, run_dir, config: _DummyScorer.from_run(run_dir, config)))
    config_path = tmp_path / "config.yaml"
    yaml_payload = "data:\n  processed_dir: {}\nlogging:\n  dir: {}\n  level: INFO\nscoring:\n  device: cpu\n  smoothing_window: 1\n  chunksize: {}\n  use_pyarrow: true\n".format(
        processed_dir.as_posix(),
        (tmp_path / "runs").as_posix(),
        CHUNKSIZE,
    )
    config_path.write_text(yaml_payload, encoding="utf-8")
    start_time = time.perf_counter()
    start_mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource else 0
    score_cli.main(config_path)
    duration = time.perf_counter() - start_time
    end_mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource else start_mem
    assert duration < TIME_LIMIT_SECONDS
    if resource:
        assert end_mem < MEMORY_LIMIT_KB
    scores_path = processed_dir / "scores.csv"
    assert scores_path.exists()
    head = pd.read_csv(scores_path, nrows=5)
    assert "anomaly_score" in head.columns
    iterator = load_processed_events(processed_dir, chunksize=CHUNKSIZE, use_pyarrow=True, collect=False)
    assert _read_total_rows(iterator) == ROWS
