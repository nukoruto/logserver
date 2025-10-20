"""Backward compatible wrapper for threshold utilities."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, Optional, Tuple

import numpy as np

from trainer.logserver.thresholds import (
    ThresholdComputationError,
    ThresholdConfig,
    ThresholdResult,
    ThresholdStatus,
    compute_hierarchical_thresholds,
    resolve_threshold,
)


@dataclass
class LegacyThresholdConfig:
    """Adapter to retain compatibility with older tests.

    The legacy structure is mapped onto the new :class:`ThresholdConfig` with
    sensible defaults.
    """

    method: str = "quantile"
    quantile: float = 0.995
    target_alpha: float = 0.005
    max_relative_deviation: float = 0.2
    fallback_methods: Tuple[str, ...] = ("quantile", "spot")
    spot_tail_fraction: float = 0.02
    min_tail_samples: int = 30

    def to_modern(self) -> ThresholdConfig:
        return ThresholdConfig(
            method=self.method,
            side="upper",
            transform="score",
            alpha=self.target_alpha,
            fallback_methods=self.fallback_methods,
            n_min=0,
        )


def compute_threshold(
    scores: Iterable[float],
    config: LegacyThresholdConfig,
) -> Tuple[Optional[float], Dict[str, object]]:
    modern = config.to_modern()
    result = resolve_threshold(scores, modern, allow_small_sample=True)
    threshold = result.tau_hi or result.tau_lo
    meta: Dict[str, object] = {
        "status": result.status,
        "method": modern.method,
        "applied_method": result.applied_method,
        "alpha": modern.alpha,
        "side": modern.side,
        "transform": modern.transform,
        "n_samples": result.n_samples,
        "n_valid": result.n_valid,
        "fallback_reason": result.fallback_reason,
    }
    return threshold, meta


def apply_threshold(values: Iterable[float], threshold: float) -> np.ndarray:
    arr = np.asarray(list(values), dtype=np.float32)
    return (arr >= threshold).astype(np.int32)


__all__ = [
    "LegacyThresholdConfig",
    "ThresholdConfig",
    "ThresholdResult",
    "ThresholdStatus",
    "ThresholdComputationError",
    "compute_threshold",
    "compute_hierarchical_thresholds",
    "apply_threshold",
]
