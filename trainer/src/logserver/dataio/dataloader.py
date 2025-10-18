# -*- coding: utf-8 -*-
"""Convert RFC4180 CSV logs into packed session tensors with causal masks."""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, MutableMapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import torch
from torch import Tensor
from torch.nn.utils.rnn import PackedSequence, pack_padded_sequence

PAD_CATEGORY_ID = 0
NUMERIC_FEATURE_COLUMNS = [
    "z_clipped",
    "lburst",
    "m25",
    "m50",
    "m75",
    "z_deseas",
    "dt_sec",
    "t_i",
]


@dataclass
class PackedSessionBatch:
    """Container for padded and packed session tensors."""

    session_ids: List[str]
    lengths: Tensor
    categorical_padded: Tensor
    numeric_padded: Tensor
    categorical_packed: PackedSequence
    numeric_packed: PackedSequence
    causal_mask: Tensor
    session_end: Tensor

    def to(self, device: torch.device | str) -> "PackedSessionBatch":
        """Return a copy of the batch with tensors moved to ``device``."""

        torch_device = torch.device(device)
        return PackedSessionBatch(
            session_ids=list(self.session_ids),
            lengths=self.lengths.to(torch_device),
            categorical_padded=self.categorical_padded.to(torch_device),
            numeric_padded=self.numeric_padded.to(torch_device),
            categorical_packed=_move_packed(self.categorical_packed, torch_device),
            numeric_packed=_move_packed(self.numeric_packed, torch_device),
            causal_mask=self.causal_mask.to(torch_device),
            session_end=self.session_end.to(torch_device),
        )


def load_packed_sessions(
    source: Path,
    *,
    group_key: Optional[str] = None,
    timezone: str = "UTC",
) -> PackedSessionBatch:
    """Load an RFC4180 CSV dataset and emit packed session tensors."""

    frame = _read_csv(source)
    frame = _normalise_timestamps(frame, timezone)
    frame = _ensure_feature_columns(frame)
    key, derived = _resolve_group_key(frame, preferred=group_key)
    if derived:
        frame[key] = _derive_sessions(frame)
    ordered = frame.sort_values([key, "timestamp_utc"], kind="mergesort").reset_index(drop=True)
    ordered["_cat_id"] = _resolve_categorical_ids(ordered)
    grouped = list(ordered.groupby(key, sort=False, as_index=False))
    session_ids = [str(name) for name, _ in grouped]
    lengths = torch.tensor([len(group) for _, group in grouped], dtype=torch.long)
    categorical_padded, numeric_padded, session_end = _build_padded_tensors(grouped, lengths)
    cat_packed = pack_padded_sequence(
        categorical_padded,
        lengths.cpu(),
        batch_first=True,
        enforce_sorted=False,
    )
    num_packed = pack_padded_sequence(
        numeric_padded,
        lengths.cpu(),
        batch_first=True,
        enforce_sorted=False,
    )
    causal_mask = _build_causal_mask(lengths)
    return PackedSessionBatch(
        session_ids=session_ids,
        lengths=lengths,
        categorical_padded=categorical_padded,
        numeric_padded=numeric_padded,
        categorical_packed=cat_packed,
        numeric_packed=num_packed,
        causal_mask=causal_mask,
        session_end=session_end,
    )


