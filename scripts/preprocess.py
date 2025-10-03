# -*- coding: utf-8 -*-
"""CLI for preprocessing raw logs."""

from __future__ import annotations

from pathlib import Path

import yaml

from src.dataio.sessionize import SessionConfig, sessionize


def _load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def main(config_path: Path) -> None:
    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    session_cfg = config.get("session", {})
    source = Path(data_cfg.get("raw_dir", "data/raw"))
    output = Path(data_cfg.get("processed_dir", "data/processed"))
    sessionize(
        source,
        output,
        SessionConfig(
            idle_timeout=int(session_cfg.get("idle_timeout", 1800)),
            tz=session_cfg.get("tz", "UTC"),
        ),
    )


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Preprocess raw logs")
    parser.add_argument("--config", default="configs/default.yaml", help="Path to YAML configuration")
    args = parser.parse_args()
    main(Path(args.config))
