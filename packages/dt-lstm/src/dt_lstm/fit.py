"""Utilities for fitting dt-lstm vocabularies and metadata from CSV logs."""

from __future__ import annotations

import csv
import glob
import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, MutableMapping, Sequence

_LOGGER = logging.getLogger("dt_lstm.fit")

PAD_TOKEN = "<pad>"
UNK_TOKEN = "<unk>"
TOPK_CANDIDATES = [3, 5]


class FitError(RuntimeError):
    """Raised when fitting artifacts cannot proceed."""


@dataclass
class RunningStats:
    """Numerically stable running statistics for a single feature."""

    count: int = 0
    mean: float = 0.0
    m2: float = 0.0
    minimum: float | None = None
    maximum: float | None = None

    def update(self, value: float) -> None:
        if not math.isfinite(value):
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

    @property
    def variance(self) -> float:
        if self.count <= 1:
            return 0.0
        return self.m2 / self.count

    @property
    def std(self) -> float:
        return math.sqrt(self.variance)

    def as_dict(self) -> Dict[str, float]:
        return {
            "count": float(self.count),
            "mean": float(self.mean if self.count else 0.0),
            "std": float(self.std if self.count else 0.0),
            "min": float(self.minimum if self.minimum is not None else 0.0),
            "max": float(self.maximum if self.maximum is not None else 0.0),
        }


def _resolve_inputs(patterns: Sequence[str]) -> List[Path]:
    files: List[Path] = []
    for pattern in patterns:
        expanded = sorted(glob.glob(str(pattern)))
        if not expanded:
            candidate = Path(pattern)
            if candidate.exists() and candidate.is_file():
                expanded = [str(candidate)]
        for match in expanded:
            path = Path(match).expanduser().resolve()
            if path.is_file():
                files.append(path)
    deduplicated = []
    seen = set()
    for path in files:
        if path in seen:
            continue
        seen.add(path)
        deduplicated.append(path)
    deduplicated.sort()
    if not deduplicated:
        raise FitError("No input files matched the given patterns")
    return deduplicated


def _consume_file(path: Path, counts: MutableMapping[str, int], dt_stats: RunningStats) -> None:
    required_columns = {"op_category", "dt_sec"}
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise FitError(f"Input file {path} is missing a header row")
        missing = required_columns.difference(set(reader.fieldnames))
        if missing:
            raise FitError(f"Input file {path} is missing required columns: {sorted(missing)}")
        for row in reader:
            op = (row.get("op_category") or "").strip()
            if op:
                counts[op] = counts.get(op, 0) + 1
            dt_raw = row.get("dt_sec")
            if dt_raw is None:
                continue
            try:
                dt_value = float(dt_raw)
            except (TypeError, ValueError):
                continue
            dt_stats.update(dt_value)


def _build_vocab(counts: MutableMapping[str, int]) -> Dict[str, object]:
    if not counts:
        raise FitError("No op_category values found in input data")
    sorted_tokens = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    itos: List[str] = [PAD_TOKEN, UNK_TOKEN]
    itos.extend(token for token, _ in sorted_tokens)
    stoi = {token: index for index, token in enumerate(itos)}
    frequency: Dict[str, int] = {PAD_TOKEN: 0, UNK_TOKEN: 0}
    frequency.update({token: counts[token] for token, _ in sorted_tokens})
    vocab = {
        "itos": itos,
        "stoi": stoi,
        "pad_token": PAD_TOKEN,
        "oov_token": UNK_TOKEN,
        "frequency": frequency,
        "topk_candidates": TOPK_CANDIDATES,
    }
    return vocab


def _suggest_embedding_dim(vocab_size: int) -> int:
    bounded_size = max(2, vocab_size)
    exponent = math.ceil(math.log2(bounded_size))
    suggested = 2 ** exponent
    return int(min(256, max(32, suggested)))


def _suggest_hidden_size(embedding_dim: int) -> int:
    return int(min(512, max(64, embedding_dim * 2)))


