# -*- coding: utf-8 -*-
"""Utilities for loading processed event datasets with CSV fallback."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Iterator, Optional

import pandas as pd

logger = logging.getLogger(__name__)

try:  # pragma: no cover - optional dependency
    import pyarrow as pa
    import pyarrow.dataset as ds
except Exception:  # pragma: no cover
    pa = None
    ds = None

if pa is not None:  # pragma: no cover - optional dependency guard
    _ARROW_EXCEPTIONS = (pa.ArrowException,)
else:  # pragma: no cover - fallback
    _ARROW_EXCEPTIONS = tuple()

_FALLBACK_EXCEPTIONS = (ImportError, ValueError, OSError) + _ARROW_EXCEPTIONS


def _log(level: int, payload: dict) -> None:
    logger.log(level, json.dumps(payload, ensure_ascii=False))


def _normalise_timestamp(df: pd.DataFrame) -> pd.DataFrame:
    if "timestamp" in df.columns:
        df = df.copy()
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    return df


def _iter_parquet(path: Path, batch_size: int, use_pyarrow: bool) -> Iterator[pd.DataFrame]:
    if use_pyarrow and ds is not None and pa is not None:
        dataset = ds.dataset(path)
        for batch in dataset.scanner(batch_size=batch_size).to_batches():
            table = pa.Table.from_batches([batch])
            yield _normalise_timestamp(table.to_pandas())
        return
    df = pd.read_parquet(path)
    yield _normalise_timestamp(df)


def _iter_csv(path: Path, chunksize: int) -> Iterator[pd.DataFrame]:
    reader = pd.read_csv(path, chunksize=chunksize)
    for chunk in reader:
        yield _normalise_timestamp(chunk)


def load_processed_events(
    processed_dir: Path,
    *,
    chunksize: Optional[int] = None,
    use_pyarrow: bool = True,
    collect: bool = True,
) -> Iterator[pd.DataFrame] | pd.DataFrame:
    """Load processed events preferring Parquet but supporting streaming."""

    parquet_path = processed_dir / "events.parquet"
    csv_path = processed_dir / "events.csv"
    chunk = chunksize or 100_000

    parquet_exception: Optional[BaseException] = None
    iterator: Optional[Iterator[pd.DataFrame]] = None
    if parquet_path.exists():
        try:
            iterator = _iter_parquet(parquet_path, chunk, use_pyarrow)
            _log(
                logging.INFO,
                {
                    "event": "load_processed_events",
                    "format": "parquet",
                    "path": str(parquet_path),
                    "status": "loaded",
                    "mode": "stream" if not collect else "batch",
                },
            )
        except _FALLBACK_EXCEPTIONS as exc:  # pragma: no cover - fallback
            parquet_exception = exc
            iterator = None
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

    if iterator is None and csv_path.exists():
        iterator = _iter_csv(csv_path, chunk)
        payload = {
            "event": "load_processed_events",
            "format": "csv",
            "path": str(csv_path),
            "status": "loaded",
            "mode": "stream" if not collect else "batch",
        }
        if parquet_exception is not None:
            payload["parquet_error"] = parquet_exception.__class__.__name__
        _log(logging.INFO, payload)

    if iterator is None:
        raise FileNotFoundError(
            f"Neither {parquet_path} nor {csv_path} is available under {processed_dir}"
        )

    if not collect:
        return iterator

    frames = list(iterator)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

