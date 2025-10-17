# -*- coding: utf-8 -*-
"""CLI for scoring processed logs."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterator, Tuple

import numpy as np
import pandas as pd
import yaml

from trainer.logserver.dataio.processed import load_processed_events
from trainer.logserver.dataio.sessionize import DEFAULT_CHUNK_SIZE
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


def _split_carryover(chunk: pd.DataFrame, carryover: pd.DataFrame) -> Tuple[pd.DataFrame, pd.DataFrame]:
    combined = pd.concat([carryover, chunk], ignore_index=True)
    if combined.empty:
        return pd.DataFrame(columns=chunk.columns), pd.DataFrame(columns=chunk.columns)
    combined.sort_values(["session_id", "timestamp"], inplace=True)
    last_session = combined.iloc[-1]["session_id"]
    mask_last = combined["session_id"] == last_session
    process_part = combined.loc[~mask_last].copy()
    next_carryover = combined.loc[mask_last].copy()
    return process_part, next_carryover


def _score_dataframe(df: pd.DataFrame, scorer: AnomalyScorer) -> pd.DataFrame:
    if df.empty:
        return df
    df = df.copy().reset_index(drop=True)
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
    return df


def _write_scores(df: pd.DataFrame, path: Path, *, first_chunk: bool) -> None:
    if df.empty:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, mode="w" if first_chunk else "a", header=first_chunk, index=False)


def _iter_processed(
    processed_dir: Path,
    *,
    chunksize: int,
    use_pyarrow: bool,
) -> Iterator[pd.DataFrame]:
    iterator = load_processed_events(
        processed_dir,
        chunksize=chunksize,
        use_pyarrow=use_pyarrow,
        collect=False,
    )
    for frame in iterator:
        if frame.empty:
            continue
        required = {"session_id", "timestamp", "event"}
        missing = required - set(frame.columns)
        if missing:
            raise ValueError(f"Processed dataset is missing required columns: {sorted(missing)}")
        frame.sort_values(["session_id", "timestamp"], inplace=True)
        frame.reset_index(drop=True, inplace=True)
        yield frame


def main(config_path: Path) -> None:
    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    logging_cfg = config.get("logging", {})
    scoring_cfg = config.get("scoring", {})

    log_level = logging_cfg.get("level", "INFO")
    logging.basicConfig(level=getattr(logging, str(log_level).upper(), logging.INFO))

    processed_dir = Path(data_cfg.get("processed_dir", "data/processed"))
    chunksize = int(scoring_cfg.get("chunksize", DEFAULT_CHUNK_SIZE))
    use_pyarrow = bool(scoring_cfg.get("use_pyarrow", True))

    run_dir = _resolve_run_dir(Path(logging_cfg.get("dir", "runs")))
    scorer = AnomalyScorer.from_run(
        run_dir,
        ScoringConfig(
            device=scoring_cfg.get("device", "cpu"),
            smoothing_window=int(scoring_cfg.get("smoothing_window", 5)),
        ),
    )

    output_path = processed_dir / "scores.csv"
    carryover = pd.DataFrame()
    first_chunk = True
    for chunk in _iter_processed(processed_dir, chunksize=chunksize, use_pyarrow=use_pyarrow):
        to_process, carryover = _split_carryover(chunk, carryover)
        scored = _score_dataframe(to_process, scorer)
        _write_scores(scored, output_path, first_chunk=first_chunk)
        if not scored.empty:
            first_chunk = False
    if not carryover.empty:
        scored = _score_dataframe(carryover, scorer)
        _write_scores(scored, output_path, first_chunk=first_chunk)


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
