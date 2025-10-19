"""Time-series cross-validation utilities."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Optional

import pandas as pd

from trainer.logserver.dataio.processed import load_processed_events
from trainer.logserver.training.search import (
    load_search_space,
    load_split_plan,
    run_random_search,
)


def _resolve_log_path(out_path: Path, log_path: Optional[str]) -> Path:
    if log_path:
        return Path(log_path)
    if out_path.suffix:
        return out_path.with_suffix(f"{out_path.suffix}l")
    return out_path.with_name(out_path.name + ".jsonl")


def _cmd_search(args: argparse.Namespace) -> None:
    split_path = Path(args.splits)
    plan = load_split_plan(split_path)
    dataset = load_processed_events(plan.processed_dir)
    if isinstance(dataset, pd.DataFrame):
        df = dataset
    else:
        df = pd.concat(list(dataset), ignore_index=True) if dataset else pd.DataFrame()
    search_space = load_search_space(Path(args.space))
    out_path = Path(args.out)
    log_path = _resolve_log_path(out_path, args.log)
    run_random_search(
        df,
        plan,
        search_space,
        n_trials=args.n_trials,
        metric=args.metric,
        out_path=out_path,
        log_path=log_path,
        base_seed=args.seed,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Time-series cross-validation helper CLI")
    subparsers = parser.add_subparsers(dest="command")

    search_parser = subparsers.add_parser("search", help="Run random search with rolling-origin CV")
    search_parser.add_argument("--splits", required=True, help="YAML file describing inner CV folds")
    search_parser.add_argument("--space", required=True, help="YAML search space definition")
    search_parser.add_argument("--n_trials", type=int, default=10, help="Number of random trials")
    search_parser.add_argument(
        "--metric",
        choices=["ap", "roc_auc"],
        default="ap",
        help="Primary metric for model selection",
    )
    search_parser.add_argument("--out", required=True, help="Path to write best trial summary JSON")
    search_parser.add_argument("--log", help="Optional path for JSONL trial log")
    search_parser.add_argument("--seed", type=int, default=42, help="Base random seed for reproducibility")
    search_parser.set_defaults(func=_cmd_search)

    return parser


def main(argv: Optional[list[str]] = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        return
    args.func(args)


if __name__ == "__main__":  # pragma: no cover
    main()
