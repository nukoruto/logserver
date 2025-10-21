from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple, Union

import json
import logging

import numpy as np
import pandas as pd

LOGGER = logging.getLogger(__name__)


from .utils import (
    auto_embargo_seconds,
    build_partition_payload,
    build_summary,
    check_invariants,
    compute_data_hash,
    manifest_meta,
    stable_group_rank,
)


@dataclass(frozen=True)
class SingleSplitConfig:
    timestamp_column: str = "timestamp_utc"
    session_column: str = "session_id"
    group_column: Optional[str] = "uid"
    group_key: str = "user_id"
    label_column: Optional[str] = None
    val_fraction: float = 0.2
    embargo: Union[str, float] = "auto"
    seed: int = 42


@dataclass(frozen=True)
class SingleSplitResult:
    train_sessions: Tuple[str, ...]
    val_sessions: Tuple[str, ...]
    ordered_sessions: Tuple[str, ...]
    manifest: Dict[str, object]

    def to_session_ids(self) -> Tuple[List[str], List[str], List[str]]:
        return list(self.train_sessions), list(self.val_sessions), list(self.ordered_sessions)


def _resolve_val_groups(
    sessions_df: pd.DataFrame,
    *,
    group_column: str,
    val_fraction: float,
    seed: int,
    min_candidates: int,
) -> Tuple[List[str], Dict[str, float]]:
    candidate_df = sessions_df.tail(max(1, min_candidates))
    groups = candidate_df[group_column].dropna().astype(str).unique().tolist()
    ranks = {group: stable_group_rank(group, seed) for group in groups}
    selected = [group for group in groups if ranks[group] < val_fraction]
    if not selected and groups:
        selected = [min(groups, key=lambda g: (ranks[g], g))]
    return selected, ranks


def _select_val_sessions(
    sessions_df: pd.DataFrame,
    *,
    group_column: str,
    val_groups: Sequence[str],
) -> pd.DataFrame:
    if not val_groups:
        return sessions_df.iloc[0:0].copy()
    mask = sessions_df[group_column].astype(str).isin(set(val_groups))
    return sessions_df.loc[mask].copy()


