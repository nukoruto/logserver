# -*- coding: utf-8 -*-
"""CLI for rolling-origin time-series cross validation splits."""

from __future__ import annotations

import argparse
import glob
import sys
from pathlib import Path
from typing import List, Optional, Sequence

import pandas as pd
import yaml

from trainer.logserver.cv import RollingSplitConfig, generate_rolling_origin_splits


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
    raise ValueError(f"column '{name}' not found in input data")


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
    unique_paths = []
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


def _build_config(args: argparse.Namespace, columns: Sequence[str]) -> RollingSplitConfig:
    timestamp_col = _resolve_column(args.timestamp_column, columns)
    group_col = _resolve_column(args.group, columns)
    session_col = _resolve_column(args.session_column, columns)
    label_col: Optional[str] = None
    if args.label_column:
        label_col = _resolve_column(args.label_column, columns)
    embargo_value: Optional[float]
    if args.embargo.lower() == "auto":
        embargo_value = None
    else:
        try:
            embargo_value = float(args.embargo)
        except ValueError as exc:  # pragma: no cover - argparse should prevent this
            raise ValueError("embargo must be 'auto' or a numeric value") from exc
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


def _command_split(args: argparse.Namespace) -> int:
    input_patterns = args.input_patterns or []
    if not input_patterns:
        raise ValueError("at least one --in/--input pattern is required")
    paths = _expand_inputs(input_patterns)
    if not paths:
        raise ValueError("no files matched the provided --in/--input patterns")
    paths = sorted(paths)
    events = _load_events(paths)
    config = _build_config(args, events.columns)
    result = generate_rolling_origin_splits(events, config, sources=[str(path) for path in paths])
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(result, handle, sort_keys=False, allow_unicode=True)
    return 0


def _create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tscv", description="Time-series cross validation utilities")
    subparsers = parser.add_subparsers(dest="command", required=True)

    split = subparsers.add_parser("split", help="Generate rolling-origin purged splits")
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

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _create_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "split":
            return _command_split(args)
        parser.error("unknown command")
    except Exception as error:  # pragma: no cover - CLI guard
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
