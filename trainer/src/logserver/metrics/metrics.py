"""Robust metric utilities for deterministic cross-validation."""

from __future__ import annotations

import dataclasses
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence, Tuple

import numpy as np


def deterministic_hash(value: Any) -> str:
    """Return a SHA-256 hash for arbitrary JSON-serialisable objects."""

    normalised = json.dumps(value, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(normalised.encode("utf-8")).hexdigest()
    return digest


@dataclass(frozen=True)
class AggregatorConfig:
    name: str = "mean"
    lambda_std: float = 0.0
    trim_ratio: float = 0.1


@dataclass(frozen=True)
class ObjectiveConfig:
    primary: str = "AP"
    aggregator: AggregatorConfig = dataclasses.field(default_factory=AggregatorConfig)
    f1_selection: Mapping[str, Any] = dataclasses.field(default_factory=dict)


@dataclass(frozen=True)
class SearchExecutionConfig:
    n_trials: int = 10
    base_seed: int = 42
    parallel: int = 1
    resume: bool = False
    dedup: bool = False


@dataclass(frozen=True)
class SearchDeviceConfig:
    gpu_mode: str = "auto"


@dataclass(frozen=True)
class FoldMetric:
    ap: float
    roc_auc: float
    f1: float
    threshold: float
    precision: float
    recall: float
    n_pos: int
    n_neg: int
    valid_ap: bool
    valid_roc_auc: bool
    valid_f1: bool


@dataclass(frozen=True)
class AggregatedMetric:
    mean: float
    std: float
    n_valid: int
    aggregate_value: float


@dataclass(frozen=True)
class MetricSummary:
    metrics: Mapping[str, AggregatedMetric]
    objective_value: float


class TrialStatus:
    OK = "ok"
    INVALID = "invalid"
    FAILED = "failed"
    SKIPPED = "skipped"


def _ensure_numpy(array: Sequence[float]) -> np.ndarray:
    if isinstance(array, np.ndarray):
        return array.astype(float, copy=False)
    return np.asarray(list(array), dtype=float)


def safe_average_precision(y_true: Sequence[int], y_score: Sequence[float]) -> Tuple[float, bool]:
    labels = _ensure_numpy(y_true).astype(int)
    positives = int(np.sum(labels == 1))
    if positives == 0:
        return float("nan"), False
    scores = _ensure_numpy(y_score)
    order = np.argsort(-scores, kind="mergesort")
    sorted_labels = labels[order]
    cumulative_tp = np.cumsum(sorted_labels == 1)
    cumulative_fp = np.cumsum(sorted_labels == 0)
    precision = cumulative_tp / np.maximum(cumulative_tp + cumulative_fp, 1)
    recall = cumulative_tp / positives
    delta_recall = np.diff(np.r_[0.0, recall])
    ap = float(np.sum(precision * delta_recall))
    return ap, True


def safe_roc_auc(y_true: Sequence[int], y_score: Sequence[float]) -> Tuple[float, bool]:
    labels = _ensure_numpy(y_true).astype(int)
    uniques = np.unique(labels)
    if uniques.size < 2:
        return float("nan"), False
    scores = _ensure_numpy(y_score)
    order = np.argsort(scores, kind="mergesort")
    sorted_scores = scores[order]
    ranks = np.empty_like(scores, dtype=float)
    start = 0
    n_scores = sorted_scores.size
    while start < n_scores:
        end = start + 1
        while end < n_scores and sorted_scores[end] == sorted_scores[start]:
            end += 1
        average_rank = 0.5 * ((start + 1) + end)
        ranks[order[start:end]] = average_rank
        start = end
    pos = labels == 1
    neg = ~pos
    n_pos = int(pos.sum())
    n_neg = int(neg.sum())
    sum_ranks = float(ranks[pos].sum())
    auc = (sum_ranks - n_pos * (n_pos + 1) / 2.0) / max(n_pos * n_neg, 1)
    return auc, True


def select_f1_threshold(y_true: Sequence[int], y_score: Sequence[float]) -> Tuple[float, float, float, float]:
    labels = _ensure_numpy(y_true).astype(int)
    positives = int(np.sum(labels == 1))
    if positives == 0:
        return float("nan"), float("nan"), 0.0, 0.0

    scores = _ensure_numpy(y_score)
    unique_scores = np.unique(scores)
    candidate_thresholds = list(sorted(unique_scores, reverse=True))
    candidate_thresholds.extend([1.0, 0.0, float('-inf')])
    candidate_thresholds = sorted(set(candidate_thresholds), reverse=True)
    best_f1 = -1.0
    best_threshold = float('inf')
    best_prec = 0.0
    best_rec = 0.0
    for theta in candidate_thresholds:
        predicted = scores >= theta
        tp = int(np.sum((predicted == 1) & (labels == 1)))
        fp = int(np.sum((predicted == 1) & (labels == 0)))
        fn = int(np.sum((predicted == 0) & (labels == 1)))
        if tp == 0:
            f1 = 0.0
            precision = 0.0
            recall = 0.0
        else:
            precision = tp / (tp + fp)
            recall = tp / (tp + fn)
            f1 = 2 * precision * recall / max(precision + recall, 1e-12)
        if (f1 > best_f1) or (np.isclose(f1, best_f1) and theta < best_threshold):
            best_f1 = f1
            best_threshold = theta
            best_prec = precision
            best_rec = recall
    if not np.isfinite(best_threshold):
        best_threshold = float('nan')
    return float(best_threshold), float(best_f1), float(best_prec), float(best_rec)


def safe_f1_at_best_threshold(
    y_true: Sequence[int], y_score: Sequence[float]
) -> Tuple[float, float, float, float, bool]:
    labels = _ensure_numpy(y_true).astype(int)
    positives = int(np.sum(labels == 1))
    if positives == 0:
        return float("nan"), float("nan"), 0.0, 0.0, False
    theta, f1, precision, recall = select_f1_threshold(labels, y_score)
    return f1, theta, precision, recall, True


def compute_aggregate(values: Iterable[float], cfg: AggregatorConfig) -> AggregatedMetric:
    filtered = np.asarray([value for value in values if np.isfinite(value)], dtype=float)
    if filtered.size == 0:
        return AggregatedMetric(mean=float("nan"), std=float("nan"), n_valid=0, aggregate_value=float("nan"))
    mean = float(filtered.mean())
    std = float(filtered.std(ddof=0))
    name = cfg.name.lower()
    if name == "mean":
        aggregate_value = mean
    elif name == "mean_minus_std":
        aggregate_value = mean - cfg.lambda_std * std
    elif name == "worst_case":
        aggregate_value = float(filtered.min())
    elif name == "trimmed_mean":
        ratio = min(max(cfg.trim_ratio, 0.0), 0.5)
        if ratio > 0 and filtered.size > 0:
            trimmed = np.sort(filtered)
            n = trimmed.size
            k = int(np.floor(n * ratio))
            if k > 0:
                trimmed = trimmed[k:n - k]
            aggregate_value = float(trimmed.mean()) if trimmed.size > 0 else float("nan")
        else:
            aggregate_value = mean
    else:
        raise ValueError(f"Unsupported aggregator '{cfg.name}'")
    return AggregatedMetric(mean=mean, std=std, n_valid=int(filtered.size), aggregate_value=float(aggregate_value))


def summarise_metrics(
    fold_metrics: Sequence[FoldMetric],
    cfg: AggregatorConfig,
    primary_metric: str,
) -> MetricSummary:
    ap_values = [metric.ap for metric in fold_metrics if metric.valid_ap]
    roc_values = [metric.roc_auc for metric in fold_metrics if metric.valid_roc_auc]
    f1_values = [metric.f1 for metric in fold_metrics if metric.valid_f1]
    ap_summary = compute_aggregate(ap_values, cfg)
    roc_summary = compute_aggregate(roc_values, cfg)
    f1_summary = compute_aggregate(f1_values, cfg)
    summaries = {
        "AP": ap_summary,
        "ROC_AUC": roc_summary,
        "F1": f1_summary,
    }
    primary_key = primary_metric.upper()
    if primary_key not in summaries:
        raise ValueError(f"Unsupported primary metric '{primary_metric}'")
    objective_value = summaries[primary_key].aggregate_value
    return MetricSummary(metrics=summaries, objective_value=objective_value)
