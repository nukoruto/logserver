"""Data loading utilities for dt-lstm training."""

from __future__ import annotations

import glob
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import torch
from torch.utils.data import Dataset


@dataclass
class RunningStats:
    """Running statistics accumulator for float features."""

    count: int = 0
    mean: float = 0.0
    m2: float = 0.0
    minimum: float | None = None
    maximum: float | None = None

    def update(self, value: float) -> None:
        if not np.isfinite(value):
            return
        self.count += 1
        if self.count == 1:
            self.mean = value
            self.m2 = 0.0
            self.minimum = value
            self.maximum = value
            return
        delta = value - self.mean
        self.mean += delta / self.count
        delta2 = value - self.mean
        self.m2 += delta * delta2
        self.minimum = value if self.minimum is None else min(self.minimum, value)
        self.maximum = value if self.maximum is None else max(self.maximum, value)

    def merge(self, other: "RunningStats") -> None:
        if other.count == 0:
            return
        if self.count == 0:
            self.count = other.count
            self.mean = other.mean
            self.m2 = other.m2
            self.minimum = other.minimum
            self.maximum = other.maximum
            return
        total = self.count + other.count
        delta = other.mean - self.mean
        self.mean = (self.mean * self.count + other.mean * other.count) / total
        self.m2 += other.m2 + delta * delta * self.count * other.count / total
        self.count = total
        if other.minimum is not None:
            if self.minimum is None:
                self.minimum = other.minimum
            else:
                self.minimum = min(self.minimum, other.minimum)
        if other.maximum is not None:
            if self.maximum is None:
                self.maximum = other.maximum
            else:
                self.maximum = max(self.maximum, other.maximum)

    def as_dict(self) -> Dict[str, float]:
        variance = self.m2 / self.count if self.count > 0 else 0.0
        return {
            "count": float(self.count),
            "mean": float(self.mean if self.count else 0.0),
            "std": float(np.sqrt(max(0.0, variance))),
            "min": float(self.minimum if self.minimum is not None else 0.0),
            "max": float(self.maximum if self.maximum is not None else 0.0),
        }


@dataclass
class Vocabulary:
    """Simple vocabulary wrapper loaded from dt-lstm fit artifacts."""

    stoi: Mapping[str, int]
    itos: Sequence[str]
    pad_token: str
    unk_token: str

    @property
    def pad_index(self) -> int:
        return int(self.stoi.get(self.pad_token, 0))

    @property
    def unk_index(self) -> int:
        return int(self.stoi.get(self.unk_token, self.pad_index))

    @property
    def size(self) -> int:
        return int(len(self.itos))


def load_vocabulary(path: Optional[Path]) -> Optional[Vocabulary]:
    if path is None:
        return None
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    stoi = {str(key): int(value) for key, value in data.get("stoi", {}).items()}
    itos = [str(token) for token in data.get("itos", [])]
    pad_token = str(data.get("pad_token", "<pad>"))
    unk_token = str(data.get("oov_token", data.get("unk_token", "<unk>")))
    if not stoi or not itos:
        raise ValueError("Vocabulary JSON must contain stoi and itos entries")
    return Vocabulary(stoi=stoi, itos=itos, pad_token=pad_token, unk_token=unk_token)


def resolve_input_files(patterns: Sequence[str]) -> List[Path]:
    files: List[Path] = []
    for pattern in patterns:
        expanded = sorted(glob.glob(str(pattern)))
        if not expanded:
            candidate = Path(pattern)
            if candidate.is_file():
                expanded = [str(candidate)]
        for match in expanded:
            path = Path(match).expanduser().resolve()
            if path.is_file():
                files.append(path)
    deduped: List[Path] = []
    seen = set()
    for path in files:
        if path in seen:
            continue
        seen.add(path)
        deduped.append(path)
    deduped.sort()
    if not deduped:
        raise FileNotFoundError("No input files matched the given patterns")
    return deduped


def _normalise_timestamp(frame: pd.DataFrame) -> pd.DataFrame:
    timestamp_cols = ["timestamp_utc", "timestamp"]
    present = next((col for col in timestamp_cols if col in frame.columns), None)
    if present is None:
        raise ValueError("Input CSV must contain timestamp_utc or timestamp column")
    timestamps = pd.to_datetime(frame[present], utc=True, errors="coerce")
    if timestamps.isna().any():
        raise ValueError("Invalid timestamps detected in input data")
    frame = frame.copy()
    frame["timestamp_utc"] = timestamps
    return frame


def _ensure_numeric(frame: pd.DataFrame, columns: Sequence[str]) -> pd.DataFrame:
    frame = frame.copy()
    for column in columns:
        if column not in frame.columns:
            frame[column] = 0.0
        frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0.0).astype(np.float32)
    return frame


