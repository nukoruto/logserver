from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd


@dataclass
class RollingSplitConfig:
    """Configuration for rolling-origin time-series cross validation."""

    rolling: str
    window_l: int
    horizon: int
    folds: int
    embargo: Optional[float] = None
    timestamp_column: str = "timestamp_utc"
    group_column: str = "uid"
    session_column: str = "session_id"
    label_column: Optional[str] = None
    seed: Optional[int] = None

    def __post_init__(self) -> None:
        rolling_norm = self.rolling.lower()
        if rolling_norm not in {"expanding", "fixed"}:
            raise ValueError("rolling must be either 'expanding' or 'fixed'")
        self.rolling = rolling_norm
        if self.horizon <= 0:
            raise ValueError("horizon must be a positive integer")
        if self.folds <= 0:
            raise ValueError("folds must be a positive integer")
        if self.window_l < 0:
            raise ValueError("window_l must be non-negative")
        if self.embargo is not None and self.embargo < 0:
            raise ValueError("embargo must be non-negative when provided")


def _prepare_events(frame: pd.DataFrame, timestamp_column: str) -> pd.DataFrame:
    if frame.empty:
        raise ValueError("input frame must not be empty")
    if timestamp_column not in frame.columns:
        raise ValueError(f"timestamp column '{timestamp_column}' not found")

    events = frame.copy()
    events[timestamp_column] = pd.to_datetime(events[timestamp_column], utc=True, errors="raise")
    if events[timestamp_column].isna().any():
        raise ValueError("timestamp column contains NaT values")
    events = events.reset_index(drop=True)
    order = events[timestamp_column].astype("int64") / 1e9
    order += np.arange(len(events), dtype=float) * 1e-9
    events["__order_key__"] = order
    return events.sort_values("__order_key__", kind="mergesort").reset_index(drop=True)


def _positive_count(labels: pd.Series) -> Tuple[int, int]:
    if labels.empty:
        return 0, 0
    if labels.dtype == bool:
        positives = int(labels.sum())
        return positives, len(labels) - positives
    numeric = pd.to_numeric(labels, errors="coerce")
    if numeric.notna().any():
        positives = int((numeric.fillna(0) > 0).sum())
        return positives, len(labels) - positives
    lowered = labels.astype(str).str.lower()
    truthy = {"true", "t", "yes", "y", "1", "anomaly", "positive"}
    positives = int(lowered.isin(truthy).sum())
    return positives, len(labels) - positives


def _aggregate_sessions(
    events: pd.DataFrame,
    config: RollingSplitConfig,
) -> Tuple[pd.DataFrame, np.ndarray, float]:
    if config.group_column not in events.columns:
        raise ValueError(f"group column '{config.group_column}' not found")
    if config.session_column not in events.columns:
        raise ValueError(f"session column '{config.session_column}' not found")

    if config.label_column is not None and config.label_column not in events.columns:
        raise ValueError(f"label column '{config.label_column}' not found")

    ts_col = config.timestamp_column
    group_col = config.group_column
    session_col = config.session_column
    label_col = config.label_column

    events["__delta_t__"] = (
        events.groupby([group_col, session_col], sort=False)[ts_col]
        .diff()
        .dt.total_seconds()
    )

    session_records: List[Dict[str, Any]] = []
    delta_values: List[float] = []

    grouped = events.groupby(session_col, sort=False)
    for session_id, group in grouped:
        if group.empty:
            continue
        start_time = group[ts_col].min()
        end_time = group[ts_col].max()
        order_key = group["__order_key__"].min()
        duration = float((end_time - start_time).total_seconds())
        event_count = int(len(group))
        user = group[group_col].iloc[0]
        if label_col is not None:
            positives, negatives = _positive_count(group[label_col])
        else:
            positives, negatives = 0, 0
        positive_sessions = int(positives > 0)
        session_records.append(
            {
                "session_id": session_id,
                "group": user,
                "start_time": start_time,
                "end_time": end_time,
                "order_key": order_key,
                "duration": duration,
                "events": event_count,
                "positive_events": positives,
                "negative_events": negatives,
                "has_positive": positive_sessions,
            }
        )
        session_delta = group["__delta_t__"].dropna().to_numpy(dtype=float)
        if session_delta.size:
            delta_values.extend(session_delta.tolist())

    if not session_records:
        raise ValueError("no sessions could be aggregated from the input frame")

    session_df = pd.DataFrame(session_records)
    session_df = session_df.sort_values("order_key", kind="mergesort").reset_index(drop=True)
    max_duration_value = session_df["duration"].max()
    max_duration = float(max_duration_value) if pd.notna(max_duration_value) else 0.0
    delta_array = np.array(delta_values, dtype=float) if delta_values else np.array([], dtype=float)
    return session_df, delta_array, max_duration


