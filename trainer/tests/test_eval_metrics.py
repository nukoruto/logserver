from __future__ import annotations

import pytest

from trainer.logserver.eval.metrics import compute_binary_classification_metrics


def test_compute_binary_metrics_fpr_only_normals() -> None:
    predicted = [0, 1, 0, 1]
    actual = [0, 0, 0, 0]
    result = compute_binary_classification_metrics(predicted, actual)
    assert result["counts"]["fp"] == 2
    assert result["counts"]["tn"] == 2
    assert result["metrics"]["fpr"] == pytest.approx(0.5)
    assert result["metrics"]["tpr"] is None


def test_compute_binary_metrics_validates_binary_values() -> None:
    with pytest.raises(ValueError):
        compute_binary_classification_metrics([0, 2], [0, 0])

    with pytest.raises(ValueError):
        compute_binary_classification_metrics([0, 1], [0, -1])
