# -*- coding: utf-8 -*-
"""Sessionization utilities for Δt-aware modelling."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Tuple
from urllib.parse import urlsplit

import numpy as np
import pandas as pd

try:  # pragma: no cover - import guard
    import pyarrow as pa
    import pyarrow.dataset as ds
    import pyarrow.parquet as pq
except Exception:  # pragma: no cover - optional dependency
    pa = None
    ds = None
    pq = None

logger = logging.getLogger(__name__)

CONTRACT_COLUMNS = {
    "timestamp",
    "timestamp_utc",
    "uid",
    "session_id",
    "method",
    "path",
    "referer",
    "user_agent",
    "ip",
    "cookie",
    "op_category",
    "template_id",
}
ALTERNATE_TIMESTAMP_COLUMNS = ("timestamp_utc",)
FORBIDDEN_COLUMNS = {"jwt", "authorization", "cookies", "Cookie"}
OPTIONAL_COLUMNS = {
    "session_id",
    "method",
    "path",
    "status",
    "status_code",
    "latency_ms",
    "response_bytes",
    "meta",
    "metadata",
}


DEFAULT_CHUNK_SIZE = 100_000

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_HEX_RE = re.compile(r"^[0-9a-fA-F]{12,}$")
_INT_RE = re.compile(r"^\d+$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{10,}$")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9{}]+")
_DIGIT_GROUP_RE = re.compile(r"\d+")


def _normalise_path_segment(segment: str) -> str:
    cleaned = segment.strip()
    if not cleaned:
        return "root"
    if _UUID_RE.match(cleaned):
        return "{uuid}"
    if _INT_RE.match(cleaned):
        return "{int}"
    if _HEX_RE.match(cleaned):
        return "{hex}"
    if _TOKEN_RE.match(cleaned):
        return "{token}"
    lowered = cleaned.lower()
    replaced = _DIGIT_GROUP_RE.sub("{num}", lowered)
    normalised = _NON_ALNUM_RE.sub("-", replaced)
    collapsed = re.sub(r"-{2,}", "-", normalised).strip("-")
    return collapsed or "{token}"


def _normalise_path_template(path_value: object) -> str:
    raw = "" if path_value is None else str(path_value).strip()
    if not raw:
        return "root"
    parsed = urlsplit(raw)
    candidate = parsed.path or raw
    segments = [segment for segment in candidate.split("/") if segment]
    if not segments:
        return "root"
    normalised_segments = [_normalise_path_segment(segment) for segment in segments]
    return "/".join(normalised_segments)


def derive_template_id(method: object, path_value: object, op_category: object) -> str:
    method_str = str(method or "").strip().upper() or "UNKNOWN"
    category = str(op_category or "").strip().upper() or "UNKNOWN"
    template_path = _normalise_path_template(path_value)
    return f"{category}::{method_str}::{template_path}"

def _is_empty_metadata(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and np.isnan(value):
        return True
    if isinstance(value, dict):
        return len(value) == 0
    return False


@dataclass
class SessionConfig:
    """Configuration for building sessions from raw logs."""

    idle_timeout: int = 1800
    tz: str = "UTC"
    chunksize: int = DEFAULT_CHUNK_SIZE
    use_pyarrow: bool = True


@dataclass
class _SessionState:
    last_timestamp: pd.Timestamp
    session_id: str


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


def _read_csv_chunks(path: Path, chunksize: int) -> Iterator[pd.DataFrame]:
    reader = pd.read_csv(path, chunksize=chunksize)
    for chunk in reader:
        yield chunk


def _read_json_chunks(path: Path, chunksize: int) -> Iterator[pd.DataFrame]:
    reader = pd.read_json(path, lines=True, chunksize=chunksize)
    for chunk in reader:
        yield chunk


def _read_parquet_batches(path: Path, batch_size: int, use_pyarrow: bool) -> Iterator[pd.DataFrame]:
    if not use_pyarrow or pq is None or ds is None:
        df = pd.read_parquet(path)
        yield df
        return
    dataset = ds.dataset(path)
    scanner = dataset.scanner(batch_size=batch_size)
    for record_batch in scanner.to_batches():
        table = pa.Table.from_batches([record_batch])
        yield table.to_pandas()


def _iter_raw_frames(paths: List[Path], chunksize: int, use_pyarrow: bool) -> Iterator[pd.DataFrame]:
    for path in paths:
        suffix = path.suffix.lower()
        if suffix == ".csv":
            yield from _read_csv_chunks(path, chunksize)
        elif suffix == ".json":
            yield from _read_json_chunks(path, chunksize)
        elif suffix == ".parquet":
            yield from _read_parquet_batches(path, chunksize, use_pyarrow)
        else:
            raise SessionizeError(f"Unsupported file extension: {path.suffix}")


def load_events(
    source: Path,
    *,
    chunksize: Optional[int] = None,
    use_pyarrow: bool = True,
    collect: bool = True,
) -> Iterator[pd.DataFrame] | pd.DataFrame:
    """Load raw log events with optional chunked iteration."""

    paths = _expand_source(source)
    chunk = chunksize or DEFAULT_CHUNK_SIZE

    def _iterator() -> Iterator[pd.DataFrame]:
        for frame in _iter_raw_frames(paths, chunk, use_pyarrow):
            if frame.empty:
                continue
            normalised = _normalise_columns(frame)
            if "timestamp" not in normalised.columns:
                raise SessionizeError("Column 'timestamp' is required after normalisation")
            yield normalised

    if not collect:
        return _iterator()

    frames = list(_iterator())
    if not frames:
        raise SessionizeError(f"No frames produced from {source}")
    df = pd.concat(frames, ignore_index=True)
    missing = CONTRACT_COLUMNS - set(df.columns)
    if missing:
        raise SessionizeError(f"Missing required columns: {sorted(missing)}")
    return df


def _normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    for column in df.columns:
        lowered = column.lower()
        if lowered in FORBIDDEN_COLUMNS or column in FORBIDDEN_COLUMNS:
            raise SessionizeError(
                f"Forbidden column '{column}' detected. Ensure tokens are removed prior to preprocessing."
            )
    if "timestamp" not in df.columns:
        for alt in ALTERNATE_TIMESTAMP_COLUMNS:
            if alt in df.columns:
                df.rename(columns={alt: "timestamp"}, inplace=True)
                break
    if "timestamp" not in df.columns:
        raise SessionizeError("Column 'timestamp_utc' is required for sessionization")
    raw_timestamp = df["timestamp"]
    numeric_candidate = pd.to_numeric(raw_timestamp, errors="coerce")
    if numeric_candidate.notna().all():
        timestamps = pd.to_datetime(numeric_candidate, utc=True, unit="s", errors="coerce")
    else:
        timestamp_strings = raw_timestamp.astype(str).str.strip()
        timestamps = pd.to_datetime(timestamp_strings, utc=True, errors="coerce")
    if timestamps.isna().any():
        raise SessionizeError("Column 'timestamp' contains invalid values")
    canonical_strings = timestamps.dt.tz_convert("UTC").dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    df["timestamp"] = canonical_strings
    df["timestamp_utc"] = canonical_strings
    if "status_code" in df.columns and "status" not in df.columns:
        df.rename(columns={"status_code": "status"}, inplace=True)
    if "meta" in df.columns and "metadata" not in df.columns:
        df.rename(columns={"meta": "metadata"}, inplace=True)
    if "metadata" not in df.columns:
        df["metadata"] = pd.Series([{}] * len(df), dtype=object)
    if "uid" not in df.columns and "user_id" in df.columns:
        df.rename(columns={"user_id": "uid"}, inplace=True)
    if "uid" not in df.columns:
        raise SessionizeError("Column 'uid' is required for sessionization")
    df["uid"] = df["uid"].astype(str).str.strip()
    length = len(df)

    def _string_series(name: str, default: str = "") -> pd.Series:
        if name in df.columns:
            series = df[name]
        else:
            series = pd.Series([default] * length)
        return series.astype("string").fillna("").str.strip()

    session_series = df["session_id"] if "session_id" in df.columns else pd.Series([pd.NA] * length)
    session_series = session_series.astype("string").str.strip()
    session_series = session_series.replace({"": pd.NA, "nan": pd.NA, "None": pd.NA, "<NA>": pd.NA})
    df["session_id"] = session_series

    method_series = _string_series("method")
    df["method"] = method_series.str.upper()
    df.loc[df["method"] == "", "method"] = "UNKNOWN"

    df["path"] = _string_series("path")
    df["referer"] = _string_series("referer")
    df["user_agent"] = _string_series("user_agent")
    df["ip"] = _string_series("ip")

    category_series = _string_series("op_category").str.upper()
    category_series = category_series.replace({"": "UNKNOWN"})
    df["op_category"] = category_series
    if "latency_ms" not in df.columns:
        df["latency_ms"] = np.nan
    else:
        df["latency_ms"] = pd.to_numeric(df["latency_ms"], errors="coerce")
    if "response_bytes" not in df.columns:
        df["response_bytes"] = np.nan
    else:
        df["response_bytes"] = pd.to_numeric(df["response_bytes"], errors="coerce")
    template_ids = [
        derive_template_id(method, path, category)
        for method, path, category in zip(df["method"], df["path"], df["op_category"])
    ]
    df["template_id"] = pd.Series(template_ids, dtype=object)
    if "event" in df.columns:
        df["event"] = df["event"].astype("string").fillna("").str.strip()
    else:
        df["event"] = pd.Series(["" for _ in range(length)], dtype="string")
    empty_mask = df["event"].astype(str).str.strip() == ""
    df.loc[empty_mask, "event"] = df.loc[empty_mask, "template_id"]
    return df


def _ensure_timestamp(df: pd.DataFrame, tz: str) -> pd.DataFrame:
    df = df.copy()
    timestamps = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    if tz.upper() != "UTC":
        timestamps = timestamps.dt.tz_convert(tz).dt.tz_convert("UTC")
    if timestamps.isna().any():
        raise SessionizeError("Invalid timestamp encountered during conversion")
    df["timestamp"] = timestamps
    df["timestamp_utc"] = timestamps.map(
        lambda ts: ts.isoformat().replace("+00:00", "Z") if pd.notna(ts) else ""
    )
    return df


def _apply_session_state(
    df: pd.DataFrame,
    idle_timeout: int,
    state: Dict[str, _SessionState],
) -> pd.DataFrame:
    df = df.copy()
    if "session_id" in df.columns and df["session_id"].notna().any():
        df.sort_values(["uid", "session_id", "timestamp"], inplace=True)
        deltas = (
            df.groupby("session_id")["timestamp"].diff().dt.total_seconds().fillna(0.0).clip(lower=0.0)
        )
        df["delta_t"] = deltas.astype(float)
        for uid, session_df in df.groupby("uid"):
            last_row = session_df.iloc[-1]
            state[str(uid)] = _SessionState(
                last_timestamp=last_row["timestamp"],
                session_id=str(last_row["session_id"]),
            )
        return df

    df.sort_values(["uid", "timestamp"], inplace=True)
    session_ids: List[str] = []
    deltas: List[float] = []
    for row in df.itertuples(index=False):
        uid = str(getattr(row, "uid"))
        timestamp = getattr(row, "timestamp")
        if pd.isna(timestamp):
            raise SessionizeError("Encountered NaT timestamp during session assignment")
        current_state = state.get(uid)
        if current_state is None:
            session_id = f"{uid}-{int(timestamp.value)}"
            delta = 0.0
        else:
            diff = (timestamp - current_state.last_timestamp).total_seconds()
            if diff < 0:
                diff = 0.0
            if diff > idle_timeout:
                session_id = f"{uid}-{int(timestamp.value)}"
                delta = 0.0
            else:
                session_id = current_state.session_id
                delta = diff
        state[uid] = _SessionState(last_timestamp=timestamp, session_id=session_id)
        session_ids.append(session_id)
        deltas.append(float(delta))
    df["session_id"] = session_ids
    df["delta_t"] = np.asarray(deltas, dtype=float)
    df.sort_values(["session_id", "timestamp"], inplace=True)
    return df


def iter_sessionized_frames(
    source: Path,
    config: Optional[SessionConfig] = None,
    *,
    raw_iter: Optional[Iterable[pd.DataFrame]] = None,
) -> Iterator[pd.DataFrame]:
    """Yield processed frames while maintaining session state across chunks."""

    cfg = config or SessionConfig()
    iterator = raw_iter
    if iterator is None:
        iterator = load_events(
            source,
            chunksize=cfg.chunksize,
            use_pyarrow=cfg.use_pyarrow,
            collect=False,
        )
    state: Dict[str, _SessionState] = {}
    for frame in iterator:
        if frame.empty:
            continue
        stamped = _ensure_timestamp(frame, cfg.tz)
        processed = _apply_session_state(stamped, cfg.idle_timeout, state)
        yield processed


def _write_sessionized_output(
    frames: Iterable[pd.DataFrame],
    output_dir: Path,
    *,
    use_pyarrow: bool,
) -> Tuple[int, Optional[BaseException], List[str]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    parquet_path = output_dir / "events.parquet"
    csv_path = output_dir / "events.csv"
    parquet_writer: Optional["pq.ParquetWriter"] = None
    parquet_error: Optional[BaseException] = None
    total_rows = 0
    first_chunk = True
    columns: List[str] = []
    for frame in frames:
        total_rows += len(frame)
        if not columns and not frame.empty:
            columns = list(frame.columns)
        arrow_ready = frame
        if use_pyarrow and pq is not None and pa is not None:
            needs_conversion = False
            for column in frame.columns:
                series = frame[column]
                if series.dtype == object and series.map(lambda value: isinstance(value, dict)).any():
                    needs_conversion = True
                    break
            if needs_conversion:
                arrow_ready = frame.copy()
                for column in arrow_ready.columns:
                    series = arrow_ready[column]
                    if series.dtype == object and series.map(lambda value: isinstance(value, dict)).any():
                        arrow_ready[column] = series.map(
                            lambda value: json.dumps(value, ensure_ascii=False)
                            if isinstance(value, dict)
                            else value
                        )
        if use_pyarrow and pq is not None and pa is not None:
            try:
                table = pa.Table.from_pandas(arrow_ready, preserve_index=False)
                if parquet_writer is None:
                    parquet_writer = pq.ParquetWriter(parquet_path, table.schema)
                parquet_writer.write_table(table)
            except (ImportError, ValueError, OSError) as exc:  # pragma: no cover - fallback path
                parquet_error = exc
                use_pyarrow = False
                parquet_writer = None
                try:
                    parquet_path.unlink()
                except OSError:
                    pass
        frame.to_csv(csv_path, mode="w" if first_chunk else "a", header=first_chunk, index=False)
        first_chunk = False
    if parquet_writer is not None:
        parquet_writer.close()
    return total_rows, parquet_error, columns


def sessionize(
    source: Path,
    output_dir: Path,
    config: Optional[SessionConfig] = None,
    *,
    raw_df: Optional[pd.DataFrame] = None,
    collect_output: bool = True,
) -> pd.DataFrame:
    """End-to-end sessionization pipeline returning the processed DataFrame."""

    config = config or SessionConfig()
    if raw_df is not None:
        raw_iter = [_normalise_columns(raw_df)]
    else:
        raw_iter = None

    collected: List[pd.DataFrame] = []

    def _stream() -> Iterator[pd.DataFrame]:
        for frame in iter_sessionized_frames(source, config, raw_iter=raw_iter):
            if collect_output:
                collected.append(frame.copy())
            yield frame

    total_rows, parquet_error, columns = _write_sessionized_output(
        _stream(),
        output_dir,
        use_pyarrow=config.use_pyarrow,
    )
    payload = {
        "event": "sessionize_output",
        "output_dir": str(output_dir),
        "rows": int(total_rows),
        "columns": columns if columns else (list(collected[0].columns) if collected else []),
        "csv_path": str(output_dir / "events.csv"),
        "csv_status": "written" if total_rows > 0 else "empty",
    }
    if config.use_pyarrow and parquet_error is None and pq is not None and pa is not None:
        payload.update(
            {
                "parquet_path": str(output_dir / "events.parquet"),
                "parquet_status": "written",
            }
        )
    else:
        payload.update(
            {
                "parquet_path": str(output_dir / "events.parquet"),
                "parquet_status": "unavailable",
                "fallback": "csv",
            }
        )
        if parquet_error is not None:
            payload["reason"] = parquet_error.__class__.__name__
    logger.info(json.dumps(payload, ensure_ascii=False))
    if not collect_output:
        return pd.DataFrame()
    return pd.concat(collected, ignore_index=True) if collected else pd.DataFrame()


def main(args: Optional[Iterable[str]] = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Sessionize raw logs and compute delta_t features")
    parser.add_argument("--input", required=True, help="Path to input file or directory")
    parser.add_argument("--output", required=True, help="Directory to write processed dataset")
    parser.add_argument("--idle-timeout", type=int, default=1800, help="Session idle timeout in seconds")
    parser.add_argument("--tz", default="UTC", help="Timezone of source timestamps")
    parser.add_argument("--chunksize", type=int, default=DEFAULT_CHUNK_SIZE, help="Chunk size for streaming reads")
    parser.add_argument(
        "--disable-pyarrow",
        action="store_true",
        help="Disable PyArrow streaming support",
    )
    parsed = parser.parse_args(args)

    sessionize(
        Path(parsed.input),
        Path(parsed.output),
        SessionConfig(
            idle_timeout=parsed.idle_timeout,
            tz=parsed.tz,
            chunksize=parsed.chunksize,
            use_pyarrow=not parsed.disable_pyarrow,
        ),
    )


if __name__ == "__main__":  # pragma: no cover
    main()
