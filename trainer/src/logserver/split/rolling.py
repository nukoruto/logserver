from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from .utils import (
    build_partition_payload,
    build_summary,
    check_invariants,
    compute_data_hash,
    manifest_meta,
    prepare_events,
    aggregate_sessions,
    auto_embargo_seconds,
)


@dataclass(frozen=True)
class RollingSplitConfig:
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
        object.__setattr__(self, "rolling", rolling_norm)
        if self.horizon <= 0:
            raise ValueError("horizon must be a positive integer")
        if self.folds <= 0:
            raise ValueError("folds must be a positive integer")
        if self.window_l < 0:
            raise ValueError("window_l must be non-negative")
        if self.embargo is not None and self.embargo < 0:
            raise ValueError("embargo must be non-negative when provided")


def _slice_sessions(session_df: pd.DataFrame, start: int, end: int) -> pd.DataFrame:
    if start >= end:
        return session_df.iloc[0:0].copy()
    return session_df.iloc[start:end].copy()


def generate_rolling_origin_splits(
    frame: pd.DataFrame,
    config: RollingSplitConfig,
    sources: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    events = prepare_events(frame, config.timestamp_column)
    session_df, delta_array, max_duration = aggregate_sessions(
        events,
        timestamp_column=config.timestamp_column,
        group_column=config.group_column,
        session_column=config.session_column,
        label_column=config.label_column,
    )
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
        embargo_seconds = auto_embargo_seconds(session_df, delta_array)

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
        dev_df = _slice_sessions(session_df, dev_start_idx, dev_end_idx)
        test_df = _slice_sessions(session_df, test_start_idx, test_end_idx)
        if dev_df.empty or test_df.empty:
            raise ValueError("each fold requires non-empty dev and test windows")

        dev_start_time = dev_df["start_time"].min()
        train_mask &= session_df["end_time"] <= dev_start_time

        eval_groups = set(dev_df["group"].astype(str)).union(set(test_df["group"].astype(str)))
        if eval_groups:
            train_mask &= ~session_df["group"].astype(str).isin(eval_groups)

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
        train_df = train_df.sort_values("order_key", kind="mergesort")
        if train_df.empty:
            raise ValueError("training window empty after applying embargo")

        check_invariants(
            {
                "train": train_df,
                "dev": dev_df,
                "test": test_df,
            },
            embargo_seconds=embargo_seconds,
            group_column=config.group_column,
            session_column=config.session_column,
            eval_partitions=("dev", "test"),
        )

        fold_entry = {
            "name": f"fold_{fold_idx}",
            "train": build_partition_payload(train_df, session_column=config.session_column).to_dict(),
            "dev": build_partition_payload(dev_df, session_column=config.session_column).to_dict(),
            "test": build_partition_payload(test_df, session_column=config.session_column).to_dict(),
            "embargo": build_partition_payload(embargo_df, session_column=config.session_column).to_dict(),
        }
        folds.append(fold_entry)

    median_delta = float(np.median(delta_array)) if delta_array.size else 0.0
    summary = build_summary(
        total_events=total_events,
        total_sessions=total_sessions,
        median_delta_seconds=median_delta,
        max_session_duration_seconds=max_duration,
        embargo_seconds=float(embargo_seconds),
    )

    params = {
        "rolling": config.rolling,
        "window_l": config.window_l,
        "horizon": config.horizon,
        "folds": config.folds,
        "timestamp_column": config.timestamp_column,
        "group_column": config.group_column,
        "session_column": config.session_column,
        "label_column": config.label_column,
        "embargo_seconds": float(embargo_seconds),
        "seed": config.seed,
    }

    manifest = {
        "meta": manifest_meta(
            mode="tscv",
            params=params,
            data_hash=compute_data_hash(frame),
            created_at=datetime.now(timezone.utc),
        ),
        "summary": summary.to_dict(),
        "sources": list(sources) if sources is not None else [],
        "splits": folds,
    }
    return manifest
