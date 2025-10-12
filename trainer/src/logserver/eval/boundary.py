"""Boundary detection evaluation metrics."""

from __future__ import annotations

from dataclasses import dataclass
from math import log2
from typing import Iterable, Sequence


@dataclass(frozen=True)
class BoundaryCounts:
    """Confusion matrix style counts for boundary detection."""

    true_positive: int
    false_positive: int
    true_negative: int
    false_negative: int

    @property
    def support(self) -> int:
        return self.true_positive + self.false_positive + self.true_negative + self.false_negative

    @property
    def predicted_positive(self) -> int:
        return self.true_positive + self.false_positive

    @property
    def predicted_negative(self) -> int:
        return self.true_negative + self.false_negative

    @property
    def actual_positive(self) -> int:
        return self.true_positive + self.false_negative

    @property
    def actual_negative(self) -> int:
        return self.true_negative + self.false_positive


def _entropy(probabilities: Iterable[float]) -> float:
    entropy = 0.0
    for p in probabilities:
        if p > 0.0:
            entropy -= p * log2(p)
    return entropy


def _variation_of_information(counts: BoundaryCounts) -> float | None:
    total = counts.support
    if total == 0:
        return None

    # confusion matrix where rows are predicted label {0, 1} and columns are true label {0, 1}
    matrix = (
        (counts.true_negative, counts.false_negative),
        (counts.false_positive, counts.true_positive),
    )

    row_totals = [sum(row) for row in matrix]
    col_totals = [matrix[0][idx] + matrix[1][idx] for idx in range(2)]

    if all(total == 0 for total in row_totals) or all(total == 0 for total in col_totals):
        return 0.0

    row_probs = [value / total for value in row_totals]
    col_probs = [value / total for value in col_totals]
    joint_probs = [[value / total for value in row] for row in matrix]

    mutual_information = 0.0
    for i in range(2):
        for j in range(2):
            p_ij = joint_probs[i][j]
            if p_ij == 0.0:
                continue
            denom = row_probs[i] * col_probs[j]
            if denom == 0.0:
                continue
            mutual_information += p_ij * log2(p_ij / denom)

    entropy_pred = _entropy(row_probs)
    entropy_true = _entropy(col_probs)
    return entropy_pred + entropy_true - 2.0 * mutual_information


def _compute_counts(predicted: Sequence[int], actual: Sequence[int]) -> BoundaryCounts:
    if len(predicted) != len(actual):
        raise ValueError("predicted and actual must have the same length")

    tp = fp = tn = fn = 0
    for pred, truth in zip(predicted, actual):
        if truth not in (0, 1) or pred not in (0, 1):
            raise ValueError("predicted and actual values must be binary (0 or 1)")
        if pred == 1 and truth == 1:
            tp += 1
        elif pred == 1 and truth == 0:
            fp += 1
        elif pred == 0 and truth == 0:
            tn += 1
        else:
            fn += 1
    return BoundaryCounts(true_positive=tp, false_positive=fp, true_negative=tn, false_negative=fn)


def _safe_ratio(numerator: float, denominator: float) -> float | None:
    if denominator == 0:
        return None
    return numerator / denominator


def compute_boundary_metrics(predicted: Sequence[int], actual: Sequence[int]) -> dict[str, object]:
    """Compute boundary detection metrics.

    Returns a dictionary ready for JSON serialisation with counts and metrics
    such as F1, Jaccard (IoU), and Variation of Information.
    """

    counts = _compute_counts(predicted, actual)

    tp = counts.true_positive
    fp = counts.false_positive
    fn = counts.false_negative

    f1 = None
    jaccard = None

    if counts.actual_positive == 0 and counts.predicted_positive == 0:
        f1 = 1.0
        jaccard = 1.0
    else:
        f1 = _safe_ratio(2.0 * tp, 2.0 * tp + fp + fn)
        jaccard = _safe_ratio(tp, tp + fp + fn)

    vi = _variation_of_information(counts)

    return {
        "counts": {
            "tp": tp,
            "fp": fp,
            "tn": counts.true_negative,
            "fn": fn,
        },
        "support": {
            "total": counts.support,
            "predicted_positive": counts.predicted_positive,
            "predicted_negative": counts.predicted_negative,
            "actual_positive": counts.actual_positive,
            "actual_negative": counts.actual_negative,
        },
        "metrics": {
            "f1": f1,
            "jaccard": jaccard,
            "variation_of_information": vi,
        },
    }
