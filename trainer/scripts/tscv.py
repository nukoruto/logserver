# -*- coding: utf-8 -*-
"""CLI for rolling-origin time-series cross-validation (splits & inner-CV search)."""

from __future__ import annotations

import argparse
import glob
import sys
from pathlib import Path
from typing import List, Optional, Sequence

import pandas as pd
import yaml

# --- split サブコマンドに必要 ---
from trainer.logserver.cv import RollingSplitConfig, generate_rolling_origin_splits

# --- search サブコマンドに必要（内側CVまで） ---
from trainer.logserver.dataio.processed import load_processed_events
from trainer.logserver.metrics import AggregatorConfig, ObjectiveConfig, SearchDeviceConfig, SearchExecutionConfig
from trainer.logserver.training.search import (
    CVConfig,
    load_random_search_manifest,
    load_search_space,
    load_split_plan,
    run_random_search,
)

# -----------------------------
# 共通：エイリアス解決ユーティリティ
# -----------------------------
_ALIAS_MAP = {
    "user": "uid",
    "users": "uid",
    "session": "session_id",
    "sessions": "session_id",
    "timestamp": "timestamp_utc",
    "time": "timestamp_utc",
}


def _resolve_column(name: str, available: Sequence[str]) -> str:
    if name in available:
        return name
    alias = _ALIAS_MAP.get(name)
    if alias and alias in available:
        return alias
    raise ValueError(f"column '{name}' not found in input data (available: {list(available)})")


def _expand_inputs(patterns: Sequence[str]) -> List[Path]:
    paths: List[Path] = []
    for pattern in patterns:
        expanded = [Path(p) for p in glob.glob(pattern)]
        if expanded:
            paths.extend(expanded)
        else:
            candidate = Path(pattern)
            if candidate.exists():
                paths.append(candidate)
    unique_paths: List[Path] = []
    seen = set()
    for path in paths:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique_paths.append(resolved)
    return unique_paths


def _load_events(paths: Sequence[Path]) -> pd.DataFrame:
    frames = [pd.read_csv(path) for path in paths]
    if not frames:
        raise ValueError("no input files resolved from --in/--input patterns")
    return pd.concat(frames, ignore_index=True)


# -----------------------------
# split サブコマンド実装
# -----------------------------
def _build_split_config(args: argparse.Namespace, columns: Sequence[str]) -> RollingSplitConfig:
    timestamp_col = _resolve_column(args.timestamp_column, columns)
    group_col = _resolve_column(args.group, columns)
    session_col = _resolve_column(args.session_column, columns)
    label_col: Optional[str] = None
    if args.label_column:
        label_col = _resolve_column(args.label_column, columns)

    if isinstance(args.embargo, str) and args.embargo.lower() == "auto":
        embargo_value: Optional[float] = None
    else:
        try:
            embargo_value = float(args.embargo)
        except Exception as exc:
            raise ValueError("embargo must be 'auto' or a numeric value (seconds)") from exc

    seed_value: Optional[int] = args.seed
    return RollingSplitConfig(
        rolling=args.rolling,
        window_l=args.window_l,
        horizon=args.horizon,
        folds=args.folds,
        embargo=embargo_value,
        timestamp_column=timestamp_col,
        group_column=group_col,
        session_column=session_col,
        label_column=label_col,
        seed=seed_value,
    )


def _cmd_split(args: argparse.Namespace) -> int:
    input_patterns = args.input_patterns or []
    if not input_patterns:
        raise ValueError("at least one --in/--input pattern is required")
    paths = _expand_inputs(input_patterns)
    if not paths:
        raise ValueError("no files matched the provided --in/--input patterns")
    paths = sorted(paths)
    events = _load_events(paths)
    config = _build_split_config(args, events.columns)
    result = generate_rolling_origin_splits(events, config, sources=[str(p) for p in paths])

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(result, handle, sort_keys=False, allow_unicode=True)
    return 0


# -----------------------------
# search サブコマンド実装（内側CV）
# -----------------------------
def _resolve_log_path(out_path: Path, log_path: Optional[str]) -> Path:
    if log_path:
        return Path(log_path)
    if out_path.suffix:
        return out_path.with_suffix(f"{out_path.suffix}l")
    return out_path.with_name(out_path.name + ".jsonl")


