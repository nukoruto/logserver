# -*- coding: utf-8 -*-
"""Tests for iterable session batching utilities."""

from __future__ import annotations

import numpy as np
import pytest
import torch
from torch.utils.data import DataLoader

from trainer.logserver.features.batching import (
    SessionDataset,
    build_sessions,
    collate_examples,
)


def test_iterable_session_dataset_minibatch() -> None:
    encoded = {
        "event_id": np.asarray([1, 2, 3, 4, 5], dtype=np.int64),
        "delta_t": np.asarray([0.0, 1.0, 0.5, 0.0, 0.25], dtype=np.float32),
        "latency": np.asarray([100, 110, 120, 130, 140], dtype=np.float32),
        "status": np.asarray([200, 200, 200, 404, 500], dtype=np.float32),
    }
    session_ids = ["s1", "s1", "s1", "s2", "s2"]
    slices, _, numeric_keys = build_sessions(encoded, session_ids, None)
    dataset = SessionDataset.from_encoded(encoded, slices, numeric_keys, shuffle=False, seed=123)
    loader = DataLoader(dataset, batch_size=2, collate_fn=collate_examples, num_workers=0)

    batch = next(iter(loader))
    assert batch["events"].shape == (2, 3)
    assert batch["numeric"].shape[2] == len(numeric_keys)
    assert batch["mask"].dtype == torch.bool
    assert int(batch["mask"].sum()) == 5
    # verify padding uses PAD_INDEX=0 for shorter session
    assert batch["events"][1, -1].item() == 0


def test_session_dataset_handles_large_stream(tmp_path) -> None:
    sessions = 4
    length = 250_000
    session_ids = np.repeat(np.array([f"s{i}" for i in range(sessions)], dtype=object), length)
    total = session_ids.shape[0]

    event_path = tmp_path / "event.npy"
    np.save(event_path, np.arange(total, dtype=np.int64))
    delta_path = tmp_path / "delta.npy"
    np.save(delta_path, np.linspace(0.0, 1.0, num=total, dtype=np.float32))
    latency_path = tmp_path / "latency.npy"
    np.save(latency_path, np.full(total, 100.0, dtype=np.float32))
    status_path = tmp_path / "status.npy"
    np.save(status_path, np.full(total, 200.0, dtype=np.float32))

    encoded = {
        "event_id": np.load(event_path, mmap_mode="r"),
        "delta_t": np.load(delta_path, mmap_mode="r"),
        "latency": np.load(latency_path, mmap_mode="r"),
        "status": np.load(status_path, mmap_mode="r"),
    }

    slices, _, numeric_keys = build_sessions(encoded, session_ids, None)
    dataset = SessionDataset.from_encoded(encoded, slices, numeric_keys, shuffle=False)
    loader = DataLoader(dataset, batch_size=1, collate_fn=collate_examples, num_workers=0)

    batch = next(iter(loader))
    assert batch["events"].shape == (1, length)
    assert batch["numeric"].shape == (1, length, len(numeric_keys))
    assert pytest.approx(batch["numeric"][0, 0, 0].item(), rel=1e-6) == 0.0
    expected_last = float((length - 1) / (total - 1))
    assert pytest.approx(batch["numeric"][0, -1, 0].item(), rel=1e-6) == expected_last
    # Ensure we only materialised one session worth of data
    assert int(batch["mask"].sum()) == length
