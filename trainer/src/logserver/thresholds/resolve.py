"""High-level helpers to resolve thresholds across methods and groupings."""

from __future__ import annotations

from dataclasses import asdict
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from . import ThresholdComputationError, ThresholdConfig, ThresholdResult, _hash_values
from .knee import knee_threshold
from .otsu import otsu_threshold
from .quantile import quantile_threshold
from .spot import spot_threshold


class ThresholdStatus:
    OK = "ok"
    SKIPPED = "skipped"
    BACKOFF = "backoff"


def _select_metric_column(df: pd.DataFrame, config: ThresholdConfig) -> str:
    transform = config.transform
    if transform == "score":
        if config.score_column not in df.columns:
            raise KeyError(f"score column '{config.score_column}' not found")
        return config.score_column
    if transform == "raw_dt":
        return config.dt_column
    if transform == "log_dt":
        log_col = f"__{config.dt_column}_log"
        if log_col not in df.columns:
            raise KeyError("log Δt column missing; call prepare_delta_columns first")
        return log_col
    raise ValueError(f"Unsupported transform: {transform}")


def prepare_delta_columns(df: pd.DataFrame, config: ThresholdConfig) -> pd.DataFrame:
    working = df.copy()
    if config.dt_column in working.columns:
        dt_series = pd.to_numeric(working[config.dt_column], errors="coerce")
    else:
        if config.timestamp_key not in working.columns:
            raise KeyError("timestamp column required for Δt computation")
        timestamps = pd.to_datetime(working[config.timestamp_key], utc=True, errors="coerce")
        if timestamps.isna().all():
            raise ValueError("timestamp column could not be parsed")
        working = working.assign(__timestamp=timestamps)
        group_cols: List[str] = []
        for key in (*config.group_keys, config.session_key):
            if key in working.columns and key not in group_cols:
                group_cols.append(key)
        if not group_cols:
            group_cols = [config.session_key] if config.session_key in working.columns else []
        sorted_working = working.sort_values(group_cols + ["__timestamp"], kind="mergesort")
        dt_seconds = (
            sorted_working.groupby(group_cols)["__timestamp"].diff().dt.total_seconds()
            if group_cols
            else sorted_working["__timestamp"].diff().dt.total_seconds()
        )
        sorted_working[config.dt_column] = dt_seconds
        working = sorted_working.sort_index()
        working.drop(columns=["__timestamp"], inplace=True, errors="ignore")
        dt_series = pd.to_numeric(working[config.dt_column], errors="coerce")
    working[config.dt_column] = dt_series
    log_col = f"__{config.dt_column}_log"
    working[log_col] = np.where(
        np.isfinite(dt_series),
        np.log(np.maximum(dt_series + float(config.epsilon), 1e-12)),
        np.nan,
    )
    return working


def _apply_method(values: np.ndarray, config: ThresholdConfig) -> Tuple[Optional[float], Optional[float], Dict[str, float], Optional[str], str]:
    method = config.method
    side = config.side
    if method == "quantile":
        tau_hi, tau_lo, details = quantile_threshold(values, alpha=config.alpha, side=side)
        return tau_hi, tau_lo, details, None, "quantile"
    if method == "spot":
        tau_hi, tau_lo, details, reason = spot_threshold(values, config, side=side)
        return tau_hi, tau_lo, details, reason, "spot"
    if method == "otsu":
        tau_hi, tau_lo, details, reason = otsu_threshold(values, bins=config.bins, side=side)
        return tau_hi, tau_lo, details, reason, "otsu"
    if method == "knee":
        tau_hi, tau_lo, details, reason = knee_threshold(values, curve=config.knee_curve, normalize=config.knee_normalize, side=side)
        return tau_hi, tau_lo, details, reason, "knee"
    raise ValueError(f"Unsupported method: {method}")


