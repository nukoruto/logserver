from __future__ import annotations

import hashlib
import hmac
import io
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Mapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class SplitPartition:
    """Container describing a partition of sessions."""

    sessions: Sequence[str]
    users: Sequence[str]
    time_range: Dict[str, Optional[str]]
    counts: Dict[str, int]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sessions": list(self.sessions),
            "users": list(self.users),
            "time_range": dict(self.time_range),
            "counts": dict(self.counts),
        }


@dataclass(frozen=True)
class SplitSummary:
    """Overall summary metadata for a split manifest."""

    total_events: int
    total_sessions: int
    median_delta_seconds: float
    max_session_duration_seconds: float
    embargo_seconds: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_events": int(self.total_events),
            "total_sessions": int(self.total_sessions),
            "median_delta_seconds": float(self.median_delta_seconds),
            "max_session_duration_seconds": float(self.max_session_duration_seconds),
            "embargo_seconds": float(self.embargo_seconds),
        }


def _ts_to_iso(value: Optional[pd.Timestamp]) -> Optional[str]:
    if value is None or pd.isna(value):
        return None
    if not isinstance(value, pd.Timestamp):
        raise TypeError("expected pandas.Timestamp for boundary timestamps")
    if value.tzinfo is None:
        value = value.tz_localize("UTC")
    else:
        value = value.tz_convert("UTC")
    return value.isoformat()


def prepare_events(frame: pd.DataFrame, timestamp_column: str) -> pd.DataFrame:
    """Normalise event timestamps and impose a deterministic ordering."""

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


