# -*- coding: utf-8 -*-
"""Tests for iterable session batching utilities."""

from __future__ import annotations

import numpy as np
import pytest
import torch
from torch.utils.data import DataLoader

from trainer.logserver.features.batching import (
    SessionDataset,
    SessionExample,
    build_sessions,
    make_collate_fn,
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
    delta_index = numeric_keys.index("delta_t")
    bos_index = 999
    collate_fn = make_collate_fn(target_mode="next", bos_index=bos_index, delta_index=delta_index)
    loader = DataLoader(dataset, batch_size=2, collate_fn=collate_fn, num_workers=0)

    batch = next(iter(loader))
    assert batch["events"].shape == (2, 4)
    assert batch["numeric"].shape[2] == len(numeric_keys)
    assert batch["mask"].dtype == torch.bool
    assert int(batch["mask"].sum()) == 5
    # verify padding uses PAD_INDEX=0 for shorter session
    assert batch["events"][1, -1].item() == 0
    assert batch["events"][0, 0].item() == bos_index
    assert torch.allclose(
        batch["delta_target"][0, :3],
        torch.tensor([0.0, 1.0, 0.5], dtype=torch.float32),
    )
    assert batch["delta_target"][0, 3].item() == pytest.approx(0.0)
    assert torch.allclose(
        batch["delta_target"][1, :2],
        torch.tensor([0.0, 0.25], dtype=torch.float32),
    )


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
    delta_index = numeric_keys.index("delta_t")
    collate_fn = make_collate_fn(target_mode="next", bos_index=123, delta_index=delta_index)
    loader = DataLoader(dataset, batch_size=1, collate_fn=collate_fn, num_workers=0)

    batch = next(iter(loader))
    assert batch["events"].shape == (1, length + 1)
    assert batch["numeric"].shape == (1, length + 1, len(numeric_keys))
    assert pytest.approx(batch["numeric"][0, 1, 0].item(), rel=1e-6) == 0.0
    expected_last = float((length - 1) / (total - 1))
    assert pytest.approx(batch["numeric"][0, -1, 0].item(), rel=1e-6) == expected_last
    # Ensure we only materialised one session worth of data
    assert int(batch["mask"].sum()) == length


def test_collate_next_mode_shifts_targets() -> None:
    collate_fn = make_collate_fn(target_mode="next", bos_index=7, delta_index=0)
    example = SessionExample(
        event_ids=np.array([10, 11, 12], dtype=np.int64),
        numeric=np.array(
            [
                [0.5, 1.0],
                [0.75, 1.5],
                [1.25, 2.0],
            ],
            dtype=np.float32,
        ),
        target_event=np.array([10, 11, 12], dtype=np.int64),
    )
    batch = collate_fn([example])
    assert torch.equal(batch["events"][0], torch.tensor([7, 10, 11, 12]))
    assert torch.equal(batch["targets"][0], torch.tensor([10, 11, 12, 0]))
    assert torch.equal(batch["mask"][0], torch.tensor([True, True, True, False]))
    assert torch.allclose(
        batch["delta_target"][0],
        torch.tensor([0.5, 0.75, 1.25, 0.0], dtype=torch.float32),
    )
    assert torch.allclose(batch["numeric"][0, 1:, 0], torch.tensor([0.5, 0.75, 1.25]))
    assert torch.allclose(batch["numeric"][0, 0], torch.zeros(2, dtype=torch.float32))


def test_collate_same_mode_preserves_alignment() -> None:
    collate_fn = make_collate_fn(target_mode="same", bos_index=3, delta_index=0)
    example = SessionExample(
        event_ids=np.array([1, 2], dtype=np.int64),
        numeric=np.array([[0.1], [0.2]], dtype=np.float32),
        target_event=np.array([1, 2], dtype=np.int64),
    )
    batch = collate_fn([example])
    assert torch.equal(batch["events"][0], torch.tensor([1, 2]))
    assert torch.equal(batch["targets"][0], torch.tensor([1, 2]))
    assert torch.equal(batch["mask"][0], torch.tensor([True, True]))
    assert torch.allclose(batch["delta_target"][0], torch.tensor([0.1, 0.2]))
