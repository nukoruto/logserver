# -*- coding: utf-8 -*-
"""CLI for preprocessing raw logs."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

import pandas as pd
import yaml

from trainer.logserver.dataio.processed import load_processed_events
from trainer.logserver.dataio.sessionize import (
    DEFAULT_CHUNK_SIZE,
    SessionConfig,
    load_events,
    sessionize,
)
from trainer.logserver.eval.preproc_report import generate_preproc_report


def _load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def _collect_rows(
    iterator: Iterable[pd.DataFrame], limit: Optional[int]
) -> pd.DataFrame:
    if limit is None:
        frames = [frame.copy() for frame in iterator if not frame.empty]
        return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    if limit <= 0:
        return pd.DataFrame()
    remaining = limit
    collected = []
    for frame in iterator:
        if frame.empty:
            continue
        if len(frame) > remaining:
            collected.append(frame.head(remaining).copy())
            break
        collected.append(frame.copy())
        remaining -= len(frame)
        if remaining <= 0:
            break
    return pd.concat(collected, ignore_index=True) if collected else pd.DataFrame()


def main(config_path: Path) -> None:
    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    session_cfg = config.get("session", {})
    source = Path(data_cfg.get("raw_dir", "data/raw"))
    output = Path(data_cfg.get("processed_dir", "data/processed"))
    chunksize = int(data_cfg.get("chunksize", DEFAULT_CHUNK_SIZE))
    use_pyarrow = bool(data_cfg.get("use_pyarrow", True))
    session_config = SessionConfig(
        idle_timeout=int(session_cfg.get("idle_timeout", 1800)),
        tz=session_cfg.get("tz", "UTC"),
        chunksize=chunksize,
        use_pyarrow=use_pyarrow,
    )

    sessionize(source, output, session_config, collect_output=False)

    report_cfg = config.get("report", {})
    sample_size = int(report_cfg.get("sample_size", 5))
    report_enabled = bool(report_cfg.get("enabled", True))
    max_rows_raw = report_cfg.get("max_rows", 200_000)
    max_rows = int(max_rows_raw) if max_rows_raw is not None else None
    if report_enabled:
        raw_iterator = load_events(
            source,
            chunksize=chunksize,
            use_pyarrow=use_pyarrow,
            collect=False,
        )
        processed_iterator = load_processed_events(
            output,
            chunksize=chunksize,
            use_pyarrow=use_pyarrow,
            collect=False,
        )
        before = _collect_rows(raw_iterator, max_rows)
        after = _collect_rows(processed_iterator, max_rows)
        report_path = output / "preproc_report.json"
        generate_preproc_report(before, after, report_path, sample_size=sample_size)


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Preprocess raw logs")
    parser.add_argument(
        "--config",
        default="trainer/configs/default.yaml",
        help="Path to YAML configuration",
    )
    args = parser.parse_args()
    main(Path(args.config))
