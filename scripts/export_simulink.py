# -*- coding: utf-8 -*-
"""CLI for exporting weights to Simulink."""

from __future__ import annotations

from pathlib import Path

from src.simulink.export_weights import load_config, export_for_simulink


def main(config_path: Path) -> None:
    export_cfg = load_config(config_path)
    export_for_simulink(export_cfg)


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Export trained model for Simulink usage")
    parser.add_argument("--config", default="configs/simulink.yaml", help="Path to YAML configuration")
    args = parser.parse_args()
    main(Path(args.config))
