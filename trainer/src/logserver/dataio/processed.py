# -*- coding: utf-8 -*-
"""Utilities for loading processed event datasets with CSV fallback."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)


def _log(level: int, payload: dict) -> None:
    logger.log(level, json.dumps(payload, ensure_ascii=False))


def _normalise_timestamp(df: pd.DataFrame) -> pd.DataFrame:
    if "timestamp" in df.columns:
        df = df.copy()
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    return df


def load_processed_events(processed_dir: Path) -> pd.DataFrame:
    """Load processed events preferring Parquet but falling back to CSV."""

    parquet_path = processed_dir / "events.parquet"
    csv_path = processed_dir / "events.csv"

    parquet_exception: Optional[BaseException] = None
    if parquet_path.exists():
        try:
            df = pd.read_parquet(parquet_path)
            _log(
                logging.INFO,
                {
                    "event": "load_processed_events",
                    "format": "parquet",
                    "path": str(parquet_path),
                    "status": "loaded",
                },
            )
            return df
        except (ImportError, ValueError, OSError) as exc:
            parquet_exception = exc
            _log(
                logging.WARNING,
                {
                    "event": "load_processed_events",
                    "format": "parquet",
                    "path": str(parquet_path),
                    "status": "failed",
                    "fallback": "csv",
                    "reason": exc.__class__.__name__,
                },
            )
    else:
        _log(
            logging.INFO,
            {
                "event": "load_processed_events",
                "format": "parquet",
                "path": str(parquet_path),
                "status": "missing",
                "fallback": "csv",
            },
        )

    if csv_path.exists():
        df = pd.read_csv(csv_path)
        df = _normalise_timestamp(df)
        payload = {
            "event": "load_processed_events",
            "format": "csv",
            "path": str(csv_path),
            "status": "loaded",
        }
        if parquet_exception is not None:
            payload["parquet_error"] = parquet_exception.__class__.__name__
        _log(logging.INFO, payload)
        return df

    raise FileNotFoundError(
        f"Neither {parquet_path} nor {csv_path} is available under {processed_dir}"
    )

