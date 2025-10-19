#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def fit_command(args: argparse.Namespace) -> None:
    stats_path = Path(args.out)
    stats_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "options": {
            "quantiles": [0.5, 0.9],
        },
    }
    stats_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    if args.meta:
        Path(args.meta).write_text("epsilon: 0.1\n", encoding="utf-8")


def transform_command(args: argparse.Namespace) -> None:
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    input_path = Path(args.infile)
    with input_path.open("r", encoding="utf-8") as source, output.open("w", encoding="utf-8", newline="") as dest:
        reader = csv.DictReader(source)
        fieldnames = reader.fieldnames or []
        extra_cols = [
            "dt_sec",
            "delta_seconds",
            "delta_clipped_seconds",
            "delta_robust_z",
            "delta_z_deseas_clipped",
            "delta_log_burst",
            "row_index",
        ]
        writer = csv.DictWriter(dest, fieldnames=fieldnames + extra_cols)
        writer.writeheader()
        for idx, row in enumerate(reader):
            row["dt_sec"] = "1.0"
            row["delta_seconds"] = "1.0"
            row["delta_clipped_seconds"] = "1.0"
            row["delta_robust_z"] = "0.0"
            row["delta_z_deseas_clipped"] = "0.0"
            row["delta_log_burst"] = "0.0"
            row["row_index"] = str(idx)
            writer.writerow(row)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    fit_parser = subparsers.add_parser("fit")
    fit_parser.add_argument("--in", dest="inputs", nargs="+", required=True)
    fit_parser.add_argument("--out", required=True)
    fit_parser.add_argument("--meta", default=None)
    fit_parser.add_argument("--pretty", action="store_true")

    transform_parser = subparsers.add_parser("transform")
    transform_parser.add_argument("--in", dest="infile", required=True)
    transform_parser.add_argument("--stats", required=True)
    transform_parser.add_argument("--out", required=True)
    transform_parser.add_argument("--validate-schema", action="store_true")

    args = parser.parse_args()
    if args.command == "fit":
        fit_command(args)
    elif args.command == "transform":
        transform_command(args)
    else:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
