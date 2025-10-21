from __future__ import annotations

import pandas as pd
import pytest

from trainer.logserver.split.group_val import SingleSplitConfig, make_single_split_with_group_holdout
from trainer.logserver.split.utils import aggregate_sessions, auto_embargo_seconds, prepare_events


def _build_sample_events() -> pd.DataFrame:
    base = pd.Timestamp("2024-01-01T00:00:00Z")
    sessions = [
        ("sess-a", "user-1", 0),
        ("sess-b", "user-2", 10),
        ("sess-c", "user-3", 20),
        ("sess-d", "user-2", 40),
        ("sess-e", "user-4", 60),
        ("sess-f", "user-5", 80),
    ]
    rows = []
    for session_id, user, offset in sessions:
        for idx in range(3):
            ts = base + pd.Timedelta(minutes=offset + idx)
            rows.append(
                {
                    "timestamp_utc": ts.isoformat(),
                    "uid": user,
                    "session_id": session_id,
                    "method": "GET",
                    "path": f"/r/{session_id}",
                    "op_category": "READ",
                }
            )
    return pd.DataFrame(rows)


def test_single_split_group_holdout_invariants():
    events = _build_sample_events()
    prepared = prepare_events(events, "timestamp_utc")
    sessions, delta_seconds, _ = aggregate_sessions(
        prepared,
        timestamp_column="timestamp_utc",
        group_column="uid",
        session_column="session_id",
        label_column=None,
    )
    config = SingleSplitConfig(
        timestamp_column="timestamp_utc",
        session_column="session_id",
        group_column="uid",
        group_key="user_id",
        val_fraction=0.3,
        embargo="auto",
        seed=123,
    )
    result = make_single_split_with_group_holdout(sessions, events, config=config, delta_seconds=delta_seconds)
    train_df = sessions[sessions["session_id"].isin(result.train_sessions)]
    val_df = sessions[sessions["session_id"].isin(result.val_sessions)]
    assert set(train_df["group"].astype(str)).isdisjoint(set(val_df["group"].astype(str)))
    assert train_df["end_time"].max() <= val_df["start_time"].min()
    embargo_seconds = result.manifest["meta"]["params"]["embargo_seconds"]
    cutoff = val_df["end_time"].max() + pd.to_timedelta(embargo_seconds, unit="s")
    assert not any((session_start >= val_df["end_time"].max()) and (session_start < cutoff) for session_start in train_df["start_time"])


def test_single_split_seed_changes_groups():
    events = _build_sample_events()
    prepared = prepare_events(events, "timestamp_utc")
    sessions, delta_seconds, _ = aggregate_sessions(
        prepared,
        timestamp_column="timestamp_utc",
        group_column="uid",
        session_column="session_id",
        label_column=None,
    )
    config_a = SingleSplitConfig(
        timestamp_column="timestamp_utc",
        session_column="session_id",
        group_column="uid",
        group_key="user_id",
        val_fraction=0.3,
        embargo=10.0,
        seed=1,
    )
    config_b = SingleSplitConfig(
        timestamp_column="timestamp_utc",
        session_column="session_id",
        group_column="uid",
        group_key="user_id",
        val_fraction=0.3,
        embargo=10.0,
        seed=99,
    )
    result_a = make_single_split_with_group_holdout(sessions, events, config=config_a, delta_seconds=delta_seconds)
    result_b = make_single_split_with_group_holdout(sessions, events, config=config_b, delta_seconds=delta_seconds)
    assert set(result_a.val_sessions) != set(result_b.val_sessions)


def test_auto_embargo_seconds_rule():
    events = _build_sample_events()
    prepared = prepare_events(events, "timestamp_utc")
    sessions, delta_seconds, _ = aggregate_sessions(
        prepared,
        timestamp_column="timestamp_utc",
        group_column="uid",
        session_column="session_id",
        label_column=None,
    )
    delta_values = [float(v) for v in delta_seconds if v > 0]
    expected = max(
        float((sessions["end_time"] - sessions["start_time"]).dt.total_seconds().max()),
        2.0 * float(pd.Series(delta_values).median()),
    )
    assert auto_embargo_seconds(sessions, delta_seconds) == pytest.approx(expected)
