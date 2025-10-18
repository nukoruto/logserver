"""Unit tests for batching and masking behaviour."""

from __future__ import annotations

import sys

import numpy as np
import pytest
import torch

PACKAGE_SRC = __import__("pathlib").Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm.data import collate_batch  # noqa: E402  pylint: disable=wrong-import-position


torch = pytest.importorskip("torch")  # type: ignore  # noqa: E305


def test_collate_batch_generates_padding_and_mask() -> None:
    """collate_batch が可変長系列のマスクとパディングを正しく生成する。"""

    seq1 = {
        "events": np.array([1, 2, 3], dtype=np.int64),
        "targets": np.array([2, 3, 4], dtype=np.int64),
        "numeric": np.array([[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]], dtype=np.float32),
        "delta": np.array([0.5, 0.7, 0.9], dtype=np.float32),
        "censor": np.array([False, True, False], dtype=bool),
    }
    seq2 = {
        "events": np.array([4], dtype=np.int64),
        "targets": np.array([1], dtype=np.int64),
        "numeric": np.array([[0.9, 1.1]], dtype=np.float32),
        "delta": np.array([1.5], dtype=np.float32),
        "censor": np.array([True], dtype=bool),
    }

    batch = collate_batch([seq1, seq2])

    assert batch["events"].shape == (2, 3)
    assert batch["numeric"].shape == (2, 3, 2)
    assert batch["targets"].shape == (2, 3)
    assert batch["delta"].shape == (2, 3)
    assert batch["censor"].dtype == torch.bool
    assert batch["mask"].dtype == torch.bool

    expected_mask = torch.tensor([[True, True, True], [True, False, False]])
    assert torch.equal(batch["mask"], expected_mask)
    assert torch.equal(batch["censor"], torch.tensor([[False, True, False], [True, False, False]]))
    assert torch.allclose(batch["numeric"][1, 1:], torch.zeros(2, dtype=torch.float32))
    assert torch.equal(batch["targets"][1, 1:], torch.zeros(2, dtype=torch.long))
