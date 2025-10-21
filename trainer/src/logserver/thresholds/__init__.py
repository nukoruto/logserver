"""Unified thresholding interface with multiple estimation methods."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, MutableMapping, Optional, Sequence, Tuple

import numpy as np


@dataclass
class ThresholdConfig:
    """Configuration for threshold estimation.

    Attributes mirror the SRS hand-off for Δt-based thresholding. The configuration
    is intentionally verbose so that the CLI can surface every relevant parameter
    via YAML/CLI overrides.
    """

    method: str = "quantile"
    side: str = "upper"
    transform: str = "raw_dt"
    alpha: float = 0.005
    fallback_methods: Tuple[str, ...] = ("quantile",)
    epsilon: float = 1e-3

    # Δt handling / grouping
    group_keys: Tuple[str, ...] = ("uid", "op_category")
    session_key: str = "session_id"
    timestamp_key: str = "timestamp_utc"
    dt_column: str = "dt_sec"
    score_column: str = "anomaly_score"
    n_min: int = 200

    # SPOT parameters
    calib_frac: float = 0.5
    u_quantile: float = 0.95
    min_exceed: int = 50
    q: float = 1e-3
    solver: str = "mle"
    refit_period: Optional[int] = None

    # Otsu parameters
    bins: Optional[int | str] = "fd"

    # Knee detection parameters
    knee_curve: str = "cdf"
    knee_normalize: bool = True
    knee_method: str = "distance_max"

    # Runtime toggles
    allow_quantile_fallback: bool = True


@dataclass
class ThresholdResult:
    """Result of threshold resolution for one group."""

    group_key: Tuple[str, ...]
    group_level: Tuple[str, ...]
    method: str
    applied_method: str
    side: str
    transform: str
    tau_hi: Optional[float]
    tau_lo: Optional[float]
    n_samples: int
    n_valid: int
    status: str
    fallback_reason: Optional[str]
    data_hash: Optional[str]
    details: Dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> Dict[str, Any]:
        payload = {
            "group": list(self.group_key),
            "group_level": list(self.group_level),
            "method": self.method,
            "applied_method": self.applied_method,
            "side": self.side,
            "transform": self.transform,
            "tau_hi": self.tau_hi,
            "tau_lo": self.tau_lo,
            "n_samples": self.n_samples,
            "n_valid": self.n_valid,
            "status": self.status,
            "fallback_reason": self.fallback_reason,
            "data_hash": self.data_hash,
        }
        payload.update(self.details)
        return payload


class ThresholdComputationError(RuntimeError):
    """Raised when no valid threshold can be computed even after fallbacks."""


def _hash_values(values: np.ndarray) -> str:
    import hashlib

    digest = hashlib.sha256()
    digest.update(np.asarray(values, dtype=np.float64).tobytes())
    return digest.hexdigest()


def _drop_na(values: Iterable[float]) -> np.ndarray:
    arr = np.asarray(list(values), dtype=np.float64)
    finite_mask = np.isfinite(arr)
    return arr[finite_mask]


def _compute_bins(values: np.ndarray, bins: int | str | None) -> int:
    if isinstance(bins, int):
        return max(bins, 2)
    if bins in {None, "fd"}:
        if values.size < 2:
            return 2
        q75, q25 = np.quantile(values, [0.75, 0.25], method="linear")
        iqr = q75 - q25
        if iqr <= 0:
            return 2
        width = 2 * iqr / (values.size ** (1.0 / 3.0))
        if width <= 0:
            return 2
        count = int(np.ceil((values.max() - values.min()) / width))
        return max(count, 2)
    return 128


from .resolve import (
    ThresholdStatus,
    compute_hierarchical_thresholds,
    prepare_delta_columns,
    resolve_threshold,
)

__all__ = [
    "ThresholdConfig",
    "ThresholdResult",
    "ThresholdComputationError",
    "ThresholdStatus",
    "prepare_delta_columns",
    "resolve_threshold",
    "compute_hierarchical_thresholds",
    "_hash_values",
    "_drop_na",
    "_compute_bins",
]
