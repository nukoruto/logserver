# -*- coding: utf-8 -*-
"""Robust scaling utilities for inter-event delta features."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class RobustDeltaStats:
    """Container for per-user robust statistics in log space."""

    user_id: str
    median_log_delta: float
    mad_log_delta: float
    sigma_r: float


def robustZ(
    user_deltas: pd.DataFrame,
    *,
    user_col: str = "user_id",
    delta_col: str = "delta_t",
    eps: float = 1e-6,
    clip: float = 5.0,
) -> pd.DataFrame:
    """Compute robust z-scores for Δt values in the log domain.

    Parameters
    ----------
    user_deltas:
        DataFrame containing per-event Δt records. Missing values must be
        handled by the caller.
    user_col:
        Column holding the user identifier.
    delta_col:
        Column holding Δt in seconds.
    eps:
        Small constant added inside the logarithm and as sigma fallback.
    clip:
        Symmetric clipping limit for z-scores.

    Returns
    -------
    pandas.DataFrame
        DataFrame with additional columns:
        ``log_delta``, ``median_log_delta``, ``mad_log_delta``, ``sigma_r``,
        ``z`` and ``z_clipped``. The per-user statistics are aligned with each
        row.
    """

    if user_col not in user_deltas.columns:
        raise ValueError(f"Column '{user_col}' is required")
    if delta_col not in user_deltas.columns:
        raise ValueError(f"Column '{delta_col}' is required")

    df = user_deltas[[user_col, delta_col]].copy()
    delta_values = df[delta_col].to_numpy(dtype=np.float64)
    if np.any(delta_values < 0):
        raise ValueError("Delta values must be non-negative for logarithmic scaling")

    log_delta = np.log(delta_values + eps)
    df["log_delta"] = log_delta.astype(np.float64)

    grouped = df.groupby(user_col, sort=False, observed=True)["log_delta"]

    median_log = grouped.transform("median")
    df["median_log_delta"] = median_log

    mad = grouped.transform(
        lambda series: float(np.median(np.abs(series - float(np.median(series)))))
    )
    df["mad_log_delta"] = mad

    sigma_r = 1.4826 * df["mad_log_delta"]
    sigma_r = sigma_r.where(sigma_r > 0, 1.4826 * eps)
    df["sigma_r"] = sigma_r

    z = (df["log_delta"] - df["median_log_delta"]) / df["sigma_r"]
    df["z"] = z
    df["z_clipped"] = np.clip(z, -clip, clip)

    return df


def summarize_stats(df: pd.DataFrame, user_col: str = "user_id") -> List[RobustDeltaStats]:
    """Summarize per-user robust statistics from the robustZ output."""

    required = {user_col, "median_log_delta", "mad_log_delta", "sigma_r"}
    missing = required.difference(df.columns)
    if missing:
        missing_cols = ", ".join(sorted(missing))
        raise ValueError(f"Missing columns required for summary: {missing_cols}")

    stats: List[RobustDeltaStats] = []
    for user, group in df.groupby(user_col, sort=False):
        stats.append(
            RobustDeltaStats(
                user_id=str(user),
                median_log_delta=float(group["median_log_delta"].iloc[0]),
                mad_log_delta=float(group["mad_log_delta"].iloc[0]),
                sigma_r=float(group["sigma_r"].iloc[0]),
            )
        )
    return stats


__all__ = ["robustZ", "summarize_stats", "RobustDeltaStats"]

