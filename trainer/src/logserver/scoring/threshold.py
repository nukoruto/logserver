# -*- coding: utf-8 -*-
"""Thresholding utilities for anomaly scores."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, Optional, Tuple

import numpy as np


@dataclass
class ThresholdConfig:
    method: str = "quantile"
    quantile: float = 0.995


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

    if config.method == "quantile":
        threshold = float(np.quantile(valid_values, config.quantile))
        if not np.isfinite(threshold):
            meta = {
                **base_meta,
                "status": "skipped",
                "reason": "non_finite_threshold",
            }
            return None, meta
        meta = {
            **base_meta,
            "status": "ok",
        }
        return threshold, meta
    raise ValueError(f"Unsupported threshold method: {config.method}")


def apply_threshold(values: Iterable[float], threshold: float) -> np.ndarray:
    arr = np.asarray(list(values), dtype=np.float32)
    return (arr >= threshold).astype(np.int32)