def _suggest_dropout(num_events: int) -> float:
    if num_events >= 100_000:
        return 0.3
    if num_events >= 50_000:
        return 0.25
    if num_events >= 10_000:
        return 0.2
    return 0.1


def _build_rmtpp_defaults(dt_stats: RunningStats) -> Dict[str, Dict[str, float]]:
    eps = 1e-6
    mean_dt = dt_stats.mean if dt_stats.count else 1.0
    std_dt = dt_stats.std if dt_stats.count > 1 else mean_dt
    base_rate = 1.0 / max(mean_dt, eps)
    decay = -1.0 / max(std_dt if std_dt > eps else mean_dt, eps)
    bias = math.log(max(base_rate, eps))
    scale = max(std_dt, eps)
    return {
        "w_init": {"trainable": decay, "frozen": decay},
        "bias_init": {"trainable": bias, "frozen": bias},
        "scale": {"trainable": scale, "frozen": scale},
    }


def _build_meta(
    counts: MutableMapping[str, int],
    dt_stats: RunningStats,
    seed: int,
) -> Dict[str, object]:
    num_events = int(sum(counts.values()))
    vocab_size = int(len(counts) + 2)
    embedding_dim = _suggest_embedding_dim(vocab_size)
    hidden_size = _suggest_hidden_size(embedding_dim)
    dropout = _suggest_dropout(num_events)
    std_dt = dt_stats.std if dt_stats.count else 0.0
    loss = {
        "event": {
            "objective": "cross_entropy",
            "weight": 1.0,
            "label_smoothing": 0.0,
        },
        "time": {
            "objective": "rmtpp",
            "weight": 1.0,
            "uncertainty_weighting": {
                "enabled": False,
                "suggested_switch": bool(std_dt > 1.0),
            },
        },
    }
    calibration = {
        "temperature": {
            "enabled": False,
            "init": 1.0,
            "bounds": [0.5, 5.0],
        },
        "topk": TOPK_CANDIDATES,
    }
    meta = {
        "seed": int(seed),
        "data": {
            "num_events": num_events,
            "num_unique_ops": int(len(counts)),
            "dt_sec": dt_stats.as_dict(),
        },
        "model": {
            "embedding": {"dim": embedding_dim, "padding_idx": 0},
            "hidden": {"size": hidden_size, "num_layers": 1},
            "regularization": {"dropout": dropout},
            "loss": loss,
            "calibration": calibration,
            "rmtpp": _build_rmtpp_defaults(dt_stats),
        },
    }
    return meta


def fit_artifacts(
    patterns: Sequence[str],
    vocab_out: Path,
    cfg_out: Path,
    seed: int,
) -> Dict[str, object]:
    """Fit vocabulary and metadata from CSV inputs."""

    input_files = _resolve_inputs(patterns)
    _LOGGER.info("fit.start", extra={"num_inputs": len(input_files)})
    counts: Dict[str, int] = {}
    dt_stats = RunningStats()
    for file_path in input_files:
        _LOGGER.info("fit.consume", extra={"path": str(file_path)})
        _consume_file(file_path, counts, dt_stats)

    vocab = _build_vocab(counts)
    meta = _build_meta(counts, dt_stats, seed)

    vocab_out.parent.mkdir(parents=True, exist_ok=True)
    cfg_out.parent.mkdir(parents=True, exist_ok=True)
    with vocab_out.open("w", encoding="utf-8") as handle:
        json.dump(vocab, handle, ensure_ascii=False, indent=2)
    with cfg_out.open("w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)

    payload = {
        "num_events": meta["data"]["num_events"],
        "vocab_size": len(vocab["itos"]),
        "dt_mean": meta["data"]["dt_sec"]["mean"],
    }
    _LOGGER.info("fit.complete", extra=payload)
    return payload


def main(patterns: Sequence[str], vocab_out: Path, cfg_out: Path, seed: int) -> Dict[str, object]:
    """Entry point used by the CLI."""

    return fit_artifacts(patterns, vocab_out, cfg_out, seed)