def aggregate_sessions(
    events: pd.DataFrame,
    *,
    timestamp_column: str,
    group_column: str,
    session_column: str,
    label_column: Optional[str] = None,
) -> Tuple[pd.DataFrame, np.ndarray, float]:
    """Aggregate events into session-level statistics."""

    for column, name in (
        (group_column, "group"),
        (session_column, "session"),
        (timestamp_column, "timestamp"),
    ):
        if column not in events.columns:
            raise ValueError(f"{name} column '{column}' not found")
    if label_column is not None and label_column not in events.columns:
        raise ValueError(f"label column '{label_column}' not found")

    working = events.copy()
    working["__delta_t__"] = (
        working.groupby([group_column, session_column], sort=False)[timestamp_column]
        .diff()
        .dt.total_seconds()
    )

    session_records: list[dict[str, Any]] = []
    delta_values: list[float] = []

    grouped = working.groupby(session_column, sort=False)
    for session_id, group in grouped:
        if group.empty:
            continue
        start_time = group[timestamp_column].min()
        end_time = group[timestamp_column].max()
        order_key = group["__order_key__"].min()
        duration = float((end_time - start_time).total_seconds())
        event_count = int(len(group))
        user = group[group_column].iloc[0]
        positives = 0
        negatives = 0
        positive_sessions = 0
        if label_column is not None:
            labels = group[label_column]
            if labels.dtype == bool:
                positives = int(labels.sum())
            else:
                numeric = pd.to_numeric(labels, errors="coerce")
                positives = int((numeric.fillna(0) > 0).sum())
            negatives = int(event_count - positives)
            positive_sessions = int(positives > 0)
        record = {
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
        if group_column not in record:
            record[group_column] = user
        session_records.append(record)
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


def compute_data_hash(df: pd.DataFrame) -> str:
    """Compute a deterministic sha256 hash for a dataframe."""

    normalized = df.copy()
    if not normalized.columns.is_unique:
        normalized = normalized.loc[:, ~normalized.columns.duplicated()]
    normalized = normalized.reindex(sorted(normalized.columns), axis=1)

    for column in normalized.columns:
        if pd.api.types.is_datetime64_any_dtype(normalized[column]):
            normalized[column] = pd.to_datetime(normalized[column], utc=True, errors="coerce").dt.strftime(
                "%Y-%m-%dT%H:%M:%S.%fZ"
            )
        else:
            normalized[column] = normalized[column].astype(str)

    buffer = io.BytesIO()
    normalized.to_csv(buffer, index=False)
    digest = hashlib.sha256(buffer.getvalue()).hexdigest()
    return f"sha256:{digest}"


def auto_embargo_seconds(sessions_df: pd.DataFrame, delta_seconds: Iterable[float]) -> float:
    """Heuristic embargo estimation shared across split strategies."""

    if sessions_df.empty:
        max_session_length = 0.0
    else:
        durations = (
            (sessions_df["end_time"] - sessions_df["start_time"])
            .dt.total_seconds()
            .dropna()
            .to_numpy(dtype=float)
        )
        max_session_length = float(durations.max()) if durations.size else 0.0

    delta_array = np.fromiter((float(x) for x in delta_seconds), dtype=float, count=-1)
    if delta_array.size:
        finite = delta_array[np.isfinite(delta_array) & (delta_array >= 0)]
        median_dt = float(np.median(finite)) if finite.size else 0.0
    else:
        median_dt = 0.0

    embargo = max(max_session_length, 2.0 * median_dt)
    return float(embargo)


def stable_group_rank(group_id: str, seed: int) -> float:
    """Compute a deterministic rank in [0, 1) for the provided group identifier."""

    key = str(seed).encode("utf-8")
    message = str(group_id).encode("utf-8")
    digest = hmac.new(key, message, hashlib.sha1).digest()
    value = int.from_bytes(digest, "big")
    return value / float(1 << (len(digest) * 8))


def _ensure_timestamp_series(frame: pd.DataFrame, column: str) -> pd.Series:
    if column not in frame.columns:
        raise ValueError(f"required timestamp column '{column}' missing for invariant checks")
    series = pd.to_datetime(frame[column], utc=True, errors="raise")
    if series.isna().any():
        raise ValueError(f"column '{column}' contains NaT values")
    return series


def check_invariants(
    partitions: Mapping[str, pd.DataFrame],
    *,
    embargo_seconds: float,
    group_column: Optional[str],
    session_column: str,
    eval_partitions: Sequence[str] = ("val", "test"),
) -> None:
    """Validate purity, group separation, and embargo constraints for a split."""

    if embargo_seconds < 0:
        raise ValueError("embargo_seconds must be non-negative")

    train = partitions.get("train")
    if train is None or train.empty:
        return

    train_start = _ensure_timestamp_series(train, "start_time")
    train_end = _ensure_timestamp_series(train, "end_time")
    train_sessions = set(train[session_column].astype(str))
    train_groups = set(train[group_column].astype(str)) if group_column and group_column in train.columns else set()

    latest_eval_end: Optional[pd.Timestamp] = None

    for partition_name in eval_partitions:
        part = partitions.get(partition_name)
        if part is None or part.empty:
            continue
        eval_start = _ensure_timestamp_series(part, "start_time").min()
        eval_end = _ensure_timestamp_series(part, "end_time").max()
        if train_end.max() > eval_start:
            raise ValueError(
                f"training sessions end after the start of '{partition_name}' window (violates temporal purity)"
            )

        eval_sessions = set(part[session_column].astype(str))
        if train_sessions.intersection(eval_sessions):
            raise ValueError(f"training and {partition_name} partitions share session identifiers")

        if group_column and group_column in part.columns:
            eval_groups = set(part[group_column].astype(str))
            if train_groups.intersection(eval_groups):
                raise ValueError(f"training and {partition_name} partitions share group identifiers")

        if embargo_seconds > 0:
            embargo_start = eval_end
            embargo_end = embargo_start + pd.to_timedelta(float(embargo_seconds), unit="s")
            violating = train[
                (train["start_time"] >= embargo_start) & (train["start_time"] < embargo_end)
            ]
            if not violating.empty:
                raise ValueError(
                    f"found {len(violating)} training sessions within embargo window of '{partition_name}' partition"
                )

        if latest_eval_end is None or eval_end > latest_eval_end:
            latest_eval_end = eval_end

    if embargo_seconds > 0 and latest_eval_end is not None:
        embargo_cutoff = latest_eval_end + pd.to_timedelta(float(embargo_seconds), unit="s")
        future_train = train[train["start_time"] >= latest_eval_end]
        if not future_train.empty:
            violating = future_train[future_train["start_time"] < embargo_cutoff]
            if not violating.empty:
                raise ValueError("training set includes sessions that violate the global embargo cutoff")


def build_partition_payload(frame: pd.DataFrame, *, session_column: str) -> SplitPartition:
    if frame.empty:
        return SplitPartition(
            sessions=[],
            users=[],
            time_range={"start": None, "end": None},
            counts={"sessions": 0, "events": 0, "positive_events": 0, "negative_events": 0, "positive_sessions": 0},
        )
    time_range = {
        "start": _ts_to_iso(frame["start_time"].min()),
        "end": _ts_to_iso(frame["end_time"].max()),
    }
    counts = {
        "sessions": int(len(frame)),
        "events": int(frame["events"].sum()),
        "positive_events": int(frame["positive_events"].sum()),
        "negative_events": int(frame["negative_events"].sum()),
        "positive_sessions": int(frame["has_positive"].sum()),
    }
    users = sorted({str(value) for value in frame["group"].astype(str)})
    sessions = frame[session_column].astype(str).tolist()
    return SplitPartition(sessions=sessions, users=users, time_range=time_range, counts=counts)


def build_summary(
    *,
    total_events: int,
    total_sessions: int,
    median_delta_seconds: float,
    max_session_duration_seconds: float,
    embargo_seconds: float,
) -> SplitSummary:
    return SplitSummary(
        total_events=total_events,
        total_sessions=total_sessions,
        median_delta_seconds=median_delta_seconds,
        max_session_duration_seconds=max_session_duration_seconds,
        embargo_seconds=embargo_seconds,
    )


def manifest_meta(
    *,
    mode: str,
    params: Mapping[str, Any],
    data_hash: str,
    created_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    created = created_at or datetime.now(timezone.utc)
    ordered_params = {"mode": mode}
    for key in sorted(params):
        ordered_params[key] = params[key]
    return {
        "data_hash": data_hash,
        "created_at": created.astimezone(timezone.utc).isoformat(),
        "params": ordered_params,
    }
