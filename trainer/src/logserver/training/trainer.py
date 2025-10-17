# -*- coding: utf-8 -*-
"""Training loop for the Δt-aware LSTM model."""

from __future__ import annotations

import json
import os
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from ..features.batching import (
    SessionDataset,
    SessionSlice,
    build_sessions,
    collate_examples,
    create_array_session_loader,
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
    device: str = "auto"
    num_workers: Optional[int] = None
    prefetch_factor: Optional[int] = None
    pin_memory: Optional[bool] = None
    persistent_workers: Optional[bool] = None

    def __post_init__(self) -> None:
        profile = self.device.lower()
        gpu_mode = os.getenv("GPU_MODE", "").lower()
        preset = None
        if profile in _GPU_PRESETS:
            preset = _GPU_PRESETS[profile]
        elif profile == "auto" and gpu_mode in _GPU_PRESETS:
            preset = _GPU_PRESETS[gpu_mode]
        if preset:
            if profile == "auto":
                self.device = preset["device"]
            else:
                self.device = preset["device"]
            if self.num_workers is None:
                self.num_workers = preset["num_workers"]
            if self.prefetch_factor is None:
                self.prefetch_factor = preset["prefetch_factor"]
            if self.pin_memory is None:
                self.pin_memory = preset["pin_memory"]
            if self.persistent_workers is None:
                self.persistent_workers = preset["persistent_workers"]
        elif profile == "auto":
            if torch.cuda.is_available():
                self.device = "cuda:0"
                if self.num_workers is None:
                    self.num_workers = 4
                if self.prefetch_factor is None:
                    self.prefetch_factor = 2
                if self.pin_memory is None:
                    self.pin_memory = True
                if self.persistent_workers is None:
                    self.persistent_workers = True
            else:
                self.device = "cpu"
        if self.num_workers is None:
            self.num_workers = 0
        if self.num_workers <= 0:
            self.num_workers = 0
            self.prefetch_factor = None
            self.persistent_workers = False if self.persistent_workers is None else self.persistent_workers
        elif self.prefetch_factor is None:
            self.prefetch_factor = 2
        if self.pin_memory is None:
            self.pin_memory = self.device.startswith("cuda")
        if self.persistent_workers is None:
            self.persistent_workers = self.num_workers > 0


@dataclass
class SessionSplit:
    train_ids: List[str]
    val_ids: List[str]


def _set_seed(seed: int) -> None:
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False
def create_session_split(session_order: Sequence[str], config: TrainerConfig) -> SessionSplit:
    unique_sessions = list(dict.fromkeys(str(session) for session in session_order))
    if not unique_sessions:
        return SessionSplit(train_ids=[], val_ids=[])
    rng = random.Random(config.seed)
    indices = list(range(len(unique_sessions)))
    rng.shuffle(indices)
    val_count = int(len(indices) * config.validation_split)
    if val_count >= len(indices):
        val_count = max(0, len(indices) - 1)
    val_indices = set(indices[:val_count])
    train_ids = [unique_sessions[idx] for idx in indices if idx not in val_indices]
    val_ids = [unique_sessions[idx] for idx in indices if idx in val_indices]
    if not train_ids and val_ids:
        train_ids, val_ids = val_ids, []
    if not train_ids:
        train_ids = unique_sessions
        val_ids = []
    return SessionSplit(train_ids=train_ids, val_ids=val_ids)


def _split_sessions(
    slices: List[SessionSlice],
    session_keys: List[str],
    config: TrainerConfig,
    split: Optional[SessionSplit] = None,
) -> Tuple[List[SessionSlice], List[SessionSlice]]:
    effective_split = split or create_session_split(session_keys, config)
    mapping = {slice_.key: slice_ for slice_ in slices}
    train_sessions = [mapping[key] for key in effective_split.train_ids if key in mapping]
    val_sessions = [mapping[key] for key in effective_split.val_ids if key in mapping]
    if not train_sessions and val_sessions:
        train_sessions, val_sessions = val_sessions, []
    if not train_sessions:
        train_sessions = list(mapping.values())
    return train_sessions, val_sessions


def _prepare_dataloaders(
    encoded: Dict[str, np.ndarray],
    session_ids: List[str],
    config: TrainerConfig,
    numeric_keys: Sequence[str],
    split: Optional[SessionSplit] = None,
) -> Tuple[DataLoader, DataLoader, List[str]]:
    slices, session_keys, ordered_numeric = build_sessions(encoded, session_ids, numeric_keys)
    train_slices, val_slices = _split_sessions(slices, session_keys, config, split)
    loader = create_array_session_loader(encoded, ordered_numeric)
    train_dataset = SessionDataset(train_slices, loader, shuffle=True, seed=config.seed)
    eval_slices = val_slices if val_slices else train_slices
    val_dataset = SessionDataset(eval_slices, loader, shuffle=False, seed=config.seed)

    train_loader = _create_dataloader(train_dataset, config)
    val_loader = _create_dataloader(val_dataset, config)
    return train_loader, val_loader, ordered_numeric


def _create_dataloader(dataset: SessionDataset, config: TrainerConfig) -> DataLoader:
    kwargs: Dict[str, object] = {
        "batch_size": config.batch_size,
        "collate_fn": collate_examples,
        "num_workers": config.num_workers,
        "pin_memory": config.pin_memory,
    }
    if config.num_workers > 0:
        if config.prefetch_factor is not None:
            kwargs["prefetch_factor"] = config.prefetch_factor
        kwargs["persistent_workers"] = config.persistent_workers
        kwargs["worker_init_fn"] = _build_worker_init_fn(config.seed)
    return DataLoader(dataset, **kwargs)


def _build_worker_init_fn(seed: int):
    def _init_fn(worker_id: int) -> None:
        worker_seed = seed + worker_id
        random.seed(worker_seed)
        np.random.seed(worker_seed)
        torch.manual_seed(worker_seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed(worker_seed)

    return _init_fn


def _compute_losses(
    outputs: Dict[str, torch.Tensor],
    batch: Dict[str, torch.Tensor],
    delta_index: int,
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    mask = batch["mask"].float()
    vocab_size = outputs["event_logits"].size(-1)
    event_loss = F.cross_entropy(
        outputs["event_logits"].view(-1, vocab_size),
        batch["targets"].view(-1),
        reduction="none",
        ignore_index=0,
    ).view_as(batch["targets"])
    event_loss = (event_loss * mask).sum() / mask.sum().clamp_min(1.0)

    delta_target = batch["numeric"][:, :, delta_index]
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
    split: Optional[SessionSplit] = None,
) -> Dict[str, List[float]]:
    _set_seed(config.seed)
    numeric_keys = feature_pack.numeric_features
    train_loader, val_loader, ordered_numeric = _prepare_dataloaders(
        encoded, session_ids, config, numeric_keys, split
    )
    try:
        delta_index = ordered_numeric.index("delta_t")
    except ValueError as error:
        raise RuntimeError("Feature pack must include delta_t in numeric features") from error

    model = DeltaAwareLSTM(
        LSTMConfig(
            vocab_size=len(feature_pack.event_vocab),
            embedding_dim=config.embedding_dim,
            hidden_size=config.hidden_size,
            num_layers=config.num_layers,
            dropout=config.dropout,
            numeric_dim=len(ordered_numeric),
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
            loss, event_loss, delta_loss = _compute_losses(outputs, batch, delta_index)
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
                loss, event_loss, delta_loss = _compute_losses(outputs, batch, delta_index)
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
            _persist_artifacts(
                model,
                feature_pack,
                history,
                output_dir,
                config,
                ordered_numeric,
            )
        else:
            patience -= 1
            if patience <= 0:
                break

    return history


def _persist_artifacts(
    model: DeltaAwareLSTM,
    feature_pack: FeaturePack,
    history: Dict[str, List[float]],
    output_dir: Path,
    config: TrainerConfig,
    numeric_keys: Sequence[str],
) -> None:
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
            "device": config.device,
            "num_workers": config.num_workers,
            "prefetch_factor": config.prefetch_factor,
            "pin_memory": config.pin_memory,
            "persistent_workers": config.persistent_workers,
            "numeric_features": list(numeric_keys),
        }, handle, indent=2)
    _write_repro_metadata(run_dir, config)
    latest = output_dir / "latest"
    if latest.exists() and latest.is_symlink():
        latest.unlink()
    try:
        latest.symlink_to(run_dir)
    except OSError:
        with (output_dir / "latest.txt").open("w", encoding="utf-8") as handle:
            handle.write(str(run_dir))


def _write_repro_metadata(run_dir: Path, config: TrainerConfig) -> None:
    import platform
    import subprocess

    metadata = {
        "seed": config.seed,
        "device": config.device,
        "num_workers": config.num_workers,
        "prefetch_factor": config.prefetch_factor,
        "pin_memory": config.pin_memory,
        "persistent_workers": config.persistent_workers,
        "python_version": platform.python_version(),
        "numpy_version": np.__version__,
        "torch_version": torch.__version__,
    }
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=run_dir.parent, text=True).strip()
        metadata["git_commit"] = commit
    except (OSError, subprocess.CalledProcessError):
        metadata["git_commit"] = "unknown"
    with (run_dir / "repro.json").open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, indent=2)


_GPU_PRESETS = {
    "rtx6000": {
        "device": "cuda:0",
        "num_workers": 8,
        "prefetch_factor": 4,
        "pin_memory": True,
        "persistent_workers": True,
    },
    "ada6000": {
        "device": "cuda:0",
        "num_workers": 8,
        "prefetch_factor": 4,
        "pin_memory": True,
        "persistent_workers": True,
    },
    "rtx4060": {
        "device": "cuda:0",
        "num_workers": 4,
        "prefetch_factor": 2,
        "pin_memory": True,
        "persistent_workers": True,
    },
    "4060": {
        "device": "cuda:0",
        "num_workers": 4,
        "prefetch_factor": 2,
        "pin_memory": True,
        "persistent_workers": True,
    },
}
