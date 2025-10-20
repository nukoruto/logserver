"""Training utilities for dt-lstm models."""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader

from .data import collate_batch, load_sequence_dataset, load_vocabulary
from .modules import DeltaTimeModel, DeltaTimeModelConfig

_LOGGER = logging.getLogger("dt_lstm.train")


@dataclass
class TrainingConfig:
    epochs: int = 20
    batch_size: int = 64
    learning_rate: float = 1e-3
    min_learning_rate: float = 1e-5
    scheduler: str = "none"
    early_stopping: int = 5
    clip_grad: float = 1.0
    amp_level: str = "off"
    scheduled_sampling: float = 0.0
    uncertainty_weighting: bool = False
    focal_gamma: Optional[float] = None
    label_smoothing: float = 0.0
    num_workers: int = 0


class TaskUncertaintyWeighter(nn.Module):
    """Learnable uncertainty weighting for multi-task losses."""

    def __init__(self) -> None:
        super().__init__()
        self.log_sigma_event = nn.Parameter(torch.zeros(1))
        self.log_sigma_time = nn.Parameter(torch.zeros(1))

    def forward(self, event_loss: torch.Tensor, time_loss: torch.Tensor) -> Tuple[torch.Tensor, Dict[str, float]]:
        weighted_event = 0.5 * torch.exp(-2 * self.log_sigma_event) * event_loss + self.log_sigma_event
        weighted_time = 0.5 * torch.exp(-2 * self.log_sigma_time) * time_loss + self.log_sigma_time
        total = weighted_event + weighted_time
        stats = {
            "sigma_event": float(torch.exp(self.log_sigma_event.detach()).item()),
            "sigma_time": float(torch.exp(self.log_sigma_time.detach()).item()),
        }
        return total, stats


def _build_dataloader(dataset, batch_size: int, num_workers: int) -> DataLoader:
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=num_workers,
        collate_fn=collate_batch,
        pin_memory=False,
    )


def _build_eval_loader(dataset, batch_size: int, num_workers: int) -> DataLoader:
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=num_workers,
        collate_fn=collate_batch,
        pin_memory=False,
    )


def _compute_event_loss(
    logits: torch.Tensor,
    targets: torch.Tensor,
    mask: torch.Tensor,
    *,
    weight: Optional[torch.Tensor] = None,
    focal_gamma: Optional[float] = None,
    label_smoothing: float = 0.0,
) -> torch.Tensor:
    vocab_size = logits.size(-1)
    flat_logits = logits.view(-1, vocab_size)
    flat_targets = targets.view(-1)
    flat_mask = mask.view(-1)
    if weight is not None:
        weight = weight.to(logits.device)
    loss = F.cross_entropy(
        flat_logits,
        flat_targets,
        weight=weight,
        reduction="none",
        ignore_index=0,
        label_smoothing=label_smoothing,
    )
    if focal_gamma is not None and focal_gamma > 0:
        with torch.no_grad():
            probs = torch.exp(-loss)
        loss = ((1.0 - probs) ** focal_gamma) * loss
    loss = loss * flat_mask.float()
    denom = flat_mask.float().sum().clamp_min(1.0)
    return loss.sum() / denom


def _compute_time_loss(
    outputs: Mapping[str, torch.Tensor],
    delta: torch.Tensor,
    mask: torch.Tensor,
    censor: torch.Tensor,
    objective: str,
) -> torch.Tensor:
    if objective == "rmtpp":
        if not {"rmtpp_log_lambda", "rmtpp_integral"}.issubset(outputs.keys()):
            raise ValueError("RMTPP head did not return necessary statistics")
        log_lambda = outputs["rmtpp_log_lambda"]
        integral = outputs["rmtpp_integral"]
        nll = integral.clone()
        event_mask = (~censor) & mask
        nll = nll + (-log_lambda) * event_mask.float()
        loss = (nll * mask.float()).sum() / mask.float().sum().clamp_min(1.0)
        return loss
    prediction = outputs.get("delta_pred")
    if prediction is None:
        raise ValueError("Time regression head missing delta_pred output")
    target = delta
    mask_float = mask.float()
    valid = mask_float.sum().clamp_min(1.0)
    if objective == "l1":
        return (torch.abs(prediction - target) * mask_float).sum() / valid
    if objective == "huber":
        huber = F.smooth_l1_loss(prediction, target, reduction="none")
        return (huber * mask_float).sum() / valid
    if objective == "nll":
        variance = torch.ones_like(prediction)
        return (0.5 * ((prediction - target) ** 2) / variance + 0.5 * torch.log(variance)).mul(mask_float).sum() / valid
    raise ValueError(f"Unsupported time objective: {objective}")


