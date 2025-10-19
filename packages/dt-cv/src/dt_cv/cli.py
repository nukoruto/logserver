"""Command-line interface for dt-cv."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Sequence

from .config import RollingOriginSplitConfig
from .splitter import generate_splits
from .summary import summarize_folds
from .workflow import run_eval, run_report, run_train

_LOGGER = logging.getLogger("dt_cv.cli")


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(message)s")


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="tscv", description="Deterministic rolling-origin CV orchestrator")
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging")
    subparsers = parser.add_subparsers(dest="command", required=True)

    split_parser = subparsers.add_parser("split", help="Generate rolling-origin splits")
    split_parser.add_argument("--input", required=True, help="Input CSV containing sessions")
    split_parser.add_argument("--output", required=True, help="Output directory for folds")
    split_parser.add_argument("--session-col", default="session_id", help="Session identifier column")
    split_parser.add_argument("--timestamp-col", default="timestamp_utc", help="Timestamp column (ISO8601)")
    split_parser.add_argument("--label-col", default="anomaly_label", help="Label column for evaluation")
    split_parser.add_argument("--train-size", type=int, required=True, help="Number of sessions for initial train window")
    split_parser.add_argument("--val-size", type=int, required=True, help="Number of sessions for validation window")
    split_parser.add_argument("--test-size", type=int, default=0, help="Number of sessions for test window")
    split_parser.add_argument("--step-size", type=int, required=True, help="Sessions to expand train window each fold")
    split_parser.add_argument("--purge", type=int, default=0, help="Sessions to drop between train and validation")
    split_parser.add_argument("--embargo", type=int, default=0, help="Sessions removed from tail of training window")
    split_parser.add_argument("--max-folds", type=int, default=None, help="Maximum number of folds to generate")
    split_parser.add_argument("--seed", type=int, default=42, help="Random seed for tie-breaking")

    train_parser = subparsers.add_parser("train", help="Run preprocessing, dt-anom fit, and dt-lstm train per fold")
    train_parser.add_argument("--splits", required=True, help="Path to splits.yaml")
    train_parser.add_argument("--dt-preproc", default="dt-preproc", help="dt-preproc CLI binary")
    train_parser.add_argument("--dt-anom", default="dt-anom", help="dt-anom CLI binary")
    train_parser.add_argument("--dt-lstm", default="dt-lstm", help="dt-lstm CLI binary")
    train_parser.add_argument("--seed", type=int, default=42, help="Seed override")
    train_parser.add_argument("--gpu-mode", choices=["ada6000", "4060", "cpu"], default="ada6000", help="GPU mode")

    eval_parser = subparsers.add_parser("eval", help="Score validation/test folds and compute metrics")
    eval_parser.add_argument("--splits", help="Path to splits.yaml for scoring")
    eval_parser.add_argument("--dt-anom", default="dt-anom", help="dt-anom CLI binary")
    eval_parser.add_argument("--dt-lstm", default="dt-lstm", help="dt-lstm CLI binary")
    eval_parser.add_argument("--seed", type=int, default=42, help="Seed override")
    eval_parser.add_argument("--gpu-mode", choices=["ada6000", "4060", "cpu"], default="ada6000", help="GPU mode")
    eval_parser.add_argument("--fold-artifacts", help="Directory containing fold_* artifacts for summary aggregation")
    eval_parser.add_argument(
        "--bootstrap",
        choices=["none", "stationary"],
        default="none",
        help="Bootstrap method for confidence intervals",
    )
    eval_parser.add_argument("--block-mean", type=int, default=None, help="Stationary bootstrap average block length")
    eval_parser.add_argument(
        "--bootstrap-samples",
        type=int,
        default=0,
        help="Number of bootstrap replicates for confidence intervals",
    )
    eval_parser.add_argument("--out", help="Output directory for aggregated summary metrics")

    report_parser = subparsers.add_parser("report", help="Aggregate fold metrics")
    report_parser.add_argument("--splits", required=True, help="Path to splits.yaml")

    run_all = subparsers.add_parser("run-all", help="Train, evaluate, and report sequentially")
    run_all.add_argument("--splits", required=True, help="Path to splits.yaml")
    run_all.add_argument("--dt-preproc", default="dt-preproc", help="dt-preproc CLI binary")
    run_all.add_argument("--dt-anom", default="dt-anom", help="dt-anom CLI binary")
    run_all.add_argument("--dt-lstm", default="dt-lstm", help="dt-lstm CLI binary")
    run_all.add_argument("--seed", type=int, default=42, help="Seed override")
    run_all.add_argument("--gpu-mode", choices=["ada6000", "4060", "cpu"], default="ada6000", help="GPU mode")

    return parser.parse_args(argv)


def _normalize_gpu_mode(mode: str | None) -> str | None:
    if mode in (None, "cpu"):
        return None
    return mode


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    _configure_logging(args.verbose)

    if args.command == "split":
        config = RollingOriginSplitConfig(
            input_path=Path(args.input).expanduser().resolve(),
            output_dir=Path(args.output).expanduser().resolve(),
            session_column=args.session_col,
            timestamp_column=args.timestamp_col,
            label_column=args.label_col,
            train_size=args.train_size,
            val_size=args.val_size,
            test_size=args.test_size,
            step_size=args.step_size,
            purge_count=args.purge,
            embargo_count=args.embargo,
            max_folds=args.max_folds,
            seed=args.seed,
        )
        generate_splits(config)
        _LOGGER.info("split.completed", extra={"output": str(config.output_dir / "splits.yaml")})
        return 0

    if args.command == "train":
        run_train(
            Path(args.splits).expanduser().resolve(),
            dt_preproc_bin=args.dt_preproc,
            dt_anom_bin=args.dt_anom,
            dt_lstm_bin=args.dt_lstm,
            seed=args.seed,
            gpu_mode=_normalize_gpu_mode(args.gpu_mode),
        )
        _LOGGER.info("train.completed")
        return 0

    if args.command == "eval":
        summary_path: Path | None = None
        if args.splits:
            run_eval(
                Path(args.splits).expanduser().resolve(),
                dt_anom_bin=args.dt_anom,
                dt_lstm_bin=args.dt_lstm,
                seed=args.seed,
                gpu_mode=_normalize_gpu_mode(args.gpu_mode),
            )
        needs_summary = any(
            [
                args.fold_artifacts,
                args.out,
                args.bootstrap != "none",
                args.bootstrap_samples > 0,
            ]
        )
        if needs_summary:
            base_dir = None
            if args.fold_artifacts:
                base_dir = Path(args.fold_artifacts).expanduser().resolve()
            elif args.splits:
                base_dir = Path(args.splits).expanduser().resolve().parent
            if base_dir is None:
                raise ValueError("Summary aggregation requires --fold-artifacts or --splits")
            out_dir = Path(args.out).expanduser().resolve() if args.out else base_dir / "summary"
            summary_path = summarize_folds(
                base_dir,
                out_dir=out_dir,
                bootstrap=args.bootstrap,
                block_mean=args.block_mean,
                bootstrap_samples=args.bootstrap_samples,
                seed=args.seed,
            )
            _LOGGER.info("eval.summary", extra={"summary": str(summary_path)})
        _LOGGER.info("eval.completed")
        return 0

    if args.command == "report":
        report_path = run_report(Path(args.splits).expanduser().resolve())
        _LOGGER.info("report.completed", extra={"report": str(report_path)})
        return 0

    if args.command == "run-all":
        splits_path = Path(args.splits).expanduser().resolve()
        gpu_mode = _normalize_gpu_mode(args.gpu_mode)
        run_train(
            splits_path,
            dt_preproc_bin=args.dt_preproc,
            dt_anom_bin=args.dt_anom,
            dt_lstm_bin=args.dt_lstm,
            seed=args.seed,
            gpu_mode=gpu_mode,
        )
        run_eval(
            splits_path,
            dt_anom_bin=args.dt_anom,
            dt_lstm_bin=args.dt_lstm,
            seed=args.seed,
            gpu_mode=gpu_mode,
        )
        report_path = run_report(splits_path)
        _LOGGER.info("run_all.completed", extra={"report": str(report_path)})
        return 0

    _LOGGER.error("unknown.command", extra={"command": args.command})
    return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
