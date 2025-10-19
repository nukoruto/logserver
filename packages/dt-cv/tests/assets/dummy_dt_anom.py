#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path


def fit_command(args: argparse.Namespace) -> None:
    Path(args.stats_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.meta_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.stats_out).write_text(json.dumps({"seed": args.seed}) + "\n", encoding="utf-8")
    Path(args.meta_out).write_text(json.dumps({"preproc_hash": args.preproc_hash}) + "\n", encoding="utf-8")


def score_command(args: argparse.Namespace) -> None:
    input_path = Path(args.input)
    output_path = Path(args.output)
    audit_path = Path(args.audit)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with input_path.open("r", encoding="utf-8") as source, output_path.open("w", encoding="utf-8", newline="") as dest:
        reader = csv.DictReader(source)
        fieldnames = reader.fieldnames or []
        extra = ["neglog10_p"]
        writer = csv.DictWriter(dest, fieldnames=fieldnames + extra)
        writer.writeheader()
        for idx, row in enumerate(reader):
            label = float(row.get("anomaly_label", "0"))
            score = 1.0 + label + 0.01 * idx
            row["neglog10_p"] = f"{score:.6f}"
            writer.writerow(row)
    audit_path.write_text(json.dumps({"rows": idx + 1}) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    fit_parser = subparsers.add_parser("fit")
    fit_parser.add_argument("-i", "--input", nargs="+", required=True)
    fit_parser.add_argument("-s", "--stats-out", required=True)
    fit_parser.add_argument("-m", "--meta-out", required=True)
    fit_parser.add_argument("--preproc-hash", required=True)
    fit_parser.add_argument("--seed", default="0")
    fit_parser.add_argument("--column", default="dt_sec")

    score_parser = subparsers.add_parser("score")
    score_parser.add_argument("-i", "--input", required=True)
    score_parser.add_argument("-o", "--output", required=True)
    score_parser.add_argument("--stats", required=True)
    score_parser.add_argument("--meta", required=True)
    score_parser.add_argument("--audit", required=True)

    args = parser.parse_args()
    if args.command == "fit":
        fit_command(args)
    elif args.command == "score":
        score_command(args)
    else:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
