# -*- coding: utf-8 -*-
"""Audit-ready preprocessing report generation."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Mapping

import numpy as np
import pandas as pd


NumericSummary = Dict[str, Dict[str, float]]


def _numeric_summary(df: pd.DataFrame) -> NumericSummary:
    numeric_df = df.select_dtypes(include=[np.number])
    summary: NumericSummary = {}
    percentiles = [0.25, 0.5, 0.75, 0.95]
    for column in numeric_df.columns:
        series = pd.to_numeric(numeric_df[column], errors="coerce").dropna()
        if series.empty:
            continue
        desc = series.describe(percentiles=percentiles)
        summary[column] = {
            "count": float(desc.get("count", 0.0)),
            "mean": float(desc.get("mean", 0.0)),
            "std": float(desc.get("std", 0.0)),
            "min": float(desc.get("min", 0.0)),
            "q25": float(desc.get("25%", desc.get("0.25", np.nan))),
            "median": float(desc.get("50%", desc.get("0.50", np.nan))),
            "q75": float(desc.get("75%", desc.get("0.75", np.nan))),
            "q95": float(desc.get("95%", np.nan)),
            "max": float(desc.get("max", 0.0)),
        }
    return summary


def _missing_counts(df: pd.DataFrame) -> Dict[str, int]:
    return {column: int(df[column].isna().sum()) for column in df.columns}


def _unknown_counts(df: pd.DataFrame) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for column in df.columns:
        if df[column].dtype == object or pd.api.types.is_string_dtype(df[column]):
            values = df[column].dropna().astype(str).str.lower()
            counts[column] = int((values == "unknown").sum())
    return counts


def _quantile_diff(before: pd.DataFrame, after: pd.DataFrame) -> Dict[str, Dict[str, float]]:
    quantiles = {"q25": 0.25, "median": 0.5, "q75": 0.75, "q95": 0.95}
    diffs: Dict[str, Dict[str, float]] = {}
    before_numeric = before.select_dtypes(include=[np.number])
    after_numeric = after.select_dtypes(include=[np.number])
    for column in sorted(set(before_numeric.columns).intersection(after_numeric.columns)):
        before_series = pd.to_numeric(before_numeric[column], errors="coerce")
        after_series = pd.to_numeric(after_numeric[column], errors="coerce")
        delta: Dict[str, float] = {}
        for name, q in quantiles.items():
            before_q = float(before_series.quantile(q))
            after_q = float(after_series.quantile(q))
            delta[name] = after_q - before_q
        diffs[column] = delta
    return diffs


def _unit_invariance(before: pd.DataFrame, after: pd.DataFrame) -> Dict[str, object]:
    numeric_before = before.select_dtypes(include=[np.number])
    numeric_after = after.select_dtypes(include=[np.number])
    checks: Dict[str, Dict[str, float]] = {}
    tolerance = 1e-6
    target_columns = [
        column
        for column in numeric_before.columns
        if column in numeric_after.columns and any(
            column.endswith(suffix) for suffix in ("_ms", "_bytes", "_count", "delta_t")
        )
    ]
    if not target_columns:
        return {"passed": True, "checks": checks}
    overall_pass = True
    for column in target_columns:
        before_series = pd.to_numeric(numeric_before[column], errors="coerce")
        after_series = pd.to_numeric(numeric_after[column], errors="coerce")
        reference = float(before_series.quantile(0.95))
        observed = float(after_series.quantile(0.95))
        diff = observed - reference
        allowed = max(tolerance, tolerance * abs(reference))
        status = abs(diff) <= allowed
        if not status:
            overall_pass = False
        checks[column] = {
            "reference_q95": reference,
            "processed_q95": observed,
            "abs_diff": diff,
            "status": status,
        }
    return {"passed": overall_pass, "checks": checks}


def _to_serialisable(value: object) -> object:
    if isinstance(value, (np.floating, np.float32, np.float64)):
        return float(value)
    if isinstance(value, (np.integer, np.int32, np.int64)):
        return int(value)
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, (pd.Timestamp, datetime)):
        if pd.isna(value):
            return None
        if isinstance(value, pd.Timestamp):
            if value.tzinfo is None:
                value = value.tz_localize(timezone.utc)
        if isinstance(value, datetime) and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    if isinstance(value, pd.Timedelta):
        return value.total_seconds()
    if pd.isna(value):
        return None
    return value


def _sample_rows(df: pd.DataFrame, limit: int) -> List[Dict[str, object]]:
    records: List[Dict[str, object]] = []
    for _, row in df.head(limit).iterrows():
        record: Dict[str, object] = {}
        for key, value in row.items():
            record[str(key)] = _to_serialisable(value)
        records.append(record)
    return records


def _user_samples(before: pd.DataFrame, after: pd.DataFrame, sample_size: int) -> List[Dict[str, object]]:
    if "uid" not in before.columns or "uid" not in after.columns:
        return []
    unique_uids = list(dict.fromkeys(before["uid"].astype(str)))
    samples: List[Dict[str, object]] = []
    for uid in unique_uids[:sample_size]:
        before_rows = before[before["uid"].astype(str) == uid]
        after_rows = after[after["uid"].astype(str) == uid]
        samples.append(
            {
                "uid": uid,
                "rows": [
                    {"stage": "before", "data": _sample_rows(before_rows, limit=3)},
                    {"stage": "after", "data": _sample_rows(after_rows, limit=3)},
                ],
            }
        )
    return samples


def generate_preproc_report(
    before: pd.DataFrame,
    after: pd.DataFrame,
    output_path: Path,
    *,
    sample_size: int = 5,
) -> Mapping[str, object]:
    """Generate JSON report containing audit statistics for preprocessing."""

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "row_counts": {"before": int(len(before)), "after": int(len(after))},
        "column_counts": {
            "before": len(before.columns),
            "after": len(after.columns),
        },
        "numeric_stats": {
            "before": _numeric_summary(before),
            "after": _numeric_summary(after),
        },
        "missing_counts": {
            "before": _missing_counts(before),
            "after": _missing_counts(after),
        },
        "unknown_counts": {
            "before": _unknown_counts(before),
            "after": _unknown_counts(after),
        },
        "quantile_diff": _quantile_diff(before, after),
        "unit_invariance": _unit_invariance(before, after),
    }
    report: Dict[str, object] = {
        "summary": summary,
        "samples": _user_samples(before, after, sample_size),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    return report


__all__ = ["generate_preproc_report"]