def _resolve_session_column(frame: pd.DataFrame) -> Optional[str]:
    for candidate in ("session_id", "sid_final", "generated_session_id", "sid"):
        if candidate in frame.columns:
            return candidate
    return None


def _derive_session_ids(frame: pd.DataFrame, idle_timeout: float) -> pd.Series:
    if "uid" not in frame.columns:
        raise ValueError("uid column required to derive session identifiers")
    ordered = frame.sort_values(["uid", "timestamp_utc"], kind="mergesort").reset_index(drop=True)
    session_labels: List[str] = []
    counters: MutableMapping[str, int] = {}
    for _, row in ordered.iterrows():
        uid = str(row["uid"])
        dt_value = float(row.get("dt_sec", float("nan")))
        if uid not in counters:
            counters[uid] = 0
        else:
            if not np.isfinite(dt_value) or dt_value < 0 or dt_value > idle_timeout:
                counters[uid] += 1
        session_labels.append(f"{uid}-{counters[uid]}")
    ordered["_derived_session_id"] = session_labels
    merged = ordered[["_derived_session_id"]].copy()
    merged.index = ordered.index
    merged = merged.sort_index()
    return merged["_derived_session_id"]


def _resolve_event_ids(frame: pd.DataFrame, vocab: Optional[Vocabulary]) -> Tuple[np.ndarray, int]:
    if vocab is not None:
        if "op_category" not in frame.columns:
            raise ValueError("op_category column required when vocabulary is provided")
        mapped = frame["op_category"].map(lambda token: vocab.stoi.get(str(token), vocab.unk_index))
        ids = mapped.fillna(vocab.pad_index).astype(np.int64).to_numpy()
        return ids, vocab.size
    if "cat_id" in frame.columns:
        ids = pd.to_numeric(frame["cat_id"], errors="coerce").fillna(0).astype(np.int64).to_numpy()
        vocab_size = int(ids.max(initial=0) + 1)
        return ids, vocab_size
    raise ValueError("Input data must contain either cat_id or op_category column")


def _collect_sequences(
    frame: pd.DataFrame,
    numeric_columns: Sequence[str],
    delta_column: str,
    vocab: Optional[Vocabulary],
    idle_timeout: float,
    *,
    include_context: bool = False,
    source_path: Optional[Path] = None,
) -> Tuple[List[Dict[str, np.ndarray]], int, Dict[int, int], RunningStats]:
    frame = _normalise_timestamp(frame)
    if delta_column not in frame.columns:
        raise ValueError(f"Δt column '{delta_column}' not found in input data")
    frame = _ensure_numeric(frame, list(set(numeric_columns) | {delta_column}))
    session_col = _resolve_session_column(frame)
    if session_col is None:
        frame["_derived_session_id"] = _derive_session_ids(frame, idle_timeout)
        session_col = "_derived_session_id"
    ordered = frame.sort_values([session_col, "timestamp_utc"], kind="mergesort").reset_index(drop=True)
    event_ids, vocab_size = _resolve_event_ids(ordered, vocab)
    ordered["_event_id"] = event_ids
    grouped = list(ordered.groupby(session_col, sort=False, as_index=False))
    sequences: List[Dict[str, np.ndarray]] = []
    class_counts: Dict[int, int] = {}
    dt_stats = RunningStats()

    numeric_columns = list(numeric_columns)
    if delta_column not in numeric_columns:
        numeric_columns = [delta_column, *numeric_columns]

    for _, group in grouped:
        group = group.reset_index(drop=True)
        if len(group) < 2:
            continue
        ids = group["_event_id"].to_numpy(dtype=np.int64)
        numeric = group[numeric_columns].to_numpy(dtype=np.float32)
        delta = group[delta_column].to_numpy(dtype=np.float32)
        censor = None
        if "time_censored" in group.columns:
            censor = group["time_censored"].astype(bool).to_numpy()
        else:
            censor = np.zeros(len(group), dtype=bool)
        if np.isnan(delta).any():
            censor = np.isnan(delta) | censor
            delta = np.nan_to_num(delta, nan=0.0)

        inputs = ids[:-1]
        targets = ids[1:]
        numeric_trimmed = numeric[1:]
        delta_trimmed = delta[1:]
        censor_trimmed = censor[1:]
        if inputs.size == 0:
            continue
        sequence_payload: Dict[str, object] = {
            "events": inputs.astype(np.int64, copy=True),
            "targets": targets.astype(np.int64, copy=True),
            "numeric": numeric_trimmed.astype(np.float32, copy=True),
            "delta": delta_trimmed.astype(np.float32, copy=True),
            "censor": censor_trimmed.astype(np.bool_, copy=True),
        }
        if include_context:
            timestamps = group["timestamp_utc"].iloc[1:]
            if hasattr(timestamps, "dt"):
                timestamp_values = [ts.isoformat() for ts in timestamps.dt.tz_convert("UTC")]
            else:
                timestamp_values = [str(value) for value in timestamps]
            target_tokens: Optional[Sequence[str]] = None
            if "op_category" in group.columns:
                target_tokens = group["op_category"].astype(str).iloc[1:].tolist()
            elif "event" in group.columns:
                target_tokens = group["event"].astype(str).iloc[1:].tolist()
            context: Dict[str, object] = {
                "file": str(source_path) if source_path is not None else None,
                "session_id": str(group[session_col].iloc[0]) if session_col in group.columns else None,
                "uid": str(group["uid"].iloc[0]) if "uid" in group.columns else None,
                "timestamps": list(timestamp_values),
                "row_index": [int(index) for index in group.index.tolist()[1:]],
            }
            if target_tokens is not None:
                context["target_tokens"] = list(target_tokens)
            sequence_payload["_context"] = context
        sequences.append(sequence_payload)
        for token in targets.tolist():
            class_counts[token] = class_counts.get(token, 0) + 1
        for value in delta_trimmed.tolist():
            dt_stats.update(float(value))

    if not sequences:
        raise ValueError("No usable sequences found in the provided data")
    return sequences, vocab_size, class_counts, dt_stats