def save_packed_sessions(batch: PackedSessionBatch, destination: Path) -> None:
    """Persist packed session tensors as a Torch archive."""

    payload = {
        "session_ids": batch.session_ids,
        "lengths": batch.lengths,
        "categorical_padded": batch.categorical_padded,
        "numeric_padded": batch.numeric_padded,
        "categorical_packed": batch.categorical_packed,
        "numeric_packed": batch.numeric_packed,
        "causal_mask": batch.causal_mask,
        "session_end": batch.session_end,
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    torch.save(payload, destination)


def _read_csv(source: Path) -> pd.DataFrame:
    if source.is_dir():
        candidate = source / "events.csv"
        if not candidate.exists():
            raise ValueError("Directory must contain events.csv for RFC4180 input")
        path = candidate
    else:
        path = source
    if not path.exists():
        raise FileNotFoundError(f"Input file not found: {path}")
    return pd.read_csv(path, dtype=dict(cat_id="Int64"))


def _normalise_timestamps(frame: pd.DataFrame, timezone: str) -> pd.DataFrame:
    if "timestamp_utc" in frame.columns:
        timestamps = pd.to_datetime(frame["timestamp_utc"], utc=True, errors="coerce")
    elif "timestamp" in frame.columns:
        timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
    else:
        raise ValueError("Input CSV must contain timestamp_utc or timestamp column")
    if timestamps.isna().any():
        raise ValueError("Invalid timestamps detected in input data")
    frame = frame.copy()
    if timezone and timezone.upper() != "UTC":
        frame["timestamp_utc"] = timestamps.dt.tz_convert(timezone)
    else:
        frame["timestamp_utc"] = timestamps
    epoch_seconds = timestamps.dt.tz_convert("UTC").astype("int64") / 1_000_000_000.0
    frame["t_i"] = epoch_seconds.astype(np.float32)
    return frame


def _ensure_feature_columns(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.copy()
    dt_column = _resolve_delta_column(frame)
    frame["dt_sec"] = frame[dt_column].astype(float)
    for column in NUMERIC_FEATURE_COLUMNS:
        if column in frame.columns:
            frame[column] = frame[column].astype(float)
        else:
            frame[column] = 0.0
    return frame


def _resolve_delta_column(frame: pd.DataFrame) -> str:
    for candidate in ("dt_sec", "delta_t", "delta_seconds", "dt_seconds"):
        if candidate in frame.columns:
            return candidate
    raise ValueError("Δt column not found (expected dt_sec or equivalent)")


def _resolve_group_key(frame: pd.DataFrame, preferred: Optional[str]) -> Tuple[str, bool]:
    if preferred and preferred in frame.columns:
        return preferred, False
    for candidate in ("sid_final", "generated_session_id", "session_id"):
        if candidate in frame.columns:
            return candidate, False
    return "_derived_session_id", True


def _resolve_categorical_ids(frame: pd.DataFrame) -> pd.Series:
    if "cat_id" in frame.columns:
        series = pd.to_numeric(frame["cat_id"], errors="coerce").fillna(PAD_CATEGORY_ID)
        return series.astype(np.int64)
    if "op_category" not in frame.columns:
        raise ValueError("Neither cat_id nor op_category found for categorical encoding")
    tokens = sorted({str(value) for value in frame["op_category"].dropna()})
    mapping: MutableMapping[str, int] = {token: index + 1 for index, token in enumerate(tokens)}
    mapped = frame["op_category"].map(lambda value: mapping.get(str(value), PAD_CATEGORY_ID))
    return mapped.astype(np.int64)


def _derive_sessions(frame: pd.DataFrame) -> pd.Series:
    if "uid" not in frame.columns:
        raise ValueError("uid column required for derived session identifiers")
    dt_values = pd.to_numeric(frame["dt_sec"], errors="coerce")
    if dt_values.isna().all():
        raise ValueError("Δt values required for session derivation")
    thresholds = _estimate_thresholds(frame[["uid", "dt_sec"]])
    sorted_frame = frame.sort_values(["uid", "timestamp_utc"], kind="mergesort")
    derived: MutableMapping[int, str] = {}
    for uid, group in sorted_frame.groupby("uid", sort=False):
        uid_key = str(uid)
        tau = thresholds.get(uid_key)
        if tau is None or not math.isfinite(tau):
            tau = float("inf")
        session_index = 0
        values = group["dt_sec"].to_numpy(dtype=float)
        uid_str = str(uid)
        identifiers = []
        for idx, delta in zip(group.index, values):
            if identifiers:
                if math.isfinite(delta) and delta >= tau:
                    session_index += 1
            identifier = f"{uid_str}-{session_index}"
            derived[idx] = identifier
            identifiers.append(identifier)
    return pd.Series(derived).reindex(frame.index)


def _estimate_thresholds(frame: pd.DataFrame) -> MutableMapping[str, float]:
    thresholds: MutableMapping[str, float] = {}
    for uid, group in frame.groupby("uid", sort=False):
        tau = _estimate_single_threshold(pd.to_numeric(group["dt_sec"], errors="coerce"))
        thresholds[str(uid)] = tau
    return thresholds


def _estimate_single_threshold(series: pd.Series) -> float:
    valid = np.array([value for value in series.to_numpy(dtype=float) if value and value > 0], dtype=float)
    if valid.size == 0:
        return float("inf")
    log_values = np.log(valid)
    hist, log_min, log_max, width = _log_histogram(log_values)
    otsu_log = _otsu_threshold(hist, log_min, log_max, width)
    knee_log = _knee_point(log_values)
    tau_log = max(otsu_log, knee_log)
    return float(math.exp(tau_log))


def _log_histogram(values: np.ndarray) -> Tuple[np.ndarray, float, float, float]:
    if values.size == 0:
        return np.zeros(1, dtype=int), 0.0, 0.0, 1.0
    log_min = float(values.min())
    log_max = float(values.max())
    if not math.isfinite(log_min) or not math.isfinite(log_max) or log_min == log_max:
        return np.array([values.size], dtype=int), log_min, log_max, 1.0
    bin_count = min(128, max(16, int(math.sqrt(values.size))))
    hist, edges = np.histogram(values, bins=bin_count, range=(log_min, log_max))
    width = (edges[-1] - edges[0]) / bin_count if bin_count else 1.0
    return hist.astype(int), float(edges[0]), float(edges[-1]), float(width)


def _otsu_threshold(hist: np.ndarray, log_min: float, log_max: float, width: float) -> float:
    total = hist.sum()
    if total <= 0 or not math.isfinite(width) or width <= 0:
        return log_max if math.isfinite(log_max) else log_min
    centers = log_min + width * (np.arange(hist.size) + 0.5)
    weights = hist.astype(float)
    sum_all = float(np.dot(weights, centers))
    sum_sq_all = float(np.dot(weights, centers ** 2))
    total_mean = sum_all / total
    total_variance = max(sum_sq_all / total - total_mean**2, 0.0)
    cumulative_count = 0.0
    cumulative_sum = 0.0
    best_tau = log_min
    best_between = -1.0
    for index in range(hist.size - 1):
        count = float(hist[index])
        cumulative_count += count
        cumulative_sum += count * centers[index]
        if cumulative_count <= 0 or cumulative_count >= total:
            continue
        foreground = total - cumulative_count
        mu_back = cumulative_sum / cumulative_count
        mu_fore = (sum_all - cumulative_sum) / foreground
        between = (cumulative_count / total) * (foreground / total) * ((mu_back - mu_fore) ** 2)
        if between > best_between:
            best_between = between
            best_tau = log_min + width * (index + 1)
    if best_between <= 0:
        return log_min
    if total_variance > 0:
        ratio = best_between / total_variance
        if not math.isfinite(ratio) or ratio < 0:
            return best_tau
    return best_tau


def _knee_point(values: np.ndarray) -> float:
    if values.size == 0:
        return float("nan")
    sorted_values = np.sort(values)
    if sorted_values.size < 3:
        return float(sorted_values[-1])
    minimum = float(sorted_values[0])
    maximum = float(sorted_values[-1])
    if maximum - minimum <= 0:
        return maximum
    x_coords = np.linspace(0.0, 1.0, sorted_values.size)
    y_coords = (sorted_values - minimum) / (maximum - minimum)
    distances = np.abs(x_coords - y_coords) / math.sqrt(2.0)
    index = int(distances.argmax())
    return float(sorted_values[index])


def _build_padded_tensors(
    grouped: Sequence[Tuple[object, pd.DataFrame]],
    lengths: Tensor,
) -> Tuple[Tensor, Tensor, Tensor]:
    batch_size = len(grouped)
    max_len = int(lengths.max().item()) if batch_size else 0
    categorical = torch.full((batch_size, max_len), PAD_CATEGORY_ID, dtype=torch.long)
    numeric = torch.zeros(batch_size, max_len, len(NUMERIC_FEATURE_COLUMNS), dtype=torch.float32)
    session_end = torch.zeros(batch_size, max_len, dtype=torch.bool)
    for row, (_, group) in enumerate(grouped):
        length = len(group)
        if length == 0:
            continue
        categorical[row, :length] = torch.from_numpy(group["_cat_id"].to_numpy(dtype=np.int64, copy=True))
        numeric[row, :length, :] = torch.from_numpy(
            group[NUMERIC_FEATURE_COLUMNS].to_numpy(dtype=np.float32, copy=True)
        )
        session_end[row, length - 1] = True
    return categorical, numeric, session_end


def _build_causal_mask(lengths: Tensor) -> Tensor:
    batch_size = lengths.shape[0]
    max_len = int(lengths.max().item()) if batch_size else 0
    base = torch.triu(torch.ones(max_len, max_len, dtype=torch.bool), diagonal=1)
    mask = base.unsqueeze(0).expand(batch_size, -1, -1).clone()
    for index, length in enumerate(lengths.tolist()):
        if length < max_len:
            mask[index, length:, :] = True
            mask[index, :, length:] = True
    return mask


def _move_packed(sequence: PackedSequence, device: torch.device) -> PackedSequence:
    data = sequence.data.to(device)
    return PackedSequence(data, sequence.batch_sizes, sequence.sorted_indices, sequence.unsorted_indices)


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Convert RFC4180 CSV logs to packed tensors")
    parser.add_argument("--input", required=True, help="Path to events.csv or directory containing it")
    parser.add_argument("--output", required=True, help="Output .pt file for packed tensors")
    parser.add_argument("--group-key", default=None, help="Override group key column (default sid_final)")
    parser.add_argument("--timezone", default="UTC", help="Timezone for timestamp conversion")
    parser.add_argument("--device", default="cpu", help="Torch device for saved tensors")
    args = parser.parse_args(list(argv) if argv is not None else None)

    batch = load_packed_sessions(Path(args.input), group_key=args.group_key, timezone=args.timezone)
    batch = batch.to(args.device)
    destination = Path(args.output)
    save_packed_sessions(batch, destination)
    meta = {
        "event": "dataloader_output",
        "output": str(destination),
        "sessions": len(batch.session_ids),
        "max_length": int(batch.lengths.max().item()) if batch.lengths.numel() else 0,
        "device": str(args.device),
    }
    print(json.dumps(meta, ensure_ascii=False))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    raise SystemExit(main())
