# -*- coding: utf-8 -*-
from pathlib import Path

import pandas as pd
import pytest

from trainer.logserver.dataio.sessionize import (
    SessionConfig,
    SessionizeError,
    iter_sessionized_frames,
    load_events,
    sessionize,
)


def test_sessionize_computes_delta(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp_utc": [
                "2024-01-01T00:00:00Z",
                "2024-01-01T00:00:05Z",
                "2024-01-01T00:00:12Z",
            ],
            "uid": ["u1", "u1", "u1"],
            "session_id": ["s1", "s1", "s1"],
            "method": ["GET", "GET", "POST"],
            "path": ["/login", "/dashboard", "/logout"],
            "referer": ["", "", ""],
            "user_agent": ["ua", "ua", "ua"],
            "ip": ["127.0.0.1", "127.0.0.1", "127.0.0.1"],
            "op_category": ["AUTH", "READ", "AUTH"],
        }
    )
    df.to_csv(raw_path, index=False)
    processed = sessionize(raw_path, tmp_path, SessionConfig())
    assert "delta_t" in processed.columns
    assert processed.loc[1, "delta_t"] == 5.0
    assert processed.loc[2, "delta_t"] == 7.0
    assert processed["template_id"].tolist() == [
        "AUTH::GET::login",
        "READ::GET::dashboard",
        "AUTH::POST::logout",
    ]


@pytest.mark.parametrize("forbidden_column", ["jwt", "Authorization", "Cookie"])
def test_sessionize_rejects_raw_token_columns(tmp_path: Path, forbidden_column: str) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp_utc": ["2024-01-01T00:00:00Z"],
            "uid": ["u1"],
            "session_id": ["s1"],
            "method": ["GET"],
            "path": ["/login"],
            "referer": [""],
            "user_agent": ["ua"],
            "ip": ["127.0.0.1"],
            "op_category": ["AUTH"],
            forbidden_column: ["header.payload.signature"],
        }
    )
    df.to_csv(raw_path, index=False)

    with pytest.raises(SessionizeError) as excinfo:
        sessionize(raw_path, tmp_path, SessionConfig())
    assert f"Forbidden column '{forbidden_column}'" in str(excinfo.value)


def test_load_events_chunk_iteration(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp_utc": [
                "2024-01-01T00:00:00Z",
                "2024-01-01T00:00:01Z",
                "2024-01-01T00:00:02Z",
            ],
            "uid": ["u1", "u1", "u2"],
            "session_id": ["s1", "s1", "s2"],
            "method": ["GET", "GET", "POST"],
            "path": ["/login", "/dashboard", "/logout"],
            "referer": ["", "", ""],
            "user_agent": ["ua", "ua", "ua"],
            "ip": ["127.0.0.1", "127.0.0.1", "127.0.0.2"],
            "op_category": ["AUTH", "READ", "AUTH"],
        }
    )
    df.to_csv(raw_path, index=False)
    iterator = load_events(raw_path, chunksize=2, collect=False)
    frames = list(iterator)
    assert len(frames) == 2
    assert sum(len(frame) for frame in frames) == len(df)


def test_iter_sessionized_frames_streams(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp_utc": [
                "2024-01-01T00:00:00Z",
                "2024-01-01T00:00:01Z",
                "2024-01-01T00:00:03Z",
                "2024-01-01T00:05:00Z",
            ],
            "uid": ["u1", "u1", "u1", "u1"],
            "method": ["GET", "GET", "POST", "POST"],
            "path": ["/login", "/view", "/edit", "/logout"],
            "referer": ["", "", "", ""],
            "user_agent": ["ua", "ua", "ua", "ua"],
            "ip": ["127.0.0.1"] * 4,
            "op_category": ["AUTH", "READ", "UPDATE", "AUTH"],
        }
    )
    df.to_csv(raw_path, index=False)
    config = SessionConfig(idle_timeout=60, tz="UTC", chunksize=2)
    chunks = list(iter_sessionized_frames(raw_path, config))
    assert len(chunks) == 2
    total = sum(len(chunk) for chunk in chunks)
    assert total == len(df)
    combined = pd.concat(chunks, ignore_index=True)
    assert combined.iloc[0]["delta_t"] == 0.0
    assert combined.iloc[1]["delta_t"] == 1.0
    assert combined.iloc[3]["delta_t"] == 0.0


def test_sessionize_event_column_backwards_compatible(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp_utc": ["2024-01-01T00:00:00Z", "2024-01-01T00:00:05Z"],
            "uid": ["u1", "u1"],
            "session_id": ["s1", "s1"],
            "method": ["GET", "POST"],
            "path": ["/login", "/logout"],
            "referer": ["", ""],
            "user_agent": ["ua", "ua"],
            "ip": ["127.0.0.1", "127.0.0.1"],
            "op_category": ["AUTH", "AUTH"],
            "event": ["custom_login", ""],
        }
    )
    df.to_csv(raw_path, index=False)
    processed = sessionize(raw_path, tmp_path, SessionConfig())
    assert processed.loc[0, "event"] == "custom_login"
    assert processed.loc[1, "event"] == "AUTH::POST::logout"
    assert processed.loc[1, "template_id"] == "AUTH::POST::logout"


def test_timestamp_utc_follows_timezone_conversion(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp": ["2024-01-01T00:00:00+09:00"],
            "uid": ["u1"],
            "session_id": ["s1"],
            "method": ["GET"],
            "path": ["/login"],
            "referer": [""],
            "user_agent": ["ua"],
            "ip": ["127.0.0.1"],
            "op_category": ["AUTH"],
        }
    )
    df.to_csv(raw_path, index=False)
    processed = sessionize(raw_path, tmp_path, SessionConfig(tz="Asia/Tokyo"))
    timestamp_value = processed.loc[0, "timestamp"]
    assert processed.loc[0, "timestamp_utc"] == timestamp_value.isoformat().replace("+00:00", "Z")
