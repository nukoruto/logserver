# -*- coding: utf-8 -*-
"""Δt statistics for explainability outputs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

import pandas as pd


@dataclass
class GroupingConfig:
    by: str = "uid"


def compute_dt_statistics(df: pd.DataFrame, config: GroupingConfig) -> pd.DataFrame:
    if "delta_t" not in df.columns:
        raise ValueError("DataFrame must contain delta_t column")
    grouped = df.groupby(config.by)["delta_t"]
    stats = grouped.agg(["count", "mean", "std", "min", "max", lambda x: x.quantile(0.95)])
    stats.rename(columns={"<lambda_0>": "p95"}, inplace=True)
    return stats.reset_index()


def export_stats(stats: pd.DataFrame, output_path: str) -> None:
    output = stats.to_dict(orient="records")
    with open(output_path, "w", encoding="utf-8") as handle:
        import json

        json.dump(output, handle, ensure_ascii=False, indent=2)
