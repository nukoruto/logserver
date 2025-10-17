"""Thresholding utilities for anomaly scores.

本モジュールは SRS 11.2 に基づき、分位点法と SPOT を含む複数の
閾値推定方式を統合的に扱い、目標偽陽性率 α へのキャリブレーションを
行う。閾値算出に際しては JSON メタ情報へ採用手法や経験的 α を記録し、
監査性を確保する。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np


@dataclass
class ThresholdConfig:
    method: str = "quantile"
    quantile: float = 0.995
    target_alpha: float = 0.005
    max_relative_deviation: float = 0.2
    fallback_methods: Tuple[str, ...] = ("quantile_adjust", "spot")
    spot_tail_fraction: float = 0.02
    min_tail_samples: int = 30


@dataclass(frozen=True)
class _ThresholdCandidate:
    """Intermediate representation for candidate thresholds."""

    method: str
    threshold: float
    empirical_alpha: float


def _tail_probability(values: np.ndarray, threshold: float) -> float:
    if values.size == 0:
        return 0.0
    return float(np.mean(values >= threshold))


def _quantile_threshold(values: np.ndarray, quantile: float) -> Optional[float]:
    if not 0.0 <= quantile <= 1.0:
        raise ValueError("quantile must be within [0, 1]")
    threshold = float(np.quantile(values, quantile))
    if not np.isfinite(threshold):
        return None
    return threshold


def _select_by_target_alpha(values: np.ndarray, target_alpha: float) -> Optional[_ThresholdCandidate]:
    if values.size == 0:
        return None
    if target_alpha < 0.0 or target_alpha > 1.0:
        raise ValueError("target_alpha must be within [0, 1]")
    sorted_values = np.sort(values)
    total = float(sorted_values.size)
    tail_counts = sorted_values.size - np.arange(sorted_values.size)
    tail_probs = tail_counts / total
    deltas = np.abs(tail_probs - target_alpha)
    idx = int(np.argmin(deltas))
    threshold = float(sorted_values[idx])
    empirical = float(tail_probs[idx])
    # allow strict zero false positives when feasible by slightly nudging above max
    if target_alpha == 0.0 and empirical > 0.0:
        threshold = math.nextafter(float(sorted_values[-1]), math.inf)
        empirical = _tail_probability(values, threshold)
    return _ThresholdCandidate(method="quantile_adjust", threshold=threshold, empirical_alpha=empirical)


def _spot_threshold(values: np.ndarray, config: ThresholdConfig) -> Optional[_ThresholdCandidate]:
    if values.size == 0:
        return None
    tail_fraction = min(max(config.spot_tail_fraction, 0.001), 0.5)
    sorted_values = np.sort(values)
    index = max(int(math.floor((1.0 - tail_fraction) * sorted_values.size)) - 1, 0)
    u = float(sorted_values[index])
    exceedances = values[values > u] - u
    if exceedances.size < config.min_tail_samples or exceedances.size == 0:
        return None
    mean_excess = float(np.mean(exceedances))
    if mean_excess <= 0.0:
        return None
    var_excess = float(np.var(exceedances))
    if var_excess <= 0.0:
        xi = 0.0
        beta = mean_excess
    else:
        ratio = mean_excess ** 2 / var_excess
        if ratio <= 1.0:
            xi = 0.0
            beta = mean_excess
        else:
            xi = 0.5 * (ratio - 1.0)
            beta = 0.5 * mean_excess * (ratio + 1.0)
    p_ref = exceedances.size / values.size
    q_star = max(config.target_alpha, 1e-12)
    if q_star >= p_ref:
        threshold = u
    else:
        if abs(xi) < 1e-8:
            threshold = u + beta * math.log(p_ref / q_star)
        else:
            threshold = u + (beta / xi) * ((p_ref / q_star) ** xi - 1.0)
    if not np.isfinite(threshold):
        return None
    empirical = _tail_probability(values, threshold)
    return _ThresholdCandidate(method="spot", threshold=float(threshold), empirical_alpha=empirical)


def _build_candidate(method: str, values: np.ndarray, config: ThresholdConfig) -> Optional[_ThresholdCandidate]:
    if method == "quantile":
        threshold = _quantile_threshold(values, config.quantile)
        if threshold is None:
            return None
        return _ThresholdCandidate(
            method="quantile",
            threshold=threshold,
            empirical_alpha=_tail_probability(values, threshold),
        )
    if method == "quantile_adjust":
        return _select_by_target_alpha(values, config.target_alpha)
    if method == "spot":
        return _spot_threshold(values, config)
    raise ValueError(f"Unsupported threshold method: {method}")


def _select_best_candidate(
    candidates: Sequence[_ThresholdCandidate], target_alpha: float
) -> Optional[_ThresholdCandidate]:
    if not candidates:
        return None
    if target_alpha < 0.0 or target_alpha > 1.0:
        raise ValueError("target_alpha must be within [0, 1]")
    best = None
    best_error = math.inf
    for candidate in candidates:
        error = abs(candidate.empirical_alpha - target_alpha)
        if error < best_error:
            best = candidate
            best_error = error
    return best


def compute_threshold(
    scores: Iterable[float], config: ThresholdConfig
) -> Tuple[Optional[float], Dict[str, object]]:
    values = np.asarray(list(scores), dtype=np.float64)
    total_count = int(values.size)
    if total_count == 0:
        meta = {
            "status": "skipped",
            "reason": "empty_scores",
            "method": config.method,
            "quantile": float(config.quantile),
            "input_count": 0,
            "valid_count": 0,
        }
        return None, meta

    finite_mask = np.isfinite(values)
    valid_values = values[finite_mask]
    valid_count = int(valid_values.size)
    base_meta: Dict[str, object] = {
        "method": config.method,
        "quantile": float(config.quantile),
        "input_count": total_count,
        "valid_count": valid_count,
    }
    if valid_count == 0:
        meta = {
            **base_meta,
            "status": "skipped",
            "reason": "no_finite_scores",
        }
        return None, meta

    candidates: List[_ThresholdCandidate] = []
    primary_candidate = _build_candidate(config.method, valid_values, config)
    if primary_candidate is None:
        meta = {
            **base_meta,
            "status": "skipped",
            "reason": "non_finite_threshold",
        }
        return None, meta
    candidates.append(primary_candidate)

    relative_error = math.inf
    if config.target_alpha > 0.0:
        relative_error = abs(primary_candidate.empirical_alpha - config.target_alpha) / config.target_alpha
    else:
        relative_error = abs(primary_candidate.empirical_alpha - config.target_alpha)

    if relative_error > config.max_relative_deviation:
        for method in config.fallback_methods:
            try:
                candidate = _build_candidate(method, valid_values, config)
            except ValueError:
                continue
            if candidate is not None:
                candidates.append(candidate)

    chosen = _select_best_candidate(candidates, config.target_alpha)
    if chosen is None:
        meta = {
            **base_meta,
            "status": "skipped",
            "reason": "no_valid_candidates",
        }
        return None, meta

    meta = {
        **base_meta,
        "status": "ok",
        "target_alpha": float(config.target_alpha),
        "empirical_alpha": float(chosen.empirical_alpha),
        "selected_method": chosen.method,
        "fallback_used": chosen.method != primary_candidate.method,
        "candidate_alphas": {candidate.method: float(candidate.empirical_alpha) for candidate in candidates},
    }
    return float(chosen.threshold), meta


def apply_threshold(values: Iterable[float], threshold: float) -> np.ndarray:
    arr = np.asarray(list(values), dtype=np.float32)
    return (arr >= threshold).astype(np.int32)