def _maybe_apply_scheduled_sampling(
    model: DeltaTimeModel,
    batch: Mapping[str, torch.Tensor],
    sampling_prob: float,
) -> Tuple[Mapping[str, torch.Tensor], torch.Tensor]:
    events = batch["events"]
    if sampling_prob <= 0.0 or not model.training:
        outputs = model(events, batch["numeric"])
        return outputs, events
    outputs = model(events, batch["numeric"])
    logits = outputs["event_logits"].detach()
    device = events.device
    if logits.size(1) <= 1:
        return outputs, events
    distribution = torch.distributions.Categorical(logits=logits)
    sampled = distribution.sample()
    mask = batch["mask"]
    bernoulli = torch.rand(events.size(0), events.size(1) - 1, device=device) < sampling_prob
    bernoulli = bernoulli & mask[:, 1:]
    if bernoulli.any():
        scheduled_events = events.clone()
        scheduled_events[:, 1:][bernoulli] = sampled[:, :-1][bernoulli]
        outputs = model(scheduled_events, batch["numeric"])
        return outputs, scheduled_events
    return outputs, events


def _prepare_class_weights(
    mapping: Mapping[str, int],
    vocab_size: int,
    class_weights: Optional[object],
) -> Optional[torch.Tensor]:
    if not class_weights:
        return None
    weight = torch.ones(vocab_size, dtype=torch.float32)
    if isinstance(class_weights, Mapping):
        iterator = class_weights.items()
    else:
        iterator = enumerate(class_weights)  # type: ignore[arg-type]
    for key, value in iterator:
        try:
            index = int(key)
        except ValueError:
            index = mapping.get(str(key))
        if index is None or index >= vocab_size or index < 0:
            continue
        weight[index] = float(value)
    return weight


