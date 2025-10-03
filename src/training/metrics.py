# -*- coding: utf-8 -*-
"""Metrics helpers for evaluation."""

from __future__ import annotations

from typing import Dict

import torch
import torch.nn.functional as F


def masked_cross_entropy(logits: torch.Tensor, targets: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    vocab_size = logits.size(-1)
    loss = F.cross_entropy(logits.view(-1, vocab_size), targets.view(-1), reduction="none")
    loss = loss.view_as(targets) * mask.float()
    return loss.sum() / mask.float().sum().clamp_min(1.0)


def masked_mae(predictions: torch.Tensor, targets: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    loss = torch.abs(predictions - targets) * mask.float()
    return loss.sum() / mask.float().sum().clamp_min(1.0)


def compute_metrics(outputs: Dict[str, torch.Tensor], targets: Dict[str, torch.Tensor]) -> Dict[str, float]:
    mask = targets["mask"]
    event_loss = masked_cross_entropy(outputs["event_logits"], targets["targets"], mask)
    delta_loss = masked_mae(outputs["delta_pred"], targets["delta"], mask)
    return {
        "event_loss": float(event_loss.item()),
        "delta_mae": float(delta_loss.item()),
        "loss": float(event_loss.item() + delta_loss.item()),
    }
