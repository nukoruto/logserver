"""Model components for Δt-aware LSTM architectures."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import torch
from torch import Tensor, nn
from torch.nn import functional as F


def _build_activation(name: str) -> nn.Module:
    lowered = name.lower()
    if lowered == "relu":
        return nn.ReLU()
    if lowered == "gelu":
        return nn.GELU()
    if lowered == "silu":
        return nn.SiLU()
    raise ValueError(f"Unsupported activation: {name}")


class ContinuousFeatureProjector(nn.Module):
    """LayerNorm -> MLP projector for continuous features."""

    def __init__(
        self,
        input_dim: int,
        hidden_dims: Sequence[int],
        *,
        activation: str = "gelu",
        dropout: float = 0.0,
    ) -> None:
        super().__init__()
        self.input_dim = int(input_dim)
        self.hidden_dims = list(hidden_dims)
        self.activation = activation
        self.dropout = float(dropout)
        self.norm = nn.LayerNorm(self.input_dim) if self.input_dim > 0 else None
        layers: List[nn.Module] = []
        in_dim = self.input_dim
        if self.hidden_dims:
            for index, hidden_dim in enumerate(self.hidden_dims):
                layers.append(nn.Linear(in_dim, hidden_dim))
                layers.append(_build_activation(self.activation))
                if self.dropout > 0.0:
                    layers.append(nn.Dropout(self.dropout))
                in_dim = hidden_dim
        self.mlp = nn.Sequential(*layers)

    @property
    def output_dim(self) -> int:
        if self.hidden_dims:
            return int(self.hidden_dims[-1])
        return int(self.input_dim)

    def forward(self, features: Tensor) -> Tensor:
        if self.input_dim == 0:
            batch, steps = features.shape[:2]
            return features.new_zeros(batch, steps, 0)
        output = features
        if self.norm is not None:
            output = self.norm(output)
        if self.hidden_dims:
            output = self.mlp(output)
        return output


class _StackedLSTMCells(nn.Module):
    """Manual LSTM stack with masking support."""

    def __init__(self, input_size: int, hidden_size: int, num_layers: int, dropout: float) -> None:
        super().__init__()
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        self.dropout_layer = nn.Dropout(dropout) if dropout > 0.0 and num_layers > 1 else None
        cells: List[nn.Module] = []
        current_size = input_size
        for _ in range(num_layers):
            cells.append(nn.LSTMCell(current_size, hidden_size))
            current_size = hidden_size
        self.cells = nn.ModuleList(cells)

    def forward(
        self,
        inputs: Tensor,
        *,
        lengths: Optional[Tensor] = None,
        hidden: Optional[Tuple[Tensor, Tensor]] = None,
    ) -> Tuple[Tensor, Tuple[Tensor, Tensor]]:
        batch, steps, _ = inputs.shape
        if hidden is None:
            h_states = [inputs.new_zeros(batch, self.hidden_size) for _ in range(self.num_layers)]
            c_states = [inputs.new_zeros(batch, self.hidden_size) for _ in range(self.num_layers)]
        else:
            h_states = [hidden[0][layer] for layer in range(self.num_layers)]
            c_states = [hidden[1][layer] for layer in range(self.num_layers)]
        outputs: List[Tensor] = []
        mask: Optional[Tensor] = None
        if lengths is not None:
            mask = torch.arange(steps, device=inputs.device).unsqueeze(0) < lengths.unsqueeze(1)
        for step in range(steps):
            x_t = inputs[:, step, :]
            for layer, cell in enumerate(self.cells):
                h_prev, c_prev = h_states[layer], c_states[layer]
                h_new, c_new = cell(x_t, (h_prev, c_prev))
                if mask is not None:
                    valid = mask[:, step].unsqueeze(1).float()
                    h_states[layer] = valid * h_new + (1.0 - valid) * h_prev
                    c_states[layer] = valid * c_new + (1.0 - valid) * c_prev
                else:
                    h_states[layer], c_states[layer] = h_new, c_new
                x_t = h_states[layer]
                if layer < self.num_layers - 1 and self.dropout_layer is not None:
                    x_t = self.dropout_layer(x_t)
            outputs.append(x_t.unsqueeze(1))
        output_tensor = torch.cat(outputs, dim=1)
        final_hidden = (
            torch.stack(h_states, dim=0),
            torch.stack(c_states, dim=0),
        )
        return output_tensor, final_hidden


class PhasedLSTMCell(nn.Module):
    """Phased LSTM cell with learnable time gate."""

    def __init__(self, input_size: int, hidden_size: int) -> None:
        super().__init__()
        self.cell = nn.LSTMCell(input_size, hidden_size)
        self.hidden_size = hidden_size
        self.tau_raw = nn.Parameter(torch.zeros(hidden_size))
        self.shift_raw = nn.Parameter(torch.zeros(hidden_size))
        self.r_on_raw = nn.Parameter(torch.zeros(hidden_size))
        self.register_buffer("_eps", torch.tensor(1e-6))

    def forward(self, x_t: Tensor, time_t: Tensor, hx: Tuple[Tensor, Tensor]) -> Tuple[Tensor, Tensor]:
        h_prev, c_prev = hx
        tau = F.softplus(self.tau_raw) + self._eps
        shift = torch.sigmoid(self.shift_raw) * tau
        r_on = torch.clamp(torch.sigmoid(self.r_on_raw), 0.05, 0.5)
        t = time_t.unsqueeze(1)
        phase = torch.remainder(t - shift, tau) / tau
        r = r_on.unsqueeze(0)
        slope = torch.where(
            phase < 0.5 * r,
            2.0 * phase / (r + self._eps),
            torch.where(
                phase < r,
                2.0 - (2.0 * phase / (r + self._eps)),
                torch.zeros_like(phase),
            ),
        )
        k_t = torch.clamp(slope, 0.0, 1.0)
        h_candidate, c_candidate = self.cell(x_t, hx)
        c_new = k_t * c_candidate + (1.0 - k_t) * c_prev
        h_new = k_t * h_candidate + (1.0 - k_t) * h_prev
        return h_new, c_new


class _StackedPhasedLSTM(nn.Module):
    """Stack of phased LSTM cells."""

    def __init__(self, input_size: int, hidden_size: int, num_layers: int, dropout: float) -> None:
        super().__init__()
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        self.dropout_layer = nn.Dropout(dropout) if dropout > 0.0 and num_layers > 1 else None
        cells: List[PhasedLSTMCell] = []
        current = input_size
        for _ in range(num_layers):
            cells.append(PhasedLSTMCell(current, hidden_size))
            current = hidden_size
        self.cells = nn.ModuleList(cells)

    def forward(
        self,
        inputs: Tensor,
        times: Tensor,
        *,
        lengths: Optional[Tensor] = None,
        hidden: Optional[Tuple[Tensor, Tensor]] = None,
    ) -> Tuple[Tensor, Tuple[Tensor, Tensor]]:
        batch, steps, _ = inputs.shape
        if hidden is None:
            h_states = [inputs.new_zeros(batch, self.hidden_size) for _ in range(self.num_layers)]
            c_states = [inputs.new_zeros(batch, self.hidden_size) for _ in range(self.num_layers)]
        else:
            h_states = [hidden[0][layer] for layer in range(self.num_layers)]
            c_states = [hidden[1][layer] for layer in range(self.num_layers)]
        mask: Optional[Tensor] = None
        if lengths is not None:
            mask = torch.arange(steps, device=inputs.device).unsqueeze(0) < lengths.unsqueeze(1)
        outputs: List[Tensor] = []
        for step in range(steps):
            x_t = inputs[:, step, :]
            t_t = times[:, step]
            for layer, cell in enumerate(self.cells):
                h_prev, c_prev = h_states[layer], c_states[layer]
                h_new, c_new = cell(x_t, t_t, (h_prev, c_prev))
                if mask is not None:
                    valid = mask[:, step].unsqueeze(1).float()
                    h_states[layer] = valid * h_new + (1.0 - valid) * h_prev
                    c_states[layer] = valid * c_new + (1.0 - valid) * c_prev
                else:
                    h_states[layer], c_states[layer] = h_new, c_new
                x_t = h_states[layer]
                if layer < self.num_layers - 1 and self.dropout_layer is not None:
                    x_t = self.dropout_layer(x_t)
            outputs.append(x_t.unsqueeze(1))
        output_tensor = torch.cat(outputs, dim=1)
        final_hidden = (
            torch.stack(h_states, dim=0),
            torch.stack(c_states, dim=0),
        )
        return output_tensor, final_hidden


class RegressionTimeHead(nn.Module):
    """Simple regression time head."""

    def __init__(self, hidden_size: int) -> None:
        super().__init__()
        self.linear = nn.Linear(hidden_size, 1)

    def forward(self, hidden_states: Tensor) -> Dict[str, Tensor]:
        delta_pred = self.linear(hidden_states).squeeze(-1)
        return {"delta_pred": delta_pred}


class RMTPPTimeHead(nn.Module):
    """RMTPP head returning parameters for conditional intensity."""

    def __init__(self, hidden_size: int, *, eps: float = 1e-6) -> None:
        super().__init__()
        self.linear = nn.Linear(hidden_size, 2)
        self.eps = float(eps)

    def forward(self, hidden_states: Tensor, delta: Optional[Tensor] = None) -> Dict[str, Tensor]:
        raw = self.linear(hidden_states)
        g = raw[..., 0]
        w = F.softplus(raw[..., 1]) + self.eps
        result: Dict[str, Tensor] = {"rmtpp_g": g, "rmtpp_w": w}
        if delta is not None:
            log_lambda = g + w * delta
            exp_g = torch.exp(g)
            exp_term = torch.exp(log_lambda)
            integral = torch.where(
                torch.abs(w) < 1e-6,
                exp_g * delta,
                (exp_term - exp_g) / w,
            )
            nll = -log_lambda + integral
            result.update(
                {
                    "rmtpp_log_lambda": log_lambda,
                    "rmtpp_integral": integral,
                    "rmtpp_nll": nll,
                }
            )
        return result


@dataclass
class DeltaTimeModelConfig:
    """Configuration for Δt-aware models."""

    arch: str = "lstm"
    vocab_size: int = 128
    embedding_dim: int = 64
    hidden_size: int = 128
    num_layers: int = 1
    dropout: float = 0.1
    numeric_dim: int = 4
    mlp_hidden_dims: Sequence[int] = field(default_factory=lambda: [64])
    mlp_activation: str = "gelu"
    mlp_dropout: float = 0.0
    time_head: str = "regression"
    delta_index: int = 0
    rmtpp_eps: float = 1e-6

    def to_dict(self) -> Dict[str, object]:
        return {
            "arch": self.arch,
            "vocab_size": int(self.vocab_size),
            "embedding_dim": int(self.embedding_dim),
            "hidden_size": int(self.hidden_size),
            "num_layers": int(self.num_layers),
            "dropout": float(self.dropout),
            "numeric_dim": int(self.numeric_dim),
            "mlp_hidden_dims": [int(v) for v in self.mlp_hidden_dims],
            "mlp_activation": self.mlp_activation,
            "mlp_dropout": float(self.mlp_dropout),
            "time_head": self.time_head,
            "delta_index": int(self.delta_index),
            "rmtpp_eps": float(self.rmtpp_eps),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, object]) -> "DeltaTimeModelConfig":
        return cls(
            arch=str(data.get("arch", "lstm")),
            vocab_size=int(data.get("vocab_size", 128)),
            embedding_dim=int(data.get("embedding_dim", 64)),
            hidden_size=int(data.get("hidden_size", 128)),
            num_layers=int(data.get("num_layers", 1)),
            dropout=float(data.get("dropout", 0.1)),
            numeric_dim=int(data.get("numeric_dim", 4)),
            mlp_hidden_dims=tuple(int(v) for v in data.get("mlp_hidden_dims", [64])),
            mlp_activation=str(data.get("mlp_activation", "gelu")),
            mlp_dropout=float(data.get("mlp_dropout", 0.0)),
            time_head=str(data.get("time_head", "regression")),
            delta_index=int(data.get("delta_index", 0)),
            rmtpp_eps=float(data.get("rmtpp_eps", 1e-6)),
        )


class DeltaTimeModel(nn.Module):
    """Combined embedding, projector, sequence backbone, and heads."""

    def __init__(self, config: DeltaTimeModelConfig) -> None:
        super().__init__()
        self.config = config
        self.embedding = nn.Embedding(config.vocab_size, config.embedding_dim, padding_idx=0)
        self.projector = ContinuousFeatureProjector(
            config.numeric_dim,
            config.mlp_hidden_dims,
            activation=config.mlp_activation,
            dropout=config.mlp_dropout,
        )
        lstm_input = config.embedding_dim + self.projector.output_dim
        if config.arch == "lstm":
            self.backbone = _StackedLSTMCells(lstm_input, config.hidden_size, config.num_layers, config.dropout)
        elif config.arch == "phased_lstm":
            self.backbone = _StackedPhasedLSTM(lstm_input, config.hidden_size, config.num_layers, config.dropout)
        else:
            raise ValueError(f"Unsupported architecture: {config.arch}")
        self.event_head = nn.Linear(config.hidden_size, config.vocab_size)
        if config.time_head == "regression":
            self.time_head_module: nn.Module = RegressionTimeHead(config.hidden_size)
        elif config.time_head == "rmtpp":
            self.time_head_module = RMTPPTimeHead(config.hidden_size, eps=config.rmtpp_eps)
        else:
            raise ValueError(f"Unsupported time head: {config.time_head}")

    def forward(
        self,
        events: Tensor,
        numeric: Tensor,
        *,
        times: Optional[Tensor] = None,
        lengths: Optional[Tensor] = None,
        hidden: Optional[Tuple[Tensor, Tensor]] = None,
    ) -> Dict[str, Tensor]:
        embedded = self.embedding(events)
        projected = self.projector(numeric)
        features = torch.cat([embedded, projected], dim=-1)
        if isinstance(self.backbone, _StackedPhasedLSTM):
            if times is None:
                raise ValueError("times must be provided for phased LSTM architecture")
            sequence, hidden_state = self.backbone(features, times, lengths=lengths, hidden=hidden)
        else:
            sequence, hidden_state = self.backbone(features, lengths=lengths, hidden=hidden)
        logits = self.event_head(sequence)
        result: Dict[str, Tensor] = {
            "event_logits": logits,
            "event_prob": torch.softmax(logits, dim=-1),
            "hidden": hidden_state[0],
        }
        delta = None
        if numeric.shape[-1] > self.config.delta_index:
            delta = numeric[..., self.config.delta_index]
        if isinstance(self.time_head_module, RMTPPTimeHead):
            result.update(self.time_head_module(sequence, delta=delta))
        else:
            result.update(self.time_head_module(sequence))
        return result
