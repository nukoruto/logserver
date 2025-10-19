from __future__ import annotations

import pytest
import yaml

import pandas as pd

from trainer.logserver.cv import RollingSplitConfig, generate_rolling_origin_splits
from trainer.scripts import tscv as tscv_cli


_DEF_BASE_TIME = pd.Timestamp("2024-01-01T00:00:00Z")


def _build_sample_events() -> pd.DataFrame:
    sessions = [
        ("sess-000", "user-a", 0),
        ("sess-001", "user-b", 1),
        ("sess-002", "user-a", 2),
        ("sess-003", "user-b", 3),
        ("sess-004", "user-c", 4),
        ("sess-005", "user-b", 5),
        ("sess-006", "user-c", 6),
        ("sess-007", "user-a", 7),
        ("sess-008", "user-c", 8),
    ]
    rows = []
    for session_id, user, offset in sessions:
        for step in range(3):
            timestamp = _DEF_BASE_TIME + pd.Timedelta(seconds=offset * 60 + step * 10)
            label = 1 if step == 2 and user == "user-c" else 0
            rows.append(
                {
                    "timestamp_utc": timestamp.isoformat(),
                    "uid": user,
                    "session_id": session_id,
                    "method": "GET",
                    "path": f"/resource/{session_id}",
                    "referer": "",
                    "user_agent": "pytest",
                    "ip": "192.0.2.1",
                    "op_category": "READ",
                    "label": label,
                }
            )
    return pd.DataFrame(rows)


def test_generate_rolling_origin_splits_disjoint_sets():
    frame = _build_sample_events()
    config = RollingSplitConfig(
        rolling="expanding",
        window_l=0,
        horizon=1,
        folds=2,
        embargo=None,
        timestamp_column="timestamp_utc",
        group_column="uid",
        session_column="session_id",
        label_column="label",
        seed=123,
    )
    result = generate_rolling_origin_splits(frame, config)
    assert result["summary"]["total_sessions"] == 9
    assert result["summary"]["total_events"] == len(frame)
    assert result["config"]["embargo_seconds"] == pytest.approx(20.0)
    assert len(result["folds"]) == 2
    for fold in result["folds"]:
        train = set(fold["sessions"]["train"])
        dev = set(fold["sessions"]["dev"])
        test = set(fold["sessions"]["test"])
        embargo = set(fold["sessions"]["embargo"])
        assert train.isdisjoint(dev)
        assert train.isdisjoint(test)
        assert train.isdisjoint(embargo)
        assert fold["counts"]["train"]["sessions"] > 0
        assert fold["counts"]["dev"]["sessions"] == 1
        assert fold["counts"]["test"]["sessions"] == 1


def test_tscv_cli_split(tmp_path):
    frame = _build_sample_events()
    input_path = tmp_path / "events.csv"
    frame.to_csv(input_path, index=False)
    output_path = tmp_path / "splits.yaml"
    argv = [
        "split",
        "--in",
        str(input_path),
        "--group",
        "uid",
        "--session-column",
        "session_id",
        "--timestamp-column",
        "timestamp_utc",
        "--label-column",
        "label",
        "--rolling",
        "expanding",
        "--window_l",
        "0",
        "--horizon",
        "1",
        "--folds",
        "2",
        "--embargo",
        "auto",
        "--out",
        str(output_path),
    ]
    exit_code = tscv_cli.main(argv)
    assert exit_code == 0
    assert output_path.exists()
    with output_path.open("r", encoding="utf-8") as handle:
        payload = yaml.safe_load(handle)
    assert payload["summary"]["total_sessions"] == 9
    assert payload["config"]["group_column"] == "uid"
    assert len(payload["folds"]) == 2
    for fold in payload["folds"]:
        train = set(fold["sessions"]["train"])
        dev = set(fold["sessions"]["dev"])
        test = set(fold["sessions"]["test"])
        embargo = set(fold["sessions"]["embargo"])
        assert train.isdisjoint(dev)
        assert train.isdisjoint(test)
        assert train.isdisjoint(embargo)
