"""Unit tests for temperature scaling helpers."""

from __future__ import annotations

import sys

import pytest
import torch

PACKAGE_SRC = __import__("pathlib").Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm.calibrate import _ece_from_logits, _search_temperature  # noqa: E402  pylint: disable=protected-access,wrong-import-position


torch = pytest.importorskip("torch")  # type: ignore  # noqa: E305


def test_temperature_scaling_reduces_overconfidence() -> None:
    """過度な自信を持つロジットに対して温度スケーリングが ECE を改善する。"""

    logits = torch.tensor([[5.0, 1.0], [4.0, 0.5], [3.5, 0.2]], dtype=torch.float32)
    targets = torch.tensor([0, 1, 1], dtype=torch.long)
    base = _ece_from_logits(logits.view(1, 3, 2), targets.view(1, 3), temperature=1.0, bins=5)
    hot = _ece_from_logits(logits.view(1, 3, 2), targets.view(1, 3), temperature=2.0, bins=5)
    cold = _ece_from_logits(logits.view(1, 3, 2), targets.view(1, 3), temperature=0.5, bins=5)

    assert hot <= base + 1e-6
    assert cold >= base - 1e-6

    best_temp, best_ece = _search_temperature(logits.view(1, 3, 2), targets.view(1, 3), bins=5)
    assert 0.05 <= best_temp <= 10.0000001
    assert best_ece <= base + 1e-6
