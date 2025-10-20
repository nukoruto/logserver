"""Command-line interface for dt-cv."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Sequence

import pandas as pd

from .config import RollingOriginSplitConfig
from .reporting import build_report_package
from .settings import load_run_all_settings
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

    report_parser = subparsers.add_parser("report", help="Aggregate fold metrics and package artifacts")
    report_parser.add_argument("--splits", help="Path to splits.yaml")
    report_parser.add_argument("--summary", help="Directory containing metrics_summary.json")
    report_parser.add_argument("--fold-artifacts", help="Directory containing fold_* artifacts")
    report_parser.add_argument("--out", required=True, help="Output directory for packaged report")
    report_parser.add_argument(
        "--subsets",
        nargs="+",
        default=["validation", "test"],
        help="Evaluation subsets to include (default: validation test)",
    )

    run_all = subparsers.add_parser("run-all", help="Train, evaluate, and report sequentially")
    run_all.add_argument("--in", dest="inputs", nargs="+", required=True, help="Input CSV files (shell-expanded)")
    run_all.add_argument("--cfg", required=True, help="Run-all configuration YAML")
    run_all.add_argument("--out", required=True, help="Output directory for fold artifacts")
    run_all.add_argument("--report", required=True, help="Directory where the packaged report will be written")
    run_all.add_argument("--seed", type=int, default=42, help="Seed override")
    run_all.add_argument("--gpu-mode", choices=["ada6000", "4060", "cpu"], default="ada6000", help="GPU mode")
    run_all.add_argument("--resume", action="store_true", help="Resume incomplete workflow steps")

    fuse_parser = subparsers.add_parser("fuse", help="Fuse dt-anom and dt-lstm scores in probability space")
    fuse_parser.add_argument("--anom", required=True, help="Path to dt-anom scores CSV")
    fuse_parser.add_argument("--lstm", required=True, help="Path to dt-lstm scores CSV")
    fuse_parser.add_argument(
        "--method",
        choices=["fisher"],
        default="fisher",
        help="Fusion strategy in probability space",
    )
    fuse_parser.add_argument(
        "--weights",
        nargs=2,
        type=float,
        metavar=("W_ANOM", "W_LSTM"),
        help="Optional non-negative weights for Fisher combination",
    )
    fuse_parser.add_argument(
        "--dev-calib",
        required=True,
        help="Calibration JSON path (created on dev, reused on test)",
    )
    fuse_parser.add_argument("--out", required=True, help="Output CSV for fused scores")
    fuse_parser.add_argument(
        "--label-col",
        default="anomaly_label",
        help="Label column used for calibration metrics (dev only)",
    )
    fuse_parser.add_argument(
        "--objective",
        choices=["f1", "budget"],
        default="f1",
        help="Calibration objective: maximize F1 or satisfy alarm budget",
    )
    fuse_parser.add_argument(
        "--budget",
        type=float,
        default=None,
        help="Alarm budget (fraction of events) when objective=budget",
    )

    return parser.parse_args(argv)


def _normalize_gpu_mode(mode: str | None) -> str | None:
    if mode in (None, "cpu"):
        return None
    return mode


def _materialize_inputs(inputs: Sequence[str]) -> list[Path]:
    paths = []
    for value in inputs:
        path = Path(value).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Input dataset not found: {path}")
        paths.append(path)
    return sorted(paths)


def _combine_datasets(sources: Sequence[Path], dest: Path, *, resume: bool) -> Path:
    if resume and dest.exists():
        return dest
    frames = []
    for source in sources:
        frame = pd.read_csv(source, dtype="string")
        frames.append(frame)
    if not frames:
        raise ValueError("No input datasets provided")
    combined = pd.concat(frames, ignore_index=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    combined.to_csv(dest, index=False, lineterminator="\n")
    return dest


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
        splits_path = Path(args.splits).expanduser().resolve() if args.splits else None
        summary_dir = Path(args.summary).expanduser().resolve() if args.summary else None
        fold_root: Path | None = None
        if args.fold_artifacts:
            fold_root = Path(args.fold_artifacts).expanduser().resolve()
        elif splits_path is not None:
            fold_root = splits_path.parent
        elif summary_dir is not None:
            fold_root = summary_dir.parent
        if fold_root is None:
            raise ValueError("Report requires --fold-artifacts, --summary, or --splits")
        cv_report_path: Path | None = None
        if splits_path is not None:
            cv_report_path = run_report(splits_path, subsets=args.subsets)
        else:
            candidate = fold_root / "cv_report.json"
            if candidate.exists():
                cv_report_path = candidate
        out_dir = Path(args.out).expanduser().resolve()
        summary_dir = summary_dir or (fold_root / "summary")
        results_path = build_report_package(
            fold_root=fold_root,
            out_dir=out_dir,
            subsets=tuple(args.subsets),
            summary_dir=summary_dir,
            splits_path=splits_path,
            cv_report_path=cv_report_path,
        )
        _LOGGER.info("report.completed", extra={"report": str(results_path)})
        return 0

    if args.command == "run-all":
        input_paths = _materialize_inputs(args.inputs)
        cfg_path = Path(args.cfg).expanduser().resolve()
        out_dir = Path(args.out).expanduser().resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        report_dir = Path(args.report).expanduser().resolve()
        report_dir.mkdir(parents=True, exist_ok=True)
        settings = load_run_all_settings(cfg_path)
        dataset_path = _combine_datasets(input_paths, out_dir / "dataset.csv", resume=args.resume)
        splits_path = out_dir / "splits.yaml"
        if not args.resume or not splits_path.exists():
            split_config = settings.build_split_config(dataset_path, out_dir, args.seed)
            generate_splits(split_config)
        gpu_mode = _normalize_gpu_mode(args.gpu_mode)
        run_train(
            splits_path,
            dt_preproc_bin=settings.dt_preproc_bin,
            dt_anom_bin=settings.dt_anom_bin,
            dt_lstm_bin=settings.dt_lstm_bin,
            seed=args.seed,
            gpu_mode=gpu_mode,
            resume=args.resume,
            lstm_cfg=settings.lstm_cfg,
        )
        run_eval(
            splits_path,
            dt_anom_bin=settings.dt_anom_bin,
            dt_lstm_bin=settings.dt_lstm_bin,
            seed=args.seed,
            gpu_mode=gpu_mode,
            resume=args.resume,
            bins=settings.fisher_bins,
            lstm_cfg=settings.lstm_cfg,
        )
        summary_dir = out_dir / "summary"
        summary_ready = (summary_dir / "metrics_summary.json").exists()
        if not args.resume or not summary_ready:
            summarize_folds(
                out_dir,
                out_dir=summary_dir,
                bootstrap="none",
                block_mean=None,
                bootstrap_samples=0,
                seed=args.seed,
            )
        cv_report_path = run_report(splits_path, subsets=settings.subsets)
        results_path = build_report_package(
            fold_root=out_dir,
            out_dir=report_dir,
            subsets=settings.subsets,
            summary_dir=summary_dir,
            splits_path=splits_path,
            cv_report_path=cv_report_path,
        )
        _LOGGER.info("run_all.completed", extra={"report": str(results_path)})
        return 0

    if args.command == "fuse":
        from .fusion import fuse_scores

        fuse_scores(
            anom_path=Path(args.anom).expanduser().resolve(),
            lstm_path=Path(args.lstm).expanduser().resolve(),
            out_path=Path(args.out).expanduser().resolve(),
            calib_path=Path(args.dev_calib).expanduser().resolve(),
            method=args.method,
            weights=None if args.weights is None else (float(args.weights[0]), float(args.weights[1])),
            label_column=args.label_col,
            objective=args.objective,
            budget=args.budget,
        )
        _LOGGER.info("fuse.completed", extra={"out": str(Path(args.out).expanduser().resolve())})
        return 0

    _LOGGER.error("unknown.command", extra={"command": args.command})
    return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