def train(
    train_patterns: Sequence[str],
    *,
    val_patterns: Sequence[str] | None,
    numeric_columns: Sequence[str],
    delta_column: str,
    vocab_path: Optional[Path],
    idle_timeout: float,
    model_config: DeltaTimeModelConfig,
    training_config: TrainingConfig,
    device: torch.device,
    output_dir: Path,
    seed: int,
    time_objective: str,
    class_weights: Optional[Mapping[str, float]] = None,
    config_source: Optional[Path] = None,
) -> Dict[str, object]:
    torch.manual_seed(seed)
    vocab = load_vocabulary(vocab_path) if vocab_path else None
    train_dataset, train_meta = load_sequence_dataset(
        train_patterns,
        numeric_columns=numeric_columns,
        delta_column=delta_column,
        vocab=vocab,
        idle_timeout=idle_timeout,
    )
    train_meta = dict(train_meta)
    train_meta["idle_timeout"] = float(idle_timeout)
    val_dataset = None
    val_meta: Dict[str, object] | None = None
    if val_patterns:
        val_dataset, val_meta = load_sequence_dataset(
            val_patterns,
            numeric_columns=numeric_columns,
            delta_column=delta_column,
            vocab=vocab,
            idle_timeout=idle_timeout,
        )
        if val_meta is not None:
            val_meta = dict(val_meta)
            val_meta["idle_timeout"] = float(idle_timeout)
    vocab_size = int(train_meta["vocab_size"])
    model_config = DeltaTimeModelConfig(
        **{
            **model_config.to_dict(),
            "vocab_size": vocab_size,
            "numeric_dim": int(train_meta["numeric_dim"]),
        }
    )
    model = DeltaTimeModel(model_config).to(device)

    train_loader = _build_dataloader(train_dataset, training_config.batch_size, training_config.num_workers)
    val_loader = (
        _build_eval_loader(val_dataset, training_config.batch_size, training_config.num_workers)
        if val_dataset is not None
        else None
    )

    optimizer = torch.optim.Adam(
        model.parameters(),
        lr=training_config.learning_rate,
        betas=(0.9, 0.999),
        weight_decay=1e-5,
    )
    scheduler = None
    if training_config.scheduler == "cosine":
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
            optimizer,
            T_max=max(1, training_config.epochs),
            eta_min=training_config.min_learning_rate,
        )

    scaler = torch.cuda.amp.GradScaler(enabled=device.type == "cuda" and training_config.amp_level.lower() != "off")
    uncertainty = TaskUncertaintyWeighter().to(device) if training_config.uncertainty_weighting else None
    if uncertainty is not None:
        optimizer.add_param_group({"params": list(uncertainty.parameters())})

    class_weight_tensor = _prepare_class_weights(vocab.stoi if vocab else {}, vocab_size, class_weights)

    history: Dict[str, List[float]] = {
        "train_loss": [],
        "val_loss": [],
        "train_event_loss": [],
        "train_time_loss": [],
        "val_event_loss": [],
        "val_time_loss": [],
    }
    best_val = math.inf
    patience = training_config.early_stopping
    output_dir.mkdir(parents=True, exist_ok=True)
    amp_enabled = device.type == "cuda" and training_config.amp_level.lower() != "off"

    def _run_epoch(loader: DataLoader, train_mode: bool) -> Tuple[float, float, float, Dict[str, float]]:
        if train_mode:
            model.train()
        else:
            model.eval()
        total_loss = 0.0
        total_event = 0.0
        total_time = 0.0
        total_weight = 0
        sigma_stats = {"sigma_event": float("nan"), "sigma_time": float("nan")}
        context = torch.enable_grad() if train_mode else torch.no_grad()
        with context:
            for batch in loader:
                batch = {key: value.to(device) for key, value in batch.items()}
                mask = batch["mask"]
                valid = mask.float().sum().item()
                if valid == 0:
                    continue
                if train_mode:
                    optimizer.zero_grad(set_to_none=True)
                outputs, _ = _maybe_apply_scheduled_sampling(
                    model,
                    batch,
                    training_config.scheduled_sampling if train_mode else 0.0,
                )
                amp_context = torch.cuda.amp.autocast(enabled=amp_enabled)
                with amp_context:
                    event_loss = _compute_event_loss(
                        outputs["event_logits"],
                        batch["targets"],
                        mask,
                        weight=class_weight_tensor,
                        focal_gamma=training_config.focal_gamma,
                        label_smoothing=training_config.label_smoothing,
                    )
                    time_loss = _compute_time_loss(
                        outputs,
                        batch["delta"],
                        mask,
                        batch["censor"],
                        time_objective,
                    )
                    if uncertainty is not None:
                        combined, sigma_stats = uncertainty(event_loss, time_loss)
                    else:
                        combined = event_loss + time_loss
                if train_mode:
                    scaler.scale(combined).backward()
                    if training_config.clip_grad > 0:
                        scaler.unscale_(optimizer)
                        torch.nn.utils.clip_grad_norm_(model.parameters(), training_config.clip_grad)
                    scaler.step(optimizer)
                    scaler.update()
                total_loss += float(combined.detach().item())
                total_event += float(event_loss.detach().item())
                total_time += float(time_loss.detach().item())
                total_weight += 1
        if scheduler is not None and train_mode:
            scheduler.step()
        divisor = max(total_weight, 1)
        return (
            total_loss / divisor,
            total_event / divisor,
            total_time / divisor,
            sigma_stats,
        )

    for epoch in range(1, training_config.epochs + 1):
        train_metrics = _run_epoch(train_loader, train_mode=True)
        history["train_loss"].append(train_metrics[0])
        history["train_event_loss"].append(train_metrics[1])
        history["train_time_loss"].append(train_metrics[2])
        if val_loader is not None:
            val_metrics = _run_epoch(val_loader, train_mode=False)
        else:
            val_metrics = train_metrics
        history["val_loss"].append(val_metrics[0])
        history["val_event_loss"].append(val_metrics[1])
        history["val_time_loss"].append(val_metrics[2])
        payload = {
            "event": "epoch_completed",
            "epoch": epoch,
            "train_loss": train_metrics[0],
            "val_loss": val_metrics[0],
        }
        if math.isfinite(train_metrics[3]["sigma_event"]):
            payload.update(train_metrics[3])
        _LOGGER.info(json.dumps(payload, ensure_ascii=False))
        if val_metrics[0] < best_val:
            best_val = val_metrics[0]
            patience = training_config.early_stopping
            torch.save(model.state_dict(), output_dir / "model.pt")
            torch.save(optimizer.state_dict(), output_dir / "optimizer.pt")
            if uncertainty is not None:
                torch.save(uncertainty.state_dict(), output_dir / "uncertainty.pt")
        else:
            patience -= 1
            if patience <= 0:
                break

    history_path = output_dir / "history.json"
    history_path.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")

    config_payload = {
        "model": model_config.to_dict(),
        "training": asdict(training_config),
        "data": train_meta,
        "seed": seed,
        "device": str(device),
        "time_objective": time_objective,
        "vocab": vocab_path and str(Path(vocab_path).resolve()),
    }
    if val_meta is not None:
        config_payload["validation"] = val_meta
    if config_source is not None:
        config_payload["config_source"] = str(Path(config_source).resolve())
    config_path = output_dir / "config.json"
    config_path.write_text(json.dumps(config_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "history_path": str(history_path),
        "config_path": str(config_path),
        "model_path": str(output_dir / "model.pt"),
        "optimizer_path": str(output_dir / "optimizer.pt"),
        "best_val_loss": best_val,
    }
