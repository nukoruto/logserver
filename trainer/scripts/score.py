# -*- coding: utf-8 -*-
"""CLI for scoring processed logs."""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import yaml

from trainer.logserver.dataio.processed import load_processed_events
from trainer.logserver.features.encoders import encode_dataframe
from trainer.logserver.scoring.anomaly import AnomalyScorer, ScoringConfig


def _load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def _resolve_run_dir(base: Path) -> Path:
    latest = base / "latest"
    if latest.exists():
        if latest.is_dir():
            return latest
        text = latest.read_text(encoding="utf-8").strip()
        return Path(text)
    candidates = sorted([p for p in base.iterdir() if p.is_dir()], reverse=True)
    if not candidates:
        raise FileNotFoundError("No trained runs found")
    return candidates[0]


def main(config_path: Path) -> None:
    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    logging_cfg = config.get("logging", {})
    scoring_cfg = config.get("scoring", {})

    log_level = logging_cfg.get("level", "INFO")
    logging.basicConfig(level=getattr(logging, str(log_level).upper(), logging.INFO))

    processed_dir = Path(data_cfg.get("processed_dir", "data/processed"))
    df = load_processed_events(processed_dir)
    df.sort_values(["session_id", "timestamp"], inplace=True)
    df.reset_index(drop=True, inplace=True)

    run_dir = _resolve_run_dir(Path(logging_cfg.get("dir", "runs")))
    scorer = AnomalyScorer.from_run(run_dir, ScoringConfig(
        device=scoring_cfg.get("device", "cpu"),
        smoothing_window=int(scoring_cfg.get("smoothing_window", 5)),
    ))

    encoded = encode_dataframe(df, scorer.feature_pack)
    session_ids = df["session_id"].astype(str).tolist()
    scores = scorer.score(encoded, session_ids)

    anomaly_scores = np.zeros(len(df), dtype=np.float32)
    for session_id, indices in df.groupby("session_id").groups.items():
        session_scores = scores.get(session_id)
        if session_scores is None:
            continue
        values = np.asarray(session_scores, dtype=np.float32)
        anomaly_scores[list(indices)] = values[: len(indices)]

    df["anomaly_score"] = anomaly_scores
    output_path = processed_dir / "scores.csv"
    df.to_csv(output_path, index=False)


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Score events with the trained model")
    parser.add_argument(
        "--config",
        default="trainer/configs/default.yaml",
        help="Path to YAML configuration",
    )
    args = parser.parse_args()
    main(Path(args.config))
