"""Quantile-based thresholding supporting both tails."""

from __future__ import annotations

from typing import Dict, Optional, Tuple

import numpy as np


def quantile_threshold(
    values: np.ndarray,
    *,
    alpha: float,
    side: str,
    method: str = "linear",
) -> Tuple[Optional[float], Optional[float], Dict[str, float]]:
    if values.size == 0:
        return None, None, {"status": "skipped", "reason": "empty_values"}
    if not 0.0 <= alpha <= 1.0:
        raise ValueError("alpha must be within [0, 1]")
    if side not in {"upper", "lower", "both"}:
        raise ValueError("side must be one of {'upper', 'lower', 'both'}")

    tau_hi: Optional[float] = None
    tau_lo: Optional[float] = None
    details: Dict[str, float] = {"alpha": float(alpha)}

    if side in {"upper", "both"}:
        q_hi = float(np.quantile(values, 1.0 - alpha, method=method))
        tau_hi = q_hi
        details["quantile_hi"] = q_hi
    if side in {"lower", "both"}:
        q_lo = float(np.quantile(values, alpha, method=method))
        tau_lo = q_lo
        details["quantile_lo"] = q_lo

    return tau_hi, tau_lo, details
