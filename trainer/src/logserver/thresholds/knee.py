"""Knee (elbow) detection thresholding."""

from __future__ import annotations

import math
from typing import Dict, Optional, Tuple

import numpy as np


def _normalize(values: np.ndarray) -> np.ndarray:
    vmin = float(values.min())
    vmax = float(values.max())
    if math.isclose(vmin, vmax):
        return np.zeros_like(values)
    return (values - vmin) / (vmax - vmin)


def _distance_from_line(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    x0, y0 = x[0], y[0]
    x1, y1 = x[-1], y[-1]
    denom = math.hypot(x1 - x0, y1 - y0)
    if denom == 0:
        return np.zeros_like(x)
    return np.abs((y1 - y0) * x - (x1 - x0) * y + x1 * y0 - y1 * x0) / denom


def _knee_single(
    values: np.ndarray,
    *,
    curve: str,
    normalize: bool,
) -> Tuple[Optional[float], Dict[str, float], Optional[str]]:
    if values.size == 0:
        return None, {"status": "skipped", "reason": "empty_values"}, "empty_values"
    clean = np.sort(values[np.isfinite(values)])
    if clean.size < 3:
        return None, {"status": "skipped", "reason": "too_few_samples"}, "too_few_samples"
    if math.isclose(float(clean.min()), float(clean.max())):
        return None, {"status": "skipped", "reason": "degenerate"}, "degenerate"

    if curve == "cdf":
        x = clean
        y = np.linspace(1.0 / clean.size, 1.0, num=clean.size)
    elif curve == "sorted":
        x = np.linspace(0.0, float(clean.size - 1), num=clean.size)
        y = clean
    else:
        raise ValueError("curve must be 'cdf' or 'sorted'")

    if normalize:
        x = _normalize(x)
        y = _normalize(y)

    distances = _distance_from_line(x, y)
    idx = int(np.argmax(distances))
    max_distance = float(distances[idx])
    if math.isclose(max_distance, 0.0, abs_tol=1e-8):
        return None, {"status": "skipped", "reason": "flat_curve"}, "flat_curve"

    tau = float(clean[idx])
    details: Dict[str, float] = {
        "curve": curve,
        "normalize": float(True) if normalize else float(False),
        "distance_max": max_distance,
        "index": float(idx),
    }
    return tau, details, None


def knee_threshold(
    values: np.ndarray,
    *,
    curve: str = "cdf",
    normalize: bool = True,
    side: str,
) -> Tuple[Optional[float], Optional[float], Dict[str, float], Optional[str]]:
    if values.size == 0:
        return None, None, {"status": "skipped", "reason": "empty_values"}, "empty_values"

    tau_hi: Optional[float] = None
    tau_lo: Optional[float] = None
    details: Dict[str, float] = {}
    fallback_reason: Optional[str] = None

    if side in {"upper", "both"}:
        tau_hi, hi_details, reason = _knee_single(values, curve=curve, normalize=normalize)
        details.update({f"upper_{k}": v for k, v in hi_details.items()})
        if reason is not None:
            fallback_reason = reason if fallback_reason is None else fallback_reason
    if side in {"lower", "both"}:
        mirrored = -values
        tau_lo_mirror, lo_details, reason = _knee_single(mirrored, curve=curve, normalize=normalize)
        if tau_lo_mirror is not None:
            tau_lo = -float(tau_lo_mirror)
        details.update({f"lower_{k}": v for k, v in lo_details.items()})
        if reason is not None:
            fallback_reason = reason if fallback_reason is None else fallback_reason

    return tau_hi, tau_lo, details, fallback_reason
