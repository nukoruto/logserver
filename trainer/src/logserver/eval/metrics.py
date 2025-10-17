"""Binary classification metrics utilities.

False Positive Rate (FPR) を含む評価指標を算出し、閾値設計段階の
キャリブレーションに利用する。SRS 10.1 の検知性能指標に準拠した
最小限のメトリクスセットを返す。
"""

from __future__ import annotations

from typing import Sequence


def _validate_binary_sequence(values: Sequence[int]) -> None:
    for value in values:
        if value not in (0, 1):
            raise ValueError("values must be binary (0 or 1)")


def _safe_ratio(numerator: float, denominator: float) -> float | None:
    if denominator == 0:
        return None
    return numerator / denominator


def compute_binary_classification_metrics(
    predicted: Sequence[int], actual: Sequence[int]
) -> dict[str, object]:
    """Compute confusion counts and derived metrics for binary labels."""

    if len(predicted) != len(actual):
        raise ValueError("predicted and actual must have the same length")

    _validate_binary_sequence(predicted)
    _validate_binary_sequence(actual)

    tp = fp = tn = fn = 0
    for pred, truth in zip(predicted, actual):
        if pred == 1 and truth == 1:
            tp += 1
        elif pred == 1 and truth == 0:
            fp += 1
        elif pred == 0 and truth == 0:
            tn += 1
        else:
            fn += 1

    tpr = _safe_ratio(tp, tp + fn)
    fpr = _safe_ratio(fp, fp + tn)
    tnr = _safe_ratio(tn, tn + fp)
    precision = _safe_ratio(tp, tp + fp)

    return {
        "counts": {
            "tp": tp,
            "fp": fp,
            "tn": tn,
            "fn": fn,
            "total": tp + fp + tn + fn,
        },
        "metrics": {
            "tpr": tpr,
            "fpr": fpr,
            "tnr": tnr,
            "precision": precision,
            "recall": tpr,
        },
    }


__all__ = ["compute_binary_classification_metrics"]
