# -*- coding: utf-8 -*-
"""CLI for explainability artefacts."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import yaml

from src.explain.case_report import build_case_records, export_case_report
from src.explain.dt_stats import GroupingConfig, compute_dt_statistics, export_stats


def _load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def main(config_path: Path) -> None:
    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    explain_cfg = config.get("explain", {})

    processed_dir = Path(data_cfg.get("processed_dir", "data/processed"))
    scores_path = processed_dir / "scores_with_labels.csv"
    if not scores_path.exists():
        raise FileNotFoundError("scores_with_labels.csv not found. Run threshold step first.")
    df = pd.read_csv(scores_path)

    stats = compute_dt_statistics(df, GroupingConfig(by=explain_cfg.get("group_by", "user_id")))
    export_stats(stats, str(processed_dir / "dt_stats.json"))

    top_n = int(explain_cfg.get("top_n", 20))
    anomalies = df[df["anomaly_label"] == 1].nlargest(top_n, "anomaly_score")
    records = build_case_records(anomalies.to_dict(orient="records"))
    export_case_report(records, processed_dir / "reports")


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Generate explainability artefacts")
    parser.add_argument("--config", default="configs/default.yaml", help="Path to YAML configuration")
    args = parser.parse_args()
    main(Path(args.config))
