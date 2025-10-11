# -*- coding: utf-8 -*-
"""Feature encoders for events and temporal signals."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Sequence

import numpy as np
import pandas as pd

PAD_TOKEN = "<pad>"
UNK_TOKEN = "<unk>"


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

    def save(self, path: str) -> None:
        import json

        data = {
            "event_vocab": self.event_vocab.idx_to_token,
            "delta_normalizer": {"mean": self.delta_normalizer.mean, "std": self.delta_normalizer.std},
            "latency_normalizer": {"mean": self.latency_normalizer.mean, "std": self.latency_normalizer.std},
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
        return cls(event_vocab=vocab, delta_normalizer=delta, latency_normalizer=latency)


def build_feature_pack(df: pd.DataFrame) -> FeaturePack:
    vocab = EventVocabulary.build(df["event"].tolist())
    delta = ContinuousNormalizer.fit(df["delta_t"].fillna(0.0).astype(float).tolist())
    latency = ContinuousNormalizer.fit(df["latency_ms"].fillna(0.0).astype(float).tolist())
    return FeaturePack(event_vocab=vocab, delta_normalizer=delta, latency_normalizer=latency)


def encode_dataframe(df: pd.DataFrame, pack: FeaturePack) -> Dict[str, np.ndarray]:
    event_ids = np.array([pack.event_vocab.to_index(token) for token in df["event"]], dtype=np.int64)
    delta = pack.delta_normalizer.transform(df["delta_t"].fillna(0.0).astype(float).tolist())
    latency = pack.latency_normalizer.transform(df["latency_ms"].fillna(0.0).astype(float).tolist())
    status = df.get("status", pd.Series([0] * len(df))).fillna(0).to_numpy(dtype=np.float32)
    return {
        "event_id": event_ids,
        "delta_t": delta.astype(np.float32),
        "latency": latency.astype(np.float32),
        "status": status,
    }