def _ts_to_iso(value: Optional[pd.Timestamp]) -> Optional[str]:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        value = value.tz_convert("UTC") if value.tzinfo is not None else value.tz_localize("UTC")
        return value.isoformat()
    raise TypeError("expected pandas.Timestamp for boundary timestamps")


def _summarize_split(frame: pd.DataFrame) -> Dict[str, Any]:
    if frame.empty:
        return {
            "sessions": 0,
            "events": 0,
            "positive_events": 0,
            "negative_events": 0,
            "positive_sessions": 0,
        }
    return {
        "sessions": int(len(frame)),
        "events": int(frame["events"].sum()),
        "positive_events": int(frame["positive_events"].sum()),
        "negative_events": int(frame["negative_events"].sum()),
        "positive_sessions": int(frame["has_positive"].sum()),
    }


def generate_rolling_origin_splits(
    frame: pd.DataFrame,
    config: RollingSplitConfig,
    sources: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    events = _prepare_events(frame, config.timestamp_column)
    session_df, delta_array, max_duration = _aggregate_sessions(events, config)
    total_sessions = int(len(session_df))
    total_events = int(len(events))

    horizon_sessions = int(config.horizon)
    eval_span = horizon_sessions * 2
    required_sessions = config.folds * eval_span
    if required_sessions >= total_sessions:
        raise ValueError(
            "not enough sessions to generate the requested folds with separate dev/test windows"
        )

    if config.rolling == "expanding":
        if config.window_l > 0:
            initial_train = config.window_l
        else:
            initial_train = total_sessions - required_sessions
        if initial_train <= 0:
            raise ValueError(
                "expanding window requires more sessions than available after allocating dev/test"
            )
    else:
        if config.window_l <= 0:
            raise ValueError("fixed window requires a positive window_l")
        initial_train = config.window_l
        if initial_train + required_sessions > total_sessions:
            raise ValueError(
                "fixed window configuration leaves no sessions for evaluation folds"
            )

    if config.embargo is not None:
        embargo_seconds = float(config.embargo)
    else:
        median_delta = float(np.median(delta_array)) if delta_array.size else 0.0
        embargo_seconds = float(max(max_duration, 2.0 * median_delta))

    folds: List[Dict[str, Any]] = []

    for fold_idx in range(config.folds):
        train_end_idx = initial_train + fold_idx * eval_span
        dev_start_idx = train_end_idx
        dev_end_idx = dev_start_idx + horizon_sessions
        test_start_idx = dev_end_idx
        test_end_idx = test_start_idx + horizon_sessions
        if test_end_idx > total_sessions:
            raise ValueError(f"insufficient sessions for fold {fold_idx}")

        if config.rolling == "fixed":
            train_start_idx = max(0, train_end_idx - config.window_l)
        else:
            train_start_idx = 0

        train_mask = (session_df.index >= train_start_idx) & (session_df.index < train_end_idx)
        dev_df = session_df.iloc[dev_start_idx:dev_end_idx]
        test_df = session_df.iloc[test_start_idx:test_end_idx]
        if dev_df.empty or test_df.empty:
            raise ValueError("each fold requires non-empty dev and test windows")

        dev_start_time = dev_df["start_time"].min()
        train_mask &= session_df["end_time"] <= dev_start_time

        eval_groups = set(dev_df["group"].unique()).union(set(test_df["group"].unique()))
        if eval_groups:
            train_mask &= ~session_df["group"].isin(eval_groups)

        train_df = session_df.loc[train_mask].copy()
        train_df = train_df.sort_values("order_key", kind="mergesort")
        if train_df.empty:
            raise ValueError("training window became empty after purging group overlaps")

        test_end_time = test_df["end_time"].max()
        embargo_start = test_end_time
        embargo_end = embargo_start + pd.to_timedelta(embargo_seconds, unit="s")
        embargo_mask = (
            (session_df["start_time"] >= embargo_start)
            & (session_df["start_time"] < embargo_end)
        )
        embargo_df = session_df.loc[embargo_mask].copy()

        train_df = train_df.loc[~train_df.index.isin(embargo_df.index)]
        if train_df.empty:
            raise ValueError("training window empty after applying embargo")

        train_sessions_set = set(train_df["session_id"])
        dev_sessions_set = set(dev_df["session_id"])
        test_sessions_set = set(test_df["session_id"])
        embargo_sessions_set = set(embargo_df["session_id"])
        if train_sessions_set.intersection(dev_sessions_set):
            raise RuntimeError("train/dev overlap detected after purging")
        if train_sessions_set.intersection(test_sessions_set):
            raise RuntimeError("train/test overlap detected after purging")
        if train_sessions_set.intersection(embargo_sessions_set):
            raise RuntimeError("train/embargo overlap detected after purging")

        split_info = {
            "index": fold_idx,
            "time": {
                "train": {
                    "start": _ts_to_iso(train_df["start_time"].min()),
                    "end": _ts_to_iso(train_df["end_time"].max()),
                },
                "dev": {
                    "start": _ts_to_iso(dev_df["start_time"].min()),
                    "end": _ts_to_iso(dev_df["end_time"].max()),
                },
                "test": {
                    "start": _ts_to_iso(test_df["start_time"].min()),
                    "end": _ts_to_iso(test_df["end_time"].max()),
                },
                "embargo": {
                    "start": _ts_to_iso(embargo_start),
                    "end": _ts_to_iso(embargo_end),
                },
            },
            "counts": {
                "train": _summarize_split(train_df),
                "dev": _summarize_split(dev_df),
                "test": _summarize_split(test_df),
                "embargo": _summarize_split(embargo_df),
            },
            "users": {
                "train": sorted(train_df["group"].unique().tolist()),
                "dev": sorted(dev_df["group"].unique().tolist()),
                "test": sorted(test_df["group"].unique().tolist()),
                "embargo": sorted(embargo_df["group"].unique().tolist()),
            },
            "sessions": {
                "train": train_df["session_id"].tolist(),
                "dev": dev_df["session_id"].tolist(),
                "test": test_df["session_id"].tolist(),
                "embargo": embargo_df["session_id"].tolist(),
            },
            "indices": {
                "train": [int(idx) for idx in train_df.index.to_list()],
                "dev": list(range(dev_start_idx, dev_end_idx)),
                "test": list(range(test_start_idx, test_end_idx)),
            },
        }
        folds.append(split_info)

    sources_list = list(sources) if sources is not None else []
    median_delta = float(np.median(delta_array)) if delta_array.size else 0.0

    return {
        "version": "rolling-origin-purged-v1",
        "seed": config.seed,
        "config": {
            "rolling": config.rolling,
            "window_l": config.window_l,
            "horizon": config.horizon,
            "folds": config.folds,
            "timestamp_column": config.timestamp_column,
            "group_column": config.group_column,
            "session_column": config.session_column,
            "label_column": config.label_column,
            "embargo_seconds": embargo_seconds,
        },
        "sources": sources_list,
        "summary": {
            "total_events": total_events,
            "total_sessions": total_sessions,
            "median_delta_seconds": median_delta,
            "max_session_duration_seconds": max_duration,
            "embargo_seconds": embargo_seconds,
        },
        "folds": folds,
    }
