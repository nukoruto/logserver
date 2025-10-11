# -*- coding: utf-8 -*-
"""Training loop for the Δt-aware LSTM model."""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from ..features.batching import (
    SessionDataset,
    SessionExample,
    build_sessions,
    collate_examples,
)
from ..features.encoders import FeaturePack
from ..models.lstm_delta import DeltaAwareLSTM, LSTMConfig


@dataclass
class TrainerConfig:
    batch_size: int = 64
    max_epochs: int = 20
    learning_rate: float = 1e-3
    validation_split: float = 0.1
    early_stopping_patience: int = 3
    seed: int = 42
    embedding_dim: int = 64
    hidden_size: int = 64
    num_layers: int = 1
    dropout: float = 0.1
    device: str = "cpu"


def _set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def _to_examples(sessions: List[Dict[str, np.ndarray]]) -> List[SessionExample]:
    examples: List[SessionExample] = []
    for session in sessions:
        examples.append(
            SessionExample(
                event_ids=session["event_ids"].astype(np.int64),
                numeric=session["numeric"].astype(np.float32),
                target_event=session["target_event"].astype(np.int64),
            )
        )
    return examples


def _split_sessions(sessions: List[Dict[str, np.ndarray]], config: TrainerConfig) -> Tuple[List[SessionExample], List[SessionExample]]:
    indices = list(range(len(sessions)))
    random.shuffle(indices)
    val_count = int(len(indices) * config.validation_split)
    if val_count >= len(indices):
        val_count = max(0, len(indices) - 1)
    val_indices = set(indices[:val_count])
    train_sessions = [sessions[idx] for idx in indices if idx not in val_indices]
    val_sessions = [sessions[idx] for idx in indices if idx in val_indices]
    if not train_sessions:
        train_sessions, val_sessions = val_sessions, train_sessions
    return _to_examples(train_sessions), _to_examples(val_sessions)


def _prepare_dataloaders(encoded: Dict[str, np.ndarray], session_ids: List[str], config: TrainerConfig) -> Tuple[DataLoader, DataLoader]:
    sessions, _ = build_sessions(encoded, session_ids)
    train_examples, val_examples = _split_sessions(sessions, config)
    train_loader = DataLoader(SessionDataset(train_examples), batch_size=config.batch_size, shuffle=True, collate_fn=collate_examples)
    if val_examples:
        val_loader = DataLoader(SessionDataset(val_examples), batch_size=config.batch_size, shuffle=False, collate_fn=collate_examples)
    else:
        val_loader = DataLoader(SessionDataset(train_examples), batch_size=config.batch_size, shuffle=False, collate_fn=collate_examples)
    return train_loader, val_loader


def _compute_losses(outputs: Dict[str, torch.Tensor], batch: Dict[str, torch.Tensor]) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    mask = batch["mask"].float()
    vocab_size = outputs["event_logits"].size(-1)
    event_loss = F.cross_entropy(
        outputs["event_logits"].view(-1, vocab_size),
        batch["targets"].view(-1),
        reduction="none",
        ignore_index=0,
    ).view_as(batch["targets"])
    event_loss = (event_loss * mask).sum() / mask.sum().clamp_min(1.0)

    delta_target = batch["numeric"][:, :, 0]
    delta_loss = torch.abs(outputs["delta_pred"] - delta_target) * mask
    delta_loss = delta_loss.sum() / mask.sum().clamp_min(1.0)

    total_loss = event_loss + delta_loss
    return total_loss, event_loss, delta_loss


def train_model(
    encoded: Dict[str, np.ndarray],
    session_ids: List[str],
    feature_pack: FeaturePack,
    output_dir: Path,
    config: TrainerConfig,
) -> Dict[str, List[float]]:
    _set_seed(config.seed)
    train_loader, val_loader = _prepare_dataloaders(encoded, session_ids, config)

    model = DeltaAwareLSTM(
        LSTMConfig(
            vocab_size=len(feature_pack.event_vocab),
            embedding_dim=config.embedding_dim,
            hidden_size=config.hidden_size,
            num_layers=config.num_layers,
            dropout=config.dropout,
            numeric_dim=3,
        )
    ).to(config.device)
    optimizer = torch.optim.Adam(model.parameters(), lr=config.learning_rate)

    history = {"train_loss": [], "val_loss": [], "train_event_loss": [], "val_event_loss": [], "train_delta_loss": [], "val_delta_loss": []}
    best_val = float("inf")
    patience = config.early_stopping_patience

    for epoch in range(1, config.max_epochs + 1):
        model.train()
        train_totals = {"loss": 0.0, "event": 0.0, "delta": 0.0, "batches": 0}
        for batch in train_loader:
            for key in batch:
                batch[key] = batch[key].to(config.device)
            optimizer.zero_grad()
            outputs = model(batch["events"], batch["numeric"])
            loss, event_loss, delta_loss = _compute_losses(outputs, batch)
            loss.backward()
            optimizer.step()
            train_totals["loss"] += float(loss.item())
            train_totals["event"] += float(event_loss.item())
            train_totals["delta"] += float(delta_loss.item())
            train_totals["batches"] += 1

        model.eval()
        val_totals = {"loss": 0.0, "event": 0.0, "delta": 0.0, "batches": 0}
        with torch.no_grad():
            for batch in val_loader:
                for key in batch:
                    batch[key] = batch[key].to(config.device)
                outputs = model(batch["events"], batch["numeric"])
                loss, event_loss, delta_loss = _compute_losses(outputs, batch)
                val_totals["loss"] += float(loss.item())
                val_totals["event"] += float(event_loss.item())
                val_totals["delta"] += float(delta_loss.item())
                val_totals["batches"] += 1

        train_loss = train_totals["loss"] / max(train_totals["batches"], 1)
        val_loss = val_totals["loss"] / max(val_totals["batches"], 1)
        history["train_loss"].append(train_loss)
        history["val_loss"].append(val_loss)
        history["train_event_loss"].append(train_totals["event"] / max(train_totals["batches"], 1))
        history["val_event_loss"].append(val_totals["event"] / max(val_totals["batches"], 1))
        history["train_delta_loss"].append(train_totals["delta"] / max(train_totals["batches"], 1))
        history["val_delta_loss"].append(val_totals["delta"] / max(val_totals["batches"], 1))

        if val_loss < best_val:
            best_val = val_loss
            patience = config.early_stopping_patience
            _persist_artifacts(model, feature_pack, history, output_dir, config)
        else:
            patience -= 1
            if patience <= 0:
                break

    return history


def _persist_artifacts(model: DeltaAwareLSTM, feature_pack: FeaturePack, history: Dict[str, List[float]], output_dir: Path, config: TrainerConfig) -> None:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    run_dir = output_dir / timestamp
    run_dir.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), run_dir / "model.pt")
    feature_pack.save(str(run_dir / "features.json"))
    with (run_dir / "history.json").open("w", encoding="utf-8") as handle:
        json.dump(history, handle, indent=2)
    with (run_dir / "model_config.json").open("w", encoding="utf-8") as handle:
        json.dump({
            "embedding_dim": config.embedding_dim,
            "hidden_size": config.hidden_size,
            "num_layers": config.num_layers,
            "dropout": config.dropout,
        }, handle, indent=2)
    latest = output_dir / "latest"
    if latest.exists() and latest.is_symlink():
        latest.unlink()
    try:
        latest.symlink_to(run_dir)
    except OSError:
        with (output_dir / "latest.txt").open("w", encoding="utf-8") as handle:
            handle.write(str(run_dir))
