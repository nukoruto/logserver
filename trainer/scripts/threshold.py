# -*- coding: utf-8 -*-
"""CLI for threshold computation."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import yaml

from trainer.logserver.scoring.threshold import (
    ThresholdConfig,
    apply_threshold,
    compute_threshold,
)


def _load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def main(config_path: Path) -> None:
    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    scoring_cfg = config.get("scoring", {})
    threshold_cfg = config.get("threshold", {})

    processed_dir = Path(data_cfg.get("processed_dir", "data/processed"))
    scores_path = processed_dir / "scores.csv"
    if not scores_path.exists():
        raise FileNotFoundError(f"Score file not found: {scores_path}")
    df = pd.read_csv(scores_path)

    threshold_config = ThresholdConfig(
        method=threshold_cfg.get("method", "quantile"),
        quantile=float(threshold_cfg.get("quantile", 0.995)),
    )
    threshold, meta = compute_threshold(df["anomaly_score"].tolist(), threshold_config)
    df["anomaly_label"] = apply_threshold(df["anomaly_score"].tolist(), threshold)
    df.to_csv(processed_dir / "scores_with_labels.csv", index=False)

    payload = {"threshold": threshold, **meta}
    with (processed_dir / "threshold.json").open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Compute anomaly score thresholds")
    parser.add_argument(
        "--config",
        default="trainer/configs/default.yaml",
        help="Path to YAML configuration",
    )
    args = parser.parse_args()
    main(Path(args.config))
