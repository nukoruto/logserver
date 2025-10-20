"""Otsu thresholding on log-domain Δt distributions."""

from __future__ import annotations

import math
from typing import Dict, Optional, Tuple

import numpy as np

from . import _compute_bins


def _otsu_single(values: np.ndarray, bins: int | str | None) -> Tuple[Optional[float], Dict[str, float], Optional[str]]:
    if values.size == 0:
        return None, {"status": "skipped", "reason": "empty_values"}, "empty_values"
    if not np.isfinite(values).any():
        return None, {"status": "skipped", "reason": "non_finite"}, "non_finite"

    clean = np.sort(values[np.isfinite(values)])
    if clean.size < 2 or math.isclose(float(clean.min()), float(clean.max())):
        return None, {"status": "skipped", "reason": "degenerate"}, "degenerate"

    hist_bins = _compute_bins(clean, bins)
    counts, edges = np.histogram(clean, bins=hist_bins)
    total = counts.sum()
    if total == 0:
        return None, {"status": "skipped", "reason": "empty_hist"}, "empty_hist"
    if counts.size > 2:
        kernel = np.array([1.0, 1.0, 1.0], dtype=np.float64)
        smoothed = np.convolve(counts.astype(np.float64), kernel / kernel.sum(), mode="same")
        interior = smoothed[1:-1]
        peaks = int(np.sum((interior > smoothed[:-2]) & (interior >= smoothed[2:])))
        if peaks < 2:
            details = {"bins": int(hist_bins), "peaks": peaks}
            return None, details, "unimodal"

    probabilities = counts / total
    cumulative_prob = np.cumsum(probabilities)
    cumulative_mean = np.cumsum(probabilities * (edges[:-1] + edges[1:]) / 2.0)
    global_mean = cumulative_mean[-1]
    global_var = float(np.var(clean))
    if global_var <= 1e-12:
        return None, {"status": "skipped", "reason": "degenerate_variance"}, "degenerate_variance"

    between_class_variance = (
        (global_mean * cumulative_prob - cumulative_mean) ** 2
        / (cumulative_prob * (1.0 - cumulative_prob) + 1e-12)
    )
    idx = int(np.argmax(between_class_variance))
    if idx == 0 or idx == probabilities.size - 1:
        details = {
            "bins": int(hist_bins),
            "between_class_variance": float(between_class_variance[idx]),
        }
        return None, details, "no_separation"
    if float(between_class_variance[idx]) <= 1e-12:
        details = {
            "bins": int(hist_bins),
            "between_class_variance": float(between_class_variance[idx]),
        }
        return None, details, "no_variance"
    if float(between_class_variance[idx]) / (global_var + 1e-12) < 0.2:
        details = {
            "bins": int(hist_bins),
            "between_class_variance": float(between_class_variance[idx]),
        }
        return None, details, "low_contrast"
    threshold_domain = (edges[idx] + edges[idx + 1]) / 2.0

    details = {
        "bins": int(hist_bins),
        "between_class_variance": float(between_class_variance[idx]),
        "threshold_domain": float(threshold_domain),
    }
    return float(threshold_domain), details, None


def otsu_threshold(
    values: np.ndarray,
    *,
    bins: int | str | None = "fd",
    side: str,
) -> Tuple[Optional[float], Optional[float], Dict[str, float], Optional[str]]:
    if values.size == 0:
        return None, None, {"status": "skipped", "reason": "empty_values"}, "empty_values"

    tau_hi: Optional[float] = None
    tau_lo: Optional[float] = None
    fallback_reason: Optional[str] = None

    details: Dict[str, float] = {}

    if side in {"upper", "both"}:
        tau_hi, upper_details, reason = _otsu_single(values, bins)
        details.update({f"upper_{k}": v for k, v in upper_details.items()})
        if reason is not None:
            fallback_reason = reason if fallback_reason is None else fallback_reason
    if side in {"lower", "both"}:
        mirrored = -values
        tau_lo_mirror, lower_details, reason = _otsu_single(mirrored, bins)
        if tau_lo_mirror is not None:
            tau_lo = -float(tau_lo_mirror)
        details.update({f"lower_{k}": v for k, v in lower_details.items()})
        if reason is not None:
            fallback_reason = reason if fallback_reason is None else fallback_reason

    return tau_hi, tau_lo, details, fallback_reason
