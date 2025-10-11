# -*- coding: utf-8 -*-
"""Thresholding utilities for anomaly scores."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, Tuple

import numpy as np


@dataclass
class ThresholdConfig:
    method: str = "quantile"
    quantile: float = 0.995


def compute_threshold(scores: Iterable[float], config: ThresholdConfig) -> Tuple[float, Dict[str, float]]:
    values = np.asarray(list(scores), dtype=np.float32)
    if values.size == 0:
        raise ValueError("No scores provided for threshold computation")
    if config.method == "quantile":
        threshold = float(np.quantile(values, config.quantile))
        return threshold, {"method": config.method, "quantile": config.quantile}
    raise ValueError(f"Unsupported threshold method: {config.method}")


def apply_threshold(values: Iterable[float], threshold: float) -> np.ndarray:
    arr = np.asarray(list(values), dtype=np.float32)
    return (arr >= threshold).astype(np.int32)
