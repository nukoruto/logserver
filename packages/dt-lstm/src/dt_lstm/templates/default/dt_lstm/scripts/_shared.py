"""Shared training script implementation."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from dt_lstm.pipeline import ProjectPipeline


def main() -> None:
    config_path = Path("configs/default.yaml")
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    pipeline = ProjectPipeline(config)
    runtime = pipeline.setup()
    artifacts = pipeline.train()
    result = {
        "runtime": {
            "seed": runtime.seed,
            "device": str(runtime.device),
            "cuda_visible_devices": runtime.cuda_visible_devices,
        },
        "artifacts": artifacts.__dict__,
    }
    Path("reports").mkdir(parents=True, exist_ok=True)
    (Path("reports") / "train_result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