class SessionSequenceDataset(Dataset):
    """PyTorch dataset wrapping session-level sequences."""

    def __init__(self, sequences: Sequence[Mapping[str, np.ndarray]]) -> None:
        self._sequences = list(sequences)

    def __len__(self) -> int:
        return len(self._sequences)

    def __getitem__(self, index: int) -> Mapping[str, np.ndarray]:
        return self._sequences[index]


def collate_batch(batch: Sequence[Mapping[str, np.ndarray]]) -> Dict[str, torch.Tensor]:
    lengths = [int(item["events"].shape[0]) for item in batch]
    max_len = max(lengths)
    numeric_dim = int(batch[0]["numeric"].shape[1]) if batch[0]["numeric"].ndim == 2 else 0

    events = torch.zeros((len(batch), max_len), dtype=torch.long)
    targets = torch.zeros((len(batch), max_len), dtype=torch.long)
    numeric = torch.zeros((len(batch), max_len, numeric_dim), dtype=torch.float32)
    delta = torch.zeros((len(batch), max_len), dtype=torch.float32)
    censor = torch.zeros((len(batch), max_len), dtype=torch.bool)
    mask = torch.zeros((len(batch), max_len), dtype=torch.bool)

    for row, item in enumerate(batch):
        length = int(item["events"].shape[0])
        events[row, :length] = torch.from_numpy(item["events"])
        targets[row, :length] = torch.from_numpy(item["targets"])
        numeric[row, :length] = torch.from_numpy(item["numeric"]) if numeric_dim else 0.0
        delta[row, :length] = torch.from_numpy(item["delta"])
        censor[row, :length] = torch.from_numpy(item["censor"])
        mask[row, :length] = True

    return {
        "events": events,
        "numeric": numeric,
        "targets": targets,
        "mask": mask,
        "delta": delta,
        "censor": censor,
    }


def load_sequence_dataset(
    patterns: Sequence[str],
    *,
    numeric_columns: Sequence[str],
    delta_column: str,
    vocab: Optional[Vocabulary],
    idle_timeout: float,
    include_context: bool = False,
) -> Tuple[SessionSequenceDataset, Dict[str, object]]:
    files = resolve_input_files(patterns)
    sequences: List[Mapping[str, np.ndarray]] = []
    vocab_size = 0
    aggregate_counts: Dict[int, int] = {}
    dt_stats = RunningStats()

    for path in files:
        frame = pd.read_csv(path)
        seqs, local_vocab_size, counts, stats = _collect_sequences(
            frame,
            numeric_columns=numeric_columns,
            delta_column=delta_column,
            vocab=vocab,
            idle_timeout=idle_timeout,
            include_context=include_context,
            source_path=path,
        )
        sequences.extend(seqs)
        vocab_size = max(vocab_size, local_vocab_size)
        for token, count in counts.items():
            aggregate_counts[token] = aggregate_counts.get(token, 0) + int(count)
        dt_stats.merge(stats)

    dataset = SessionSequenceDataset(sequences)
    metadata: Dict[str, object] = {
        "files": [str(path) for path in files],
        "vocab_size": vocab.size if vocab is not None else vocab_size,
        "class_counts": {str(token): int(count) for token, count in aggregate_counts.items()},
        "dt_stats": dt_stats.as_dict(),
        "numeric_dim": int(sequences[0]["numeric"].shape[1]) if sequences else 0,
        "delta_column": delta_column,
        "numeric_columns": list(numeric_columns),
    }
    return dataset, metadata
