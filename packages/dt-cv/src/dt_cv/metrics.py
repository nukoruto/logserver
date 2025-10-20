"""Metric computation helpers for dt-cv."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Mapping

import json

import numpy as np
import pandas as pd
from scipy.stats import chi2
from sklearn.metrics import average_precision_score, roc_auc_score


@dataclass
class MethodMetrics:
    """Evaluation metrics for a single method."""

    average_precision: float
    roc_auc: float | None

    def to_dict(self) -> Dict[str, float | None]:
        return {
            "average_precision": float(self.average_precision),
            "roc_auc": None if self.roc_auc is None else float(self.roc_auc),
        }


def _safe_roc_auc(labels: np.ndarray, scores: np.ndarray) -> float | None:
    if np.unique(labels).size < 2:
        return None
    return float(roc_auc_score(labels, scores))


def neglog10_to_prob(value: np.ndarray) -> np.ndarray:
    """Convert -log10(p) scores to probability space."""

    return np.clip(np.power(10.0, -np.asarray(value, dtype=float)), 1e-300, 1.0)


def fisher_neglog10(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Combine two -log10(p) scores using Fisher's method."""

    p_a = neglog10_to_prob(a)
    p_b = neglog10_to_prob(b)
    stat = -2.0 * (np.log(p_a) + np.log(p_b))
    combined_p = chi2.sf(stat, df=4)
    combined_p = np.clip(combined_p, 1e-300, 1.0)
    return -np.log10(combined_p)


def compute_metrics(labels: np.ndarray, scores: Mapping[str, np.ndarray]) -> Mapping[str, MethodMetrics]:
    """Compute metrics for each method."""

    results: Dict[str, MethodMetrics] = {}
    for name, score_array in scores.items():
        ap = float(average_precision_score(labels, score_array))
        roc = _safe_roc_auc(labels, score_array)
        results[name] = MethodMetrics(ap, roc)
    return results


def save_metrics(path: Path, metrics: Mapping[str, MethodMetrics]) -> None:
    payload = {name: metric.to_dict() for name, metric in metrics.items()}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def save_scores(path: Path, frame: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(path, index=False, lineterminator="\n")