def _cmd_search(args: argparse.Namespace) -> int:
    split_path = Path(args.splits)
    plan = load_split_plan(split_path)

    dataset = load_processed_events(plan.processed_dir)
    if isinstance(dataset, pd.DataFrame):
        df = dataset
    else:
        df = pd.concat(list(dataset), ignore_index=True) if dataset else pd.DataFrame()

    out_path = Path(args.out)
    log_path = _resolve_log_path(out_path, args.log)

    if args.config:
        exec_cfg, objective_cfg, cv_cfg, device_cfg, search_space = load_random_search_manifest(Path(args.config))
    else:
        if not args.space:
            raise ValueError("--space or --config must be provided for search")
        search_space = load_search_space(Path(args.space))
        aggregator_cfg = AggregatorConfig(
            name=args.aggregator,
            lambda_std=args.lambda_std,
            trim_ratio=args.trim_ratio,
        )
        objective_cfg = ObjectiveConfig(primary=args.metric.upper(), aggregator=aggregator_cfg)
        exec_cfg = SearchExecutionConfig(
            n_trials=args.n_trials,
            base_seed=args.seed,
            parallel=max(args.parallel, 1),
            resume=args.resume,
            dedup=args.dedup,
        )
        device_cfg = SearchDeviceConfig(gpu_mode=args.gpu_mode)
        cv_cfg = CVConfig()

    run_random_search(
        df,
        plan,
        search_space,
        out_path=out_path,
        log_path=log_path,
        execution=exec_cfg,
        objective=objective_cfg,
        cv_cfg=cv_cfg,
        device_cfg=device_cfg,
    )
    return 0


# -----------------------------
#  Parser / Main
# -----------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tscv", description="Time-series cross-validation utilities (splits & inner-CV search)"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # split
    split = subparsers.add_parser("split", help="Generate rolling-origin purged/embargoed splits")
    split.add_argument("--in", dest="input_patterns", action="append", help="Input CSV glob pattern")
    split.add_argument("--input", dest="input_patterns", action="append", help="Alias of --in")
    split.add_argument("--out", required=True, help="Path to write the YAML split manifest")
    split.add_argument("--group", default="uid", help="Group column (default: uid)")
    split.add_argument("--session-column", default="session_id", help="Session column (default: session_id)")
    split.add_argument("--timestamp-column", default="timestamp_utc", help="Timestamp column (default: timestamp_utc)")
    split.add_argument("--label-column", default=None, help="Optional label column for summary stats")
    split.add_argument("--rolling", choices=["expanding", "fixed"], default="expanding", help="Rolling strategy")
    split.add_argument("--window_l", type=int, default=0, help="Training window length (0 = auto for expanding)")
    split.add_argument("--horizon", type=int, default=1, help="Evaluation window size in sessions")
    split.add_argument("--folds", type=int, default=5, help="Number of CV folds")
    split.add_argument("--embargo", default="auto", help="Embargo seconds or 'auto'")
    split.add_argument("--seed", type=int, default=None, help="Seed to record in the manifest")
    split.set_defaults(func=_cmd_split)

    # search
    search = subparsers.add_parser("search", help="Run random search with rolling-origin inner CV")
    search.add_argument("--splits", required=True, help="YAML file describing inner CV folds")
    search.add_argument("--config", help="Optional manifest file describing search/objective/device/space")
    search.add_argument("--space", help="YAML search space definition (ignored when --config provided)")
    search.add_argument("--n_trials", type=int, default=10, help="Number of random trials (ignored by manifest)")
    search.add_argument(
        "--metric",
        choices=["ap", "roc_auc", "f1"],
        default="ap",
        help="Primary metric for model selection (ignored by manifest)",
    )
    search.add_argument("--aggregator", choices=["mean", "mean_minus_std", "worst_case", "trimmed_mean"], default="mean", help="Fold aggregator (ignored by manifest)")
    search.add_argument("--lambda-std", type=float, default=0.0, help="Lambda for mean_minus_std aggregator")
    search.add_argument("--trim-ratio", type=float, default=0.1, help="Trim ratio for trimmed_mean aggregator")
    search.add_argument("--parallel", type=int, default=1, help="Number of trials to evaluate concurrently")
    search.add_argument("--resume", action="store_true", help="Resume from existing log if present")
    search.add_argument("--dedup", action="store_true", help="Skip duplicate parameter samples")
    search.add_argument("--gpu-mode", choices=["auto", "ada6000", "4060"], default="auto", help="GPU selection mode")
    search.add_argument("--out", required=True, help="Path to write best-trial summary JSON")
    search.add_argument("--log", help="Optional path for JSONL trial log")
    search.add_argument("--seed", type=int, default=42, help="Base random seed for reproducibility")
    search.set_defaults(func=_cmd_search)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if hasattr(args, "func"):
            return int(args.func(args))
        parser.print_help()
        return 2
    except Exception as error:  # pragma: no cover - CLI guard
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
