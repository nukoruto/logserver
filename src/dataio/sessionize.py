# -*- coding: utf-8 -*-
"""Sessionization utilities for Δt-aware modelling."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

import numpy as np
import pandas as pd

REQUIRED_COLUMNS = {"timestamp", "user_id", "event"}
OPTIONAL_COLUMNS = {"session_id", "method", "path", "status", "status_code", "latency_ms", "meta", "metadata"}


@dataclass
class SessionConfig:
    """Configuration for building sessions from raw logs."""

    idle_timeout: int = 1800
    tz: str = "UTC"


class SessionizeError(Exception):
    """Raised when the sessionization pipeline fails."""


def _expand_source(source: Path) -> List[Path]:
    if source.is_dir():
        files = sorted(
            [p for p in source.rglob("*") if p.suffix.lower() in {".csv", ".json", ".parquet"}]
        )
        if not files:
            raise SessionizeError(f"No log files found under {source}")
        return files
    if source.exists():
        return [source]
    raise SessionizeError(f"Source path does not exist: {source}")


def _read_file(path: Path) -> pd.DataFrame:
    if path.suffix.lower() == ".csv":
        return pd.read_csv(path)
    if path.suffix.lower() == ".json":
        return pd.read_json(path, lines=True)
    if path.suffix.lower() == ".parquet":
        return pd.read_parquet(path)
    raise SessionizeError(f"Unsupported file extension: {path.suffix}")


def load_events(source: Path) -> pd.DataFrame:
    """Load raw log events from a file or directory containing CSV/JSON/Parquet."""

    frames = [_read_file(path) for path in _expand_source(source)]
    if not frames:
        raise SessionizeError(f"No frames produced from {source}")
    df = pd.concat(frames, ignore_index=True)
    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise SessionizeError(f"Missing required columns: {sorted(missing)}")
    return df


def _normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "status_code" in df.columns and "status" not in df.columns:
        df.rename(columns={"status_code": "status"}, inplace=True)
    if "meta" in df.columns and "metadata" not in df.columns:
        df.rename(columns={"meta": "metadata"}, inplace=True)
    if "metadata" not in df.columns:
        df["metadata"] = [{} for _ in range(len(df))]
    for col in ["method", "path"]:
        if col not in df.columns:
            df[col] = None
    if "latency_ms" not in df.columns:
        df["latency_ms"] = np.nan
    df["event"] = df["event"].astype(str).str.strip()
    df["user_id"] = df["user_id"].astype(str).str.strip()
    return df


def _ensure_timestamp(df: pd.DataFrame, tz: str) -> pd.DataFrame:
    df = df.copy()
    timestamps = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    if tz.upper() != "UTC":
        timestamps = timestamps.dt.tz_convert(tz).dt.tz_convert("UTC")
    if timestamps.isna().any():
        raise SessionizeError("Invalid timestamp encountered during conversion")
    df["timestamp"] = timestamps
    return df


def _assign_sessions(df: pd.DataFrame, idle_timeout: int) -> pd.DataFrame:
    df = df.copy()
    if "session_id" in df.columns and df["session_id"].notna().any():
        df.sort_values(["user_id", "session_id", "timestamp"], inplace=True)
        return df
    df.sort_values(["user_id", "timestamp"], inplace=True)
    session_keys: List[str] = []
    current_session = None
    last_time = None
    last_user = None
    for _, row in df.iterrows():
        user = row["user_id"]
        ts = row["timestamp"]
        if last_user != user or last_time is None:
            current_session = f"{user}-{ts.value}"
        else:
            diff = (ts - last_time).total_seconds()
            if diff > idle_timeout:
                current_session = f"{user}-{ts.value}"
        session_keys.append(current_session)
        last_user = user
        last_time = ts
    df["session_id"] = session_keys
    return df


def _compute_delta(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.sort_values(["session_id", "timestamp"], inplace=True)
    df["delta_t"] = (
        df.groupby("session_id")["timestamp"].diff().dt.total_seconds().fillna(0.0).clip(lower=0.0)
    )
    df["delta_t"] = df["delta_t"].astype(float)
    return df


def sessionize(source: Path, output_dir: Path, config: Optional[SessionConfig] = None) -> pd.DataFrame:
    """End-to-end sessionization pipeline returning the processed DataFrame."""

    config = config or SessionConfig()
    df = load_events(source)
    df = _normalise_columns(df)
    df = _ensure_timestamp(df, config.tz)
    df = _assign_sessions(df, config.idle_timeout)
    df = _compute_delta(df)

    output_dir.mkdir(parents=True, exist_ok=True)
    parquet_path = output_dir / "events.parquet"
    csv_path = output_dir / "events.csv"
    try:
        df.to_parquet(parquet_path, index=False)
    except (ImportError, ValueError):
        parquet_path = None
    df.to_csv(csv_path, index=False)
    return df


def main(args: Optional[Iterable[str]] = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Sessionize raw logs and compute delta_t features")
    parser.add_argument("--input", required=True, help="Path to input file or directory")
    parser.add_argument("--output", required=True, help="Directory to write processed dataset")
    parser.add_argument("--idle-timeout", type=int, default=1800, help="Session idle timeout in seconds")
    parser.add_argument("--tz", default="UTC", help="Timezone of source timestamps")
    parsed = parser.parse_args(args)

    sessionize(
        Path(parsed.input),
        Path(parsed.output),
        SessionConfig(idle_timeout=parsed.idle_timeout, tz=parsed.tz),
    )


if __name__ == "__main__":  # pragma: no cover
    main()
