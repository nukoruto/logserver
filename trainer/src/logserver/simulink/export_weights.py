# -*- coding: utf-8 -*-
"""Export utilities for Simulink integration."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict

import torch
from scipy.io import savemat

from ..features.encoders import FeaturePack
from ..models.lstm_delta import DeltaAwareLSTM, LSTMConfig


@dataclass
class ExportConfig:
    run_dir: Path
    weights_path: Path
    metadata_path: Path
    input_signature: Dict[str, object]
    output_signature: Dict[str, object]


def export_for_simulink(config: ExportConfig) -> None:
    feature_pack = FeaturePack.load(str(config.run_dir / "features.json"))
    with (config.run_dir / "model_config.json").open("r", encoding="utf-8") as handle:
        metadata = json.load(handle)
    model = DeltaAwareLSTM(
        LSTMConfig(
            vocab_size=len(feature_pack.event_vocab),
            embedding_dim=metadata.get("embedding_dim", 64),
            hidden_size=metadata.get("hidden_size", 64),
            num_layers=metadata.get("num_layers", 1),
            dropout=metadata.get("dropout", 0.1),
        )
    )
    state_dict = torch.load(config.run_dir / "model.pt", map_location="cpu")
    model.load_state_dict(state_dict)
    matrices = {name: tensor.detach().cpu().numpy() for name, tensor in model.state_dict().items()}
    config.weights_path.parent.mkdir(parents=True, exist_ok=True)
    savemat(str(config.weights_path), matrices)
    payload = {
        "input_signature": config.input_signature,
        "output_signature": config.output_signature,
        "vocab": feature_pack.event_vocab.idx_to_token,
    }
    config.metadata_path.parent.mkdir(parents=True, exist_ok=True)
    with config.metadata_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def load_config(path: Path) -> ExportConfig:
    import yaml

    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    export_cfg = data.get("export", {})
    run_dir = Path(export_cfg.get("run_dir", "runs"))
    latest = run_dir / "latest"
    if latest.exists():
        run_dir = latest if latest.is_dir() else Path(latest.read_text(encoding="utf-8").strip())
    return ExportConfig(
        run_dir=run_dir,
        weights_path=Path(export_cfg.get("weights_path", "runs/latest/lstm_weights.mat")),
        metadata_path=Path(export_cfg.get("metadata_path", "runs/latest/model_spec.json")),
        input_signature=export_cfg.get("input_signature", {}),
        output_signature=export_cfg.get("output_signature", {}),
    )


def main(path: Path) -> None:
    config = load_config(path)
    export_for_simulink(config)


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Export trained weights for Simulink")
    parser.add_argument(
        "--config",
        default="trainer/configs/simulink.yaml",
        help="YAML configuration file",
    )
    args = parser.parse_args()
    main(Path(args.config))
