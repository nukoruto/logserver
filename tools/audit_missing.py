#!/usr/bin/env python3
"""Compute completeness metrics for raw CSV logs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, Iterable, Mapping

import pandas as pd
import yaml

DEFAULT_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schemas" / "log_schema_v2.yaml"
NULL_SENTINELS = {"null", "none", "na", "nan"}


def _load_schema(path: Path) -> Mapping[str, Iterable[str]]:
    if not path.exists():
        raise FileNotFoundError(f"Schema file not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    required = list(data.get("required_columns", []))
    if not required:
        raise ValueError(f"Schema at {path} does not define required_columns")
    return {"required_columns": required}


def _normalise_missing(series: pd.Series) -> pd.Series:
    lowered = series.astype(str).str.strip().str.lower()
    mask_null = lowered.isin(NULL_SENTINELS)
    return series.isna() | mask_null


def compute_completeness(df: pd.DataFrame, required_columns: Iterable[str]) -> Dict[str, Dict[str, float]]:
    if df.empty:
        raise ValueError("Input dataframe is empty; cannot compute completeness")
    result: Dict[str, Dict[str, float]] = {}
    total = float(len(df))
    for column in required_columns:
        if column not in df.columns:
            raise KeyError(f"Required column missing from dataset: {column}")
        series = df[column]
        missing = float(_normalise_missing(series).sum())
        completeness = 1.0 - (missing / total)
        result[column] = {
            "missing_count": missing,
            "completeness": completeness,
        }
    return result


def audit_file(input_path: Path, schema_path: Path, output_path: Path, fail_on_missing: bool = True) -> Dict[str, Dict[str, float]]:
    schema = _load_schema(schema_path)
    df = pd.read_csv(input_path, keep_default_na=False)
    completeness = compute_completeness(df, schema["required_columns"])
    payload = {
        "schema": str(schema_path),
        "input": str(input_path),
        "rows": int(len(df)),
        "completeness": completeness,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    if fail_on_missing:
        failing = [
            column
            for column, stats in completeness.items()
            if stats["completeness"] < 1.0
        ]
        if failing:
            raise SystemExit(
                f"Completeness check failed for columns: {', '.join(sorted(failing))}"
            )
    return completeness


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit CSV completeness against schema")
    parser.add_argument("input", type=Path, help="Path to input CSV file")
    parser.add_argument(
        "--schema",
        type=Path,
        default=DEFAULT_SCHEMA_PATH,
        help="Path to schema YAML file",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("artifacts/completeness.json"),
        help="Path to output JSON report",
    )
    parser.add_argument(
        "--no-fail",
        action="store_true",
        help="Do not raise an error when completeness < 1.0",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    audit_file(args.input, args.schema, args.output, fail_on_missing=not args.no_fail)


if __name__ == "__main__":  # pragma: no cover
    main()
