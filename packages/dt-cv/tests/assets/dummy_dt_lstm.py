#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def train_command(args: argparse.Namespace) -> None:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    config = {
        "model": {"type": "dummy"},
        "data": {
            "numeric_columns": args.numeric_cols,
            "delta_column": args.delta_col,
            "idle_timeout": 1800.0,
        },
    }
    (out_dir / "config.json").write_text(json.dumps(config) + "\n", encoding="utf-8")
    (out_dir / "model.pt").write_bytes(b"stub")


def infer_command(args: argparse.Namespace) -> None:
    input_path = Path(args.inputs[0])
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with input_path.open("r", encoding="utf-8") as source, out_path.open("w", encoding="utf-8", newline="") as dest:
        reader = csv.DictReader(source)
        fieldnames = reader.fieldnames or []
        extra = ["neglog10_p_lstm"]
        writer = csv.DictWriter(dest, fieldnames=fieldnames + extra)
        writer.writeheader()
        for idx, row in enumerate(reader):
            label = float(row.get("anomaly_label", "0"))
            score = 0.5 + 0.5 * label + 0.02 * idx
            row["neglog10_p_lstm"] = f"{score:.6f}"
            writer.writerow(row)
    if args.audit:
        Path(args.audit).write_text("{}\n", encoding="utf-8")


def calibrate_command(args: argparse.Namespace) -> None:
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "temperature": 1.0,
        "ece": {"before": 0.2, "after": 0.1, "bins": 10},
        "coverage": {
            "selected_k": 3,
            "coverage_rate": 0.8,
            "curve": [],
            "comparison": {},
        },
    }
    out_path.write_text(json.dumps(payload) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    train_parser = subparsers.add_parser("train")
    train_parser.add_argument("--train", nargs="+", required=True)
    train_parser.add_argument("--val", "--dev", dest="val", nargs="+", required=True)
    train_parser.add_argument("--numeric-cols", nargs="+", default=[])
    train_parser.add_argument("--delta-col", default="dt_sec")
    train_parser.add_argument("--out", required=True)
    train_parser.add_argument("--epochs")
    train_parser.add_argument("--bs")
    train_parser.add_argument("--seed")
    train_parser.add_argument("--cfg")

    infer_parser = subparsers.add_parser("infer")
    infer_parser.add_argument("--in", "--test", dest="inputs", nargs="+", required=True)
    infer_parser.add_argument("--ckpt")
    infer_parser.add_argument("--model")
    infer_parser.add_argument("--calib")
    infer_parser.add_argument("--out", required=True)
    infer_parser.add_argument("--audit")
    infer_parser.add_argument("--seed")
    infer_parser.add_argument("--cfg")

    calibrate_parser = subparsers.add_parser("calibrate")
    calibrate_parser.add_argument("--val", "--dev", dest="val", nargs="+", required=True)
    calibrate_parser.add_argument("--ckpt")
    calibrate_parser.add_argument("--model")
    calibrate_parser.add_argument("--out", required=True)
    calibrate_parser.add_argument("--cfg")
    calibrate_parser.add_argument("--seed")

    args = parser.parse_args()
    if args.command == "train":
        train_command(args)
    elif args.command == "calibrate":
        calibrate_command(args)
    elif args.command == "infer":
        infer_command(args)
    else:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
