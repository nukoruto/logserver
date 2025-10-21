# -*- coding: utf-8 -*-
"""Anomaly scoring utilities."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import torch
import torch.nn.functional as F

from ..features.batching import (
    build_sessions,
    create_array_session_loader,
    make_collate_fn,
)
from ..features.encoders import FeaturePack
from ..models.lstm_delta import DeltaAwareLSTM, LSTMConfig


@dataclass
class ScoringConfig:
    device: str = "cpu"
    smoothing_window: int = 5


class AnomalyScorer:
    def __init__(
        self,
        model: DeltaAwareLSTM,
        feature_pack: FeaturePack,
        config: ScoringConfig,
        *,
        target_mode: str = "next",
    ):
        self.model = model.to(config.device)
        self.model.eval()
        self.feature_pack = feature_pack
        self.config = config
        mode = str(target_mode).lower()
        if mode not in {"next", "same"}:
            raise ValueError("target_mode must be 'next' or 'same'")
        self.target_mode = mode
        self._bos_index = feature_pack.bos_index

    @classmethod
    def from_run(cls, run_dir: Path, config: ScoringConfig) -> "AnomalyScorer":
        feature_pack = FeaturePack.load(str(run_dir / "features.json"))
        metadata = _load_model_config(run_dir)
        model = DeltaAwareLSTM(
            LSTMConfig(
                vocab_size=len(feature_pack.event_vocab),
                embedding_dim=metadata.get("embedding_dim", 64),
                hidden_size=metadata.get("hidden_size", 64),
                num_layers=metadata.get("num_layers", 1),
                dropout=metadata.get("dropout", 0.1),
            )
        )
        state_dict = torch.load(run_dir / "model.pt", map_location=config.device)
        model.load_state_dict(state_dict)
        target_mode = metadata.get("target_mode", "same")
        return cls(model, feature_pack, config, target_mode=target_mode)

    def score(self, encoded: Dict[str, np.ndarray], session_ids: List[str]) -> Dict[str, np.ndarray]:
        slices, _, ordered_numeric = build_sessions(
            encoded, session_ids, self.feature_pack.numeric_features
        )
        try:
            delta_index = ordered_numeric.index("delta_t")
        except ValueError as error:
            raise RuntimeError("numeric features must include delta_t for Δt regression") from error
        collate_fn = make_collate_fn(
            target_mode=self.target_mode,
            bos_index=self._bos_index,
            delta_index=delta_index,
        )
        loader = create_array_session_loader(encoded, ordered_numeric)
        scores: Dict[str, np.ndarray] = {}
        for descriptor in slices:
            example = loader(descriptor)
            batch = collate_fn([example])
            scores[descriptor.key] = self._score_batch(batch)
        return scores

    def _score_batch(self, batch: Dict[str, torch.Tensor]) -> np.ndarray:
        device = self.config.device
        for key in batch:
            batch[key] = batch[key].to(device)
        with torch.no_grad():
            outputs = self.model(batch["events"], batch["numeric"])
            log_probs = F.log_softmax(outputs["event_logits"], dim=-1)
            chosen = torch.gather(log_probs, 2, batch["targets"].unsqueeze(-1)).squeeze(-1)
            delta_error = torch.abs(outputs["delta_pred"] - batch["delta_target"])
            score = (-chosen) + delta_error
            mask = batch["mask"]
            valid_scores = score.masked_select(mask)
            values = valid_scores.detach().cpu().numpy().astype(np.float32, copy=False)
            if values.size == 0:
                return values
            smoothed = _moving_average(values, self.config.smoothing_window)
        return smoothed


def _moving_average(values: np.ndarray, window: int) -> np.ndarray:
    if window <= 1 or len(values) < window:
        return values
    padded = np.pad(values, (window - 1, 0), mode="edge")
    kernel = np.ones(window)
    convolved = np.convolve(padded, kernel, mode="valid") / window
    return convolved


def _load_model_config(run_dir: Path) -> Dict[str, float]:
    config_path = run_dir / "model_config.json"
    if config_path.exists():
        import json

        with config_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    return {}