def make_single_split_with_group_holdout(
    sessions_df: pd.DataFrame,
    events_df: pd.DataFrame,
    *,
    config: SingleSplitConfig,
    delta_seconds: Iterable[float] | None = None,
) -> SingleSplitResult:
    if config.val_fraction <= 0 or config.val_fraction >= 1:
        raise ValueError("val_fraction must be between 0 and 1 (exclusive)")

    if config.group_key == "none":
        group_column: Optional[str] = None
    else:
        group_column = config.group_column
        if group_column is None or group_column not in sessions_df.columns:
            raise ValueError("group_column must be provided when group_key is not 'none'")

    if delta_seconds is None:
        delta_values = []
    else:
        delta_values = [float(x) for x in delta_seconds]

    if isinstance(config.embargo, str) and config.embargo.lower() == "auto":
        embargo_seconds = auto_embargo_seconds(sessions_df, delta_values)
    else:
        embargo_seconds = float(config.embargo)

    ordered_sessions = sessions_df[config.session_column].astype(str).tolist()

    if group_column is None:
        val_count = max(1, int(np.ceil(len(sessions_df) * config.val_fraction)))
        val_df = sessions_df.tail(val_count).copy()
        val_start = val_df["start_time"].min() if not val_df.empty else None
        if val_start is not None:
            train_df = sessions_df[(sessions_df["end_time"] <= val_start)].copy()
        else:
            train_df = sessions_df.iloc[0:0].copy()
        if train_df.empty:
            LOGGER.warning(json.dumps({"event": "single_split_adjustment", "reason": "train_empty_none_mode"}, ensure_ascii=False))
            train_df = sessions_df.drop(val_df.index, errors="ignore")
        val_groups: List[str] = []
    else:
        min_candidates = max(1, int(np.ceil(len(sessions_df) * max(config.val_fraction, 0.1))))
        val_groups, ranks = _resolve_val_groups(
            sessions_df,
            group_column=group_column,
            val_fraction=config.val_fraction,
            seed=config.seed,
            min_candidates=min_candidates,
        )
        val_df = _select_val_sessions(sessions_df, group_column=group_column, val_groups=val_groups)
        if val_df.empty:
            raise ValueError("validation split would be empty; adjust val_fraction or seed")
        cutoff = val_df["start_time"].min()
        train_df = sessions_df[
            (sessions_df["end_time"] <= cutoff)
            & (~sessions_df[group_column].astype(str).isin(val_groups))
        ].copy()
        removed_for_groups = sessions_df[
            sessions_df[group_column].astype(str).isin(val_groups)
            & (sessions_df["end_time"] > cutoff)
        ]
        if not removed_for_groups.empty:
            train_df = train_df.drop(removed_for_groups.index, errors="ignore")
        retries = sorted(val_groups, key=lambda g: (ranks.get(g, 1.0), g), reverse=True)
        while train_df.empty and retries:
            dropped = retries.pop(0)
            LOGGER.warning(json.dumps({"event": "single_split_adjustment", "action": "drop_group", "group": dropped}, ensure_ascii=False))
            val_groups = [group for group in val_groups if group != dropped]
            val_df = _select_val_sessions(sessions_df, group_column=group_column, val_groups=val_groups)
            if val_df.empty:
                raise ValueError("validation split became empty after adjustments")
            cutoff = val_df["start_time"].min()
            train_df = sessions_df[
                (sessions_df["end_time"] <= cutoff)
                & (~sessions_df[group_column].astype(str).isin(val_groups))
            ].copy()
            removed_for_groups = sessions_df[
                sessions_df[group_column].astype(str).isin(val_groups)
                & (sessions_df["end_time"] > cutoff)
            ]
            train_df = train_df.drop(removed_for_groups.index, errors="ignore")

    train_df = train_df.sort_values("order_key", kind="mergesort").reset_index(drop=True)
    val_df = val_df.sort_values("order_key", kind="mergesort").reset_index(drop=True)

    check_invariants(
        {"train": train_df, "val": val_df},
        embargo_seconds=embargo_seconds,
        group_column=group_column,
        session_column=config.session_column,
        eval_partitions=("val",),
    )

    median_delta = 0.0
    if delta_values:
        arr = np.array([float(x) for x in delta_values if np.isfinite(x)], dtype=float)
        if arr.size:
            median_delta = float(np.median(arr))

    summary = build_summary(
        total_events=int(events_df.shape[0]),
        total_sessions=int(len(sessions_df)),
        median_delta_seconds=median_delta,
        max_session_duration_seconds=float(sessions_df["duration"].max()) if not sessions_df.empty else 0.0,
        embargo_seconds=float(embargo_seconds),
    )

    train_payload = build_partition_payload(train_df, session_column=config.session_column).to_dict()
    val_payload = build_partition_payload(val_df, session_column=config.session_column).to_dict()

    data_hash = compute_data_hash(events_df)
    params = {
        "group_key": config.group_key,
        "group_column": group_column,
        "embargo_seconds": float(embargo_seconds),
        "val_fraction": float(config.val_fraction),
        "seed": int(config.seed),
    }

    manifest = {
        "meta": manifest_meta(mode="single", params=params, data_hash=data_hash),
        "summary": summary.to_dict(),
        "splits": [
            {
                "name": "single",
                "train": train_payload,
                "val": val_payload,
                "info": {
                    "val_groups": sorted(val_groups),
                },
            }
        ],
    }

    return SingleSplitResult(
        train_sessions=tuple(train_payload["sessions"]),
        val_sessions=tuple(val_payload["sessions"]),
        ordered_sessions=tuple(ordered_sessions),
        manifest=manifest,
    )
