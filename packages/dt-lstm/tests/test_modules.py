"""Unit tests for Δt-aware model components."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import torch

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm.model_def import ModelDefinition
from dt_lstm.modules import DeltaTimeModel, DeltaTimeModelConfig


def _prepare_inputs(batch: int, steps: int, vocab: int, numeric_dim: int) -> tuple[torch.Tensor, torch.Tensor]:
    events = torch.randint(0, vocab, (batch, steps))
    numeric = torch.randn(batch, steps, numeric_dim)
    return events, numeric


def test_delta_time_model_regression_head_shapes():
    config = DeltaTimeModelConfig(
        arch="lstm",
        vocab_size=17,
        embedding_dim=8,
        hidden_size=12,
        num_layers=2,
        dropout=0.1,
        numeric_dim=4,
        mlp_hidden_dims=(10,),
        time_head="regression",
        delta_index=0,
    )
    model = DeltaTimeModel(config)
    events, numeric = _prepare_inputs(3, 5, config.vocab_size, config.numeric_dim)
    output = model(events, numeric)
    assert output["event_logits"].shape == (3, 5, config.vocab_size)
    assert output["event_prob"].shape == (3, 5, config.vocab_size)
    assert output["delta_pred"].shape == (3, 5)


def test_delta_time_model_rmtpp_outputs():
    config = DeltaTimeModelConfig(
        arch="lstm",
        vocab_size=11,
        embedding_dim=6,
        hidden_size=9,
        num_layers=1,
        dropout=0.0,
        numeric_dim=2,
        mlp_hidden_dims=(),
        time_head="rmtpp",
        delta_index=1,
    )
    model = DeltaTimeModel(config)
    events, numeric = _prepare_inputs(2, 4, config.vocab_size, config.numeric_dim)
    numeric[..., 1] = torch.abs(numeric[..., 1])
    output = model(events, numeric)
    assert set(output).issuperset({"rmtpp_g", "rmtpp_w", "rmtpp_integral", "rmtpp_nll"})
    assert torch.all(output["rmtpp_w"] > 0)


def test_phased_lstm_requires_times():
    config = DeltaTimeModelConfig(
        arch="phased_lstm",
        vocab_size=9,
        embedding_dim=4,
        hidden_size=7,
        num_layers=1,
        dropout=0.0,
        numeric_dim=3,
        mlp_hidden_dims=(5,),
        time_head="regression",
    )
    model = DeltaTimeModel(config)
    events, numeric = _prepare_inputs(1, 3, config.vocab_size, config.numeric_dim)
    with pytest.raises(ValueError):
        model(events, numeric)
    times = torch.linspace(0.0, 1.0, 3).repeat(events.size(0), 1)
    output = model(events, numeric, times=times)
    assert output["event_logits"].shape == (1, 3, config.vocab_size)


def test_model_definition_roundtrip(tmp_path: Path):
    config = DeltaTimeModelConfig(
        arch="lstm",
        vocab_size=13,
        embedding_dim=5,
        hidden_size=6,
        num_layers=2,
        dropout=0.1,
        numeric_dim=4,
        mlp_hidden_dims=(8,),
        time_head="rmtpp",
        delta_index=0,
    )
    model = DeltaTimeModel(config)
    definition = ModelDefinition(config=config, metadata={"param_count": sum(p.numel() for p in model.parameters())})
    path = tmp_path / "model.json"
    path.write_text(json.dumps(definition.to_dict()), encoding="utf-8")
    loaded = ModelDefinition.from_dict(json.loads(path.read_text(encoding="utf-8")))
    assert loaded.config.hidden_size == config.hidden_size
    model_rebuilt = loaded.build_model()
    assert sum(p.numel() for p in model.parameters()) == sum(p.numel() for p in model_rebuilt.parameters())
