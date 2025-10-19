# -*- coding: utf-8 -*-
"""Feature encoders for events and temporal signals."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .robust import choose_epsilon

PAD_TOKEN = "<pad>"
UNK_TOKEN = "<unk>"

DT_FEATURE_CANDIDATES: Dict[str, Tuple[str, ...]] = {
    "z": ("delta_robust_z",),
    "z_deseas": ("delta_z_deseas_clipped",),
    "lburst": ("delta_log_burst",),
    "m25": (
        "delta_q25",
        "delta_quantile_25",
        "delta_quantile_0_25",
        "delta_percentile_25",
        "delta_m25",
    ),
    "m50": (
        "delta_q50",
        "delta_quantile_50",
        "delta_quantile_0_50",
        "delta_percentile_50",
        "delta_m50",
    ),
    "m75": (
        "delta_q75",
        "delta_quantile_75",
        "delta_quantile_0_75",
        "delta_percentile_75",
        "delta_m75",
    ),
}


def _event_tokens(df: pd.DataFrame) -> pd.Series:
    if "template_id" in df.columns:
        series = df["template_id"]
    elif "event" in df.columns:
        series = df["event"]
    else:
        raise ValueError("Input dataframe must include 'template_id' or 'event' column")
    return series.fillna("").astype(str).str.strip()


@dataclass
class EventVocabulary:
    """Vocabulary helper mapping events to integer ids."""

    token_to_idx: Dict[str, int] = field(default_factory=dict)
    idx_to_token: List[str] = field(default_factory=list)

    @classmethod
    def build(cls, events: Iterable[str], min_freq: int = 1) -> "EventVocabulary":
        counts: Dict[str, int] = {}
        for event in events:
            counts[event] = counts.get(event, 0) + 1
        vocab = cls()
        vocab.add_token(PAD_TOKEN)
        vocab.add_token(UNK_TOKEN)
        for event, freq in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
            if freq < min_freq:
                continue
            vocab.add_token(event)
        return vocab

    def add_token(self, token: str) -> None:
        if token in self.token_to_idx:
            return
        index = len(self.idx_to_token)
        self.token_to_idx[token] = index
        self.idx_to_token.append(token)

    def to_index(self, token: str) -> int:
        return self.token_to_idx.get(token, self.token_to_idx[UNK_TOKEN])

    def __len__(self) -> int:  # pragma: no cover - trivial
        return len(self.idx_to_token)


@dataclass
class ContinuousNormalizer:
    """Simple z-score normalizer with fallback for inference."""

    mean: float
    std: float

    @classmethod
    def fit(cls, values: Sequence[float], eps: float = 1e-8) -> "ContinuousNormalizer":
        arr = np.asarray(list(values), dtype=np.float32)
        mean = float(np.mean(arr))
        std = float(np.std(arr) + eps)
        return cls(mean=mean, std=std)

    def transform(self, values: Sequence[float]) -> np.ndarray:
        arr = np.asarray(list(values), dtype=np.float32)
        return (arr - self.mean) / self.std

    def transform_single(self, value: float) -> float:
        return float((value - self.mean) / self.std)


@dataclass
class FeaturePack:
    """Bundle holding encoders used across the project."""

    event_vocab: EventVocabulary
    delta_normalizer: ContinuousNormalizer
    latency_normalizer: ContinuousNormalizer
    delta_epsilon: float
    numeric_features: List[str]
    feature_sources: Dict[str, str]
    additional_normalizers: Dict[str, ContinuousNormalizer] = field(default_factory=dict)
    response_normalizer: Optional[ContinuousNormalizer] = None

    def save(self, path: str) -> None:
        import json

        data = {
            "event_vocab": self.event_vocab.idx_to_token,
            "delta_normalizer": {"mean": self.delta_normalizer.mean, "std": self.delta_normalizer.std},
            "latency_normalizer": {"mean": self.latency_normalizer.mean, "std": self.latency_normalizer.std},
            "delta_epsilon": self.delta_epsilon,
            "numeric_features": self.numeric_features,
            "feature_sources": self.feature_sources,
            "additional_normalizers": {
                name: {"mean": normalizer.mean, "std": normalizer.std}
                for name, normalizer in self.additional_normalizers.items()
            },
        }
        if self.response_normalizer is not None:
            data["response_normalizer"] = {
                "mean": self.response_normalizer.mean,
                "std": self.response_normalizer.std,
            }
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str) -> "FeaturePack":
        import json

        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        vocab = EventVocabulary()
        for token in data["event_vocab"]:
            vocab.add_token(token)
        delta = ContinuousNormalizer(mean=data["delta_normalizer"]["mean"], std=data["delta_normalizer"]["std"])
        latency = ContinuousNormalizer(mean=data["latency_normalizer"]["mean"], std=data["latency_normalizer"]["std"])
        epsilon = float(data.get("delta_epsilon", 1e-6))
        numeric_features = list(data.get("numeric_features", ["delta_t", "latency", "status"]))
        feature_sources = dict(
            data.get(
                "feature_sources",
                {"delta_t": "delta_t", "latency": "latency_ms", "status": "status"},
            )
        )
        additional_normalizers_data = data.get("additional_normalizers", {})
        additional_normalizers = {
            name: ContinuousNormalizer(mean=value["mean"], std=value["std"])
            for name, value in additional_normalizers_data.items()
        }
        response_norm = data.get("response_normalizer")
        response = (
            ContinuousNormalizer(mean=response_norm["mean"], std=response_norm["std"])
            if response_norm is not None
            else None
        )
        return cls(
            event_vocab=vocab,
            delta_normalizer=delta,
            latency_normalizer=latency,
            delta_epsilon=epsilon,
            numeric_features=numeric_features,
            feature_sources=feature_sources,
            additional_normalizers=additional_normalizers,
            response_normalizer=response,
        )


def _discover_dt_features(df: pd.DataFrame) -> List[Tuple[str, str, ContinuousNormalizer]]:
    discovered: List[Tuple[str, str, ContinuousNormalizer]] = []
    for friendly, candidates in DT_FEATURE_CANDIDATES.items():
        column = next((candidate for candidate in candidates if candidate in df.columns), None)
        if column is None:
            continue
        series = df[column]
        if series is None:
            continue
        numeric = series.astype(float)
        finite = numeric.replace([np.inf, -np.inf], np.nan).dropna()
        if finite.empty:
            continue
        normalizer = ContinuousNormalizer.fit(finite.tolist())
        discovered.append((friendly, column, normalizer))
    return discovered


def build_feature_pack(df: pd.DataFrame, extra_features: Optional[Sequence[str]] = None) -> FeaturePack:
    events = _event_tokens(df)
    vocab = EventVocabulary.build(events.tolist())
    delta_values = df["delta_t"].fillna(0.0).astype(float).to_numpy()
    delta = ContinuousNormalizer.fit(delta_values.tolist())
    latency = ContinuousNormalizer.fit(df["latency_ms"].fillna(0.0).astype(float).tolist())
    epsilon = choose_epsilon(delta_values[delta_values > 0.0])

    numeric_features: List[str] = ["delta_t", "latency", "status"]
    feature_sources: Dict[str, str] = {
        "delta_t": "delta_t",
        "latency": "latency_ms",
        "status": "status",
    }
    additional_normalizers: Dict[str, ContinuousNormalizer] = {}
    response_normalizer: Optional[ContinuousNormalizer] = None
    if "response_bytes" in df.columns:
        response_values = df["response_bytes"].fillna(0.0).astype(float).to_numpy()
        if np.isfinite(response_values).any():
            response_normalizer = ContinuousNormalizer.fit(response_values.tolist())
            if "response_bytes" not in numeric_features:
                numeric_features.append("response_bytes")
            feature_sources["response_bytes"] = "response_bytes"

    requested = {feature.lower() for feature in (extra_features or [])}
    if "dt" in requested:
        for friendly, column, normalizer in _discover_dt_features(df):
            if friendly not in numeric_features:
                numeric_features.append(friendly)
            feature_sources[friendly] = column
            additional_normalizers[friendly] = normalizer

    return FeaturePack(
        event_vocab=vocab,
        delta_normalizer=delta,
        latency_normalizer=latency,
        delta_epsilon=epsilon,
        numeric_features=numeric_features,
        feature_sources=feature_sources,
        additional_normalizers=additional_normalizers,
        response_normalizer=response_normalizer,
    )


def encode_dataframe(df: pd.DataFrame, pack: FeaturePack) -> Dict[str, np.ndarray]:
    events = _event_tokens(df)
    event_ids = np.array([pack.event_vocab.to_index(token) for token in events], dtype=np.int64)
    delta_column = pack.feature_sources.get("delta_t", "delta_t")
    delta_series = df.get(delta_column, pd.Series([0.0] * len(df)))
    delta = pack.delta_normalizer.transform(delta_series.fillna(0.0).astype(float).tolist())
    latency_column = pack.feature_sources.get("latency", "latency_ms")
    latency_series = df.get(latency_column, pd.Series([0.0] * len(df)))
    latency = pack.latency_normalizer.transform(latency_series.fillna(0.0).astype(float).tolist())
    status_column = pack.feature_sources.get("status", "status")
    status_series = df.get(status_column, pd.Series([0] * len(df)))
    status = status_series.fillna(0).to_numpy(dtype=np.float32)
    encoded: Dict[str, np.ndarray] = {
        "event_id": event_ids,
        "delta_t": delta.astype(np.float32),
        "latency": latency.astype(np.float32),
        "status": status,
    }
    if "response_bytes" in pack.numeric_features:
        column = pack.feature_sources.get("response_bytes", "response_bytes")
        values = df.get(column)
        if values is None:
            response = np.zeros(len(df), dtype=np.float32)
        else:
            filled = values.fillna(0.0).astype(float).tolist()
            if pack.response_normalizer is not None:
                response = pack.response_normalizer.transform(filled).astype(np.float32)
            else:
                response = np.asarray(filled, dtype=np.float32)
        encoded["response_bytes"] = response
    for feature_name, normalizer in pack.additional_normalizers.items():
        column = pack.feature_sources.get(feature_name, feature_name)
        values = df.get(column)
        if values is None:
            filled = [0.0] * len(df)
        else:
            filled = values.fillna(0.0).astype(float).tolist()
        encoded[feature_name] = normalizer.transform(filled).astype(np.float32)
    return encoded