def resolve_threshold(
    values: Iterable[float],
    config: ThresholdConfig,
    *,
    allow_small_sample: bool,
) -> ThresholdResult:
    arr_all = np.asarray(list(values), dtype=np.float64)
    n_samples = int(arr_all.size)
    arr = arr_all[np.isfinite(arr_all)]
    n_valid = int(arr.size)
    if n_valid == 0:
        return ThresholdResult(
            group_key=(),
            group_level=(),
            method=config.method,
            applied_method=config.method,
            side=config.side,
            transform=config.transform,
            tau_hi=None,
            tau_lo=None,
            n_samples=n_samples,
            n_valid=n_valid,
            status=ThresholdStatus.SKIPPED,
            fallback_reason="no_finite_samples",
            data_hash=None,
            details={},
        )

    if not allow_small_sample and n_valid < int(config.n_min):
        return ThresholdResult(
            group_key=(),
            group_level=(),
            method=config.method,
            applied_method=config.method,
            side=config.side,
            transform=config.transform,
            tau_hi=None,
            tau_lo=None,
            n_samples=n_samples,
            n_valid=n_valid,
            status=ThresholdStatus.BACKOFF,
            fallback_reason="insufficient_samples",
            data_hash=_hash_values(arr),
            details={"n_min": float(config.n_min)},
        )

    order = [config.method, *config.fallback_methods]
    fallback_reason: Optional[str] = None
    final_method = config.method
    tau_hi: Optional[float] = None
    tau_lo: Optional[float] = None
    details: Dict[str, float] = {}

    for method in order:
        working_config = ThresholdConfig(**{**asdict(config), "method": method})
        tau_hi_candidate, tau_lo_candidate, method_details, reason, applied = _apply_method(arr, working_config)
        if tau_hi_candidate is None and tau_lo_candidate is None:
            fallback_reason = reason or f"{applied}_failed"
            final_method = applied
            continue
        tau_hi = tau_hi_candidate
        tau_lo = tau_lo_candidate
        details = method_details
        final_method = applied
        fallback_reason = reason
        break

    status = ThresholdStatus.OK if (tau_hi is not None or tau_lo is not None) else ThresholdStatus.SKIPPED
    return ThresholdResult(
        group_key=(),
        group_level=(),
        method=config.method,
        applied_method=final_method,
        side=config.side,
        transform=config.transform,
        tau_hi=tau_hi,
        tau_lo=tau_lo,
        n_samples=n_samples,
        n_valid=n_valid,
        status=status,
        fallback_reason=fallback_reason,
        data_hash=_hash_values(arr),
        details=details,
    )


def _build_levels(config: ThresholdConfig, available_columns: Sequence[str]) -> List[Tuple[str, ...]]:
    keys = [key for key in config.group_keys if key in available_columns]
    if not keys:
        return [tuple()]
    levels = [tuple(keys[: i + 1]) for i in range(len(keys))]
    levels.reverse()
    # Ensure full key first, then progressively shorter, finally global
    levels = [tuple(keys)]
    for i in range(len(keys) - 1, -1, -1):
        prefix = tuple(keys[:i])
        if prefix and prefix not in levels:
            levels.append(prefix)
    levels.append(tuple())
    unique_levels: List[Tuple[str, ...]] = []
    for level in levels:
        if level not in unique_levels:
            unique_levels.append(level)
    return unique_levels


def compute_hierarchical_thresholds(
    df: pd.DataFrame,
    config: ThresholdConfig,
) -> List[ThresholdResult]:
    working = prepare_delta_columns(df, config)
    metric_column = _select_metric_column(working, config)
    available_columns = tuple(working.columns)
    levels = _build_levels(config, available_columns)
    top_level = levels[0]
    results: List[ThresholdResult] = []

    if not top_level:
        result = resolve_threshold(working[metric_column].to_numpy(dtype=np.float64), config, allow_small_sample=True)
        result.group_key = tuple()
        result.group_level = tuple()
        results.append(result)
        return results

    grouped = working.groupby(list(top_level), sort=True, dropna=False)
    for key, group in grouped:
        key_tuple = key if isinstance(key, tuple) else (key,)
        group_values = tuple(str(value) for value in key_tuple)
        assigned: Optional[ThresholdResult] = None
        source_level: Tuple[str, ...] = top_level
        for level in levels:
            allow_small = level == tuple()
            if level:
                selectors = {col: key_tuple[idx] for idx, col in enumerate(top_level) if col in level}
                mask = np.ones(len(working), dtype=bool)
                for col in level:
                    value = selectors.get(col)
                    mask &= working[col] == value
                subset = working.loc[mask]
            else:
                subset = working
            if subset.empty:
                continue
            result = resolve_threshold(subset[metric_column].to_numpy(dtype=np.float64), config, allow_small_sample=allow_small)
            if result.status == ThresholdStatus.OK:
                assigned = result
                source_level = level
                break
            if result.status == ThresholdStatus.SKIPPED and allow_small:
                assigned = result
                source_level = level
                break
        if assigned is None:
            raise ThresholdComputationError(f"Failed to compute threshold for group {group_values}")
        assigned.group_key = group_values
        assigned.group_level = source_level
        if assigned.fallback_reason is None and source_level != top_level:
            assigned.fallback_reason = f"backoff_to_{'_'.join(source_level) if source_level else 'global'}"
        results.append(assigned)

    return results
