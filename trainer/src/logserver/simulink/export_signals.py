"""Utilities for exporting reference and LSTM signals to Simulink-compatible MAT files.

This module provides a CLI to convert reference and predicted time series stored in CSV files
into MATLAB structs that the Simulink "From Workspace" block can consume directly. The
resulting MAT file stores `r`, `yLSTM`, and a `meta` struct containing reproducibility
metadata such as hashes and timestamps.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path
from typing import Iterable, Tuple

import numpy as np
import pandas as pd
from scipy.io import savemat


DEFAULT_TIME_COLUMN = "time"
DEFAULT_REFERENCE_VALUE_COLUMN = "value"
DEFAULT_SCORES_VALUE_COLUMN = "y"


class SignalExportError(RuntimeError):
    """Raised when signal export encounters invalid input data."""


def _resolve_time_series(series: pd.Series) -> np.ndarray:
    """Convert a pandas Series into UTC seconds represented as float64."""
    if series.empty:
        raise SignalExportError("時間列が空です。入力CSVを確認してください。")

    if np.issubdtype(series.dtype, np.number):
        values = series.astype("float64").to_numpy(copy=False)
    else:
        parsed = pd.to_datetime(series, utc=True, errors="coerce")
        if parsed.isna().any():
            raise SignalExportError("時間列に変換できない値があります。UTC時刻を指定してください。")
        if parsed.dt.tz is None:
            parsed = parsed.dt.tz_localize("UTC")
        values = parsed.view("int64").astype(np.float64) / 1e9
    if not np.isfinite(values).all():
        raise SignalExportError("時間列に非有限値が含まれています。")
    return values


def _resolve_value_series(series: pd.Series) -> np.ndarray:
    """Validate and convert the value column to float64."""
    if series.empty:
        raise SignalExportError("値列が空です。入力CSVを確認してください。")
    try:
        values = pd.to_numeric(series, errors="raise").astype("float64").to_numpy(copy=False)
    except (TypeError, ValueError) as exc:  # pragma: no cover - defensive
        raise SignalExportError("値列をfloat64へ変換できません。数値のみを含めてください。") from exc
    if not np.isfinite(values).all():
        raise SignalExportError("値列にNaNまたは無限大が含まれています。")
    return values


def load_series(
    csv_path: Path,
    time_column: str,
    value_column: str,
) -> Tuple[np.ndarray, np.ndarray]:
    """Load a time series from CSV and return (times, values) in UTC seconds."""
    if not csv_path.is_file():
        raise SignalExportError(f"CSVが存在しません: {csv_path}")
    df = pd.read_csv(csv_path)
    if time_column not in df.columns:
        raise SignalExportError(f"時間列 '{time_column}' が見つかりません。利用可能な列: {list(df.columns)}")
    if value_column not in df.columns:
        raise SignalExportError(f"値列 '{value_column}' が見つかりません。利用可能な列: {list(df.columns)}")

    times = _resolve_time_series(df[time_column])
    values = _resolve_value_series(df[value_column])

    if times.shape[0] != values.shape[0]:
        raise SignalExportError("時間列と値列の長さが一致しません。")
    if times.size == 0:
        raise SignalExportError("データ長が0です。入力CSVを確認してください。")

    sort_idx = np.argsort(times, kind="mergesort")
    times = times[sort_idx]
    values = values[sort_idx]

    if np.any(np.diff(times) < 0):
        raise SignalExportError("時間列が単調増加ではありません。UTC秒で昇順ソートしてください。")

    return times, values


def to_from_workspace_struct(times: np.ndarray, values: np.ndarray, label: str) -> dict:
    """Create a struct compatible with Simulink From Workspace blocks."""
    return {
        "time": times.astype(np.float64),
        "signals": {
            "values": values.reshape(-1, 1).astype(np.float64),
            "dimensions": np.array([[1]], dtype=np.uint32),
            "label": np.array([[label]], dtype=object),
        },
    }


def _sha256_of_files(paths: Iterable[Path]) -> str:
    digest = hashlib.sha256()
    for file_path in paths:
        digest.update(file_path.read_bytes())
    return digest.hexdigest()


def _git_commit() -> str:
    try:
        import subprocess

        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return result.stdout.strip()
    except Exception:  # pragma: no cover - Git不在環境向けフォールバック
        return "UNKNOWN"


def save_mat(out_path: Path, r_struct: dict, y_struct: dict, meta: dict) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    savemat(out_path, {"r": r_struct, "yLSTM": y_struct, "meta": meta}, do_compression=True)


def _build_meta(ts: float, data_hash: str) -> dict:
    created_at = dt.datetime.now(dt.timezone.utc).isoformat()
    git_commit = _git_commit()
    return {
        "Ts": float(ts),
        "created_at": np.array([[created_at]], dtype=object),
        "data_hash": np.array([[data_hash]], dtype=object),
        "git_commit": np.array([[git_commit]], dtype=object),
        "time_unit": np.array([["seconds_utc"]], dtype=object),
    }


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export reference and LSTM prediction signals to a Simulink-compatible MAT file.",
    )
    parser.add_argument("--scores_csv", type=Path, required=True, help="LSTM予測系列のCSVパス。")
    parser.add_argument("--reference_csv", type=Path, required=True, help="参照系列CSVパス。")
    parser.add_argument("--out_mat", type=Path, required=True, help="出力MATファイルパス。")
    parser.add_argument("--Ts", type=float, required=True, help="共通サンプル周期 [秒]。")
    parser.add_argument("--label_r", default="r", help="参照信号のラベル。")
    parser.add_argument("--label_y", default="yLSTM", help="LSTM信号のラベル。")
    parser.add_argument(
        "--scores-time-column",
        default=DEFAULT_TIME_COLUMN,
        help="予測CSV内の時間列名。",
    )
    parser.add_argument(
        "--scores-value-column",
        default=DEFAULT_SCORES_VALUE_COLUMN,
        help="予測CSV内の値列名。",
    )
    parser.add_argument(
        "--reference-time-column",
        default=DEFAULT_TIME_COLUMN,
        help="参照CSV内の時間列名。",
    )
    parser.add_argument(
        "--reference-value-column",
        default=DEFAULT_REFERENCE_VALUE_COLUMN,
        help="参照CSV内の値列名。",
    )
    return parser.parse_args(list(argv))


def main(argv: Iterable[str]) -> int:
    args = parse_args(argv)
    if args.Ts <= 0:
        raise SignalExportError("Ts は正の値で指定してください。")

    r_time, r_values = load_series(
        args.reference_csv,
        time_column=args.reference_time_column,
        value_column=args.reference_value_column,
    )
    y_time, y_values = load_series(
        args.scores_csv,
        time_column=args.scores_time_column,
        value_column=args.scores_value_column,
    )

    meta_hash = _sha256_of_files([args.reference_csv, args.scores_csv])
    r_struct = to_from_workspace_struct(r_time, r_values, args.label_r)
    y_struct = to_from_workspace_struct(y_time, y_values, args.label_y)
    meta = _build_meta(args.Ts, meta_hash)

    save_mat(args.out_mat, r_struct, y_struct, meta)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SignalExportError as exc:
        print(json.dumps({"level": "ERROR", "message": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
