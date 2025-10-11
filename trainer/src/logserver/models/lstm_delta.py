# -*- coding: utf-8 -*-
"""Δt-aware LSTM model for joint event and timing prediction."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

import torch
from torch import nn


@dataclass
class LSTMConfig:
    vocab_size: int
    embedding_dim: int = 64
    hidden_size: int = 64
    num_layers: int = 1
    dropout: float = 0.1
    numeric_dim: int = 3


class DeltaAwareLSTM(nn.Module):
    def __init__(self, config: LSTMConfig):
        super().__init__()
        self.embedding = nn.Embedding(config.vocab_size, config.embedding_dim, padding_idx=0)
        lstm_input = config.embedding_dim + config.numeric_dim
        self.lstm = nn.LSTM(
            input_size=lstm_input,
            hidden_size=config.hidden_size,
            num_layers=config.num_layers,
            batch_first=True,
            dropout=config.dropout if config.num_layers > 1 else 0.0,
        )
        self.event_head = nn.Linear(config.hidden_size, config.vocab_size)
        self.delta_head = nn.Linear(config.hidden_size, 1)

    def forward(self, events: torch.Tensor, numeric: torch.Tensor, hidden: Optional[torch.Tensor] = None) -> Dict[str, torch.Tensor]:
        embedded = self.embedding(events)
        concat = torch.cat([embedded, numeric], dim=-1)
        outputs, hidden_state = self.lstm(concat, hidden)
        event_logits = self.event_head(outputs)
        delta_pred = self.delta_head(outputs).squeeze(-1)
        return {"event_logits": event_logits, "delta_pred": delta_pred, "hidden": hidden_state}
