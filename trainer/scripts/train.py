# -*- coding: utf-8 -*-
"""CLI for training the Δt-aware LSTM."""

from __future__ import annotations

import json
import logging
from glob import glob
from pathlib import Path
from typing import Iterable, Optional, Sequence

import pandas as pd

import yaml

from trainer.logserver.dataio.processed import load_processed_events
from trainer.logserver.dataio.sessionize import derive_template_id
from trainer.logserver.features.encoders import build_feature_pack, encode_dataframe
from trainer.logserver.split.group_val import SingleSplitConfig, make_single_split_with_group_holdout
from trainer.logserver.split.utils import aggregate_sessions, prepare_events
from trainer.logserver.training.trainer import (
    SessionSplit,
    TrainerConfig,
    create_session_split,
    train_model,
)


def _load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)



def _resolve_timestamp_column(df: pd.DataFrame) -> str:
    if "timestamp_utc" in df.columns:
        return "timestamp_utc"
    if "timestamp" in df.columns:
        return "timestamp"
    raise RuntimeError("Processed dataset must include a timestamp column (timestamp_utc or timestamp)")


def _choose_group_column(df: pd.DataFrame, preferred: Optional[str] = None) -> str:
    candidates = [preferred, "uid", "user_id", "session_owner", "session_id"]
    for candidate in candidates:
        if candidate and candidate in df.columns:
            return candidate
    raise RuntimeError("No suitable group column found for split generation")


def _resolve_group_column(df: pd.DataFrame, group_key: str) -> str:
    key = group_key.lower()
    if key == "user_id":
        return _choose_group_column(df, "uid")
    if key == "session_id":
        return _choose_group_column(df, "session_id")
    if key == "none":
        return _choose_group_column(df, None)
    return _choose_group_column(df, group_key)


def _normalize_features(features: Sequence[str] | None) -> Sequence[str]:
    return [feature.lower() for feature in (features or []) if feature]


def _ensure_template_column(df: pd.DataFrame) -> pd.DataFrame:
    if "template_id" in df.columns:
        return df
    required = {"method", "path", "op_category"}
    if not required.issubset(df.columns):
        return df
    frame = df.copy()
    frame["template_id"] = [
        derive_template_id(method, path, category)
        for method, path, category in zip(frame["method"], frame["path"], frame["op_category"])
    ]
    return frame


def _merge_feature_sources(
    df: pd.DataFrame,
    *,
    patterns: Iterable[str],
    join_keys: Sequence[str],
) -> pd.DataFrame:
    logger = logging.getLogger(__name__)
    merged = df.copy()
    for pattern in patterns:
        matches = sorted(glob(pattern))
        if not matches:
            logger.info(json.dumps({"event": "feature_merge", "pattern": pattern, "status": "no_match"}, ensure_ascii=False))
            continue
        for path in matches:
            features_df = pd.read_csv(path)
            features_df = _ensure_template_column(features_df)
            keys = [key for key in join_keys if key in merged.columns and key in features_df.columns]
            if not keys:
                raise RuntimeError(f"No common join keys found between processed data and {path}")
            candidate_columns = [col for col in features_df.columns if col not in keys and col not in merged.columns]
            if not candidate_columns:
                logger.info(
                    json.dumps(
                        {
                            "event": "feature_merge",
                            "path": path,
                            "status": "skipped",
                            "reason": "no_new_columns",
                        },
                        ensure_ascii=False,
                    )
                )
                continue
            subset = features_df[keys + candidate_columns].drop_duplicates(subset=keys)
            before_cols = set(merged.columns)
            merged = merged.merge(subset, on=keys, how="left")
            added_columns = sorted(set(merged.columns) - before_cols)
            logger.info(
                json.dumps(
                    {
                        "event": "feature_merge",
                        "path": path,
                        "status": "merged",
                        "join_keys": keys,
                        "added_columns": added_columns,
                    },
                    ensure_ascii=False,
                )
            )
    return merged


def _select_training_rows(df: pd.DataFrame, split: SessionSplit) -> pd.DataFrame:
    if not split.train_ids:
        return df.copy()
    mask = df["session_id"].astype(str).isin(set(split.train_ids))
    subset = df.loc[mask].copy()
    if subset.empty:
        raise RuntimeError("Training split is empty after applying session mask")
    return subset


def _log_feature_usage(feature_pack, requested: Sequence[str]) -> None:
    logger = logging.getLogger(__name__)
    dt_keys = {"z", "z_deseas", "lburst", "m25", "m50", "m75"}
    using_dt = [name for name in feature_pack.numeric_features if name in dt_keys]
    requested_set = {name.lower() for name in requested}
    if "dt" in requested_set:
        payload = {
            "event": "feature_selection",
            "mode": "dt",
            "using_features": using_dt,
        }
        if not using_dt:
            payload["fallback"] = "basic"
        logger.info(json.dumps(payload, ensure_ascii=False))


def main(
    config_path: Path,
    features: Sequence[str] | None = None,
    target_mode_override: Optional[str] = None,
) -> None:
    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    model_cfg = config.get("model", {})
    train_cfg = config.get("training", {})
    logging_cfg = config.get("logging", {})

    log_level = logging_cfg.get("level", "INFO")
    logging.basicConfig(level=getattr(logging, str(log_level).upper(), logging.INFO))

    processed_dir = Path(data_cfg.get("processed_dir", "data/processed"))
    df = load_processed_events(processed_dir)
    feature_cfg = data_cfg.get("feature_merge") or {}
    merge_patterns = [str(pattern) for pattern in feature_cfg.get("patterns", []) if str(pattern)]
    merge_keys = feature_cfg.get(
        "join_keys",
        ["uid", "session_id", "timestamp_utc", "template_id"],
    )
    if merge_patterns:
        df = _ensure_template_column(df)
        df = _merge_feature_sources(df, patterns=merge_patterns, join_keys=[str(key) for key in merge_keys])
    session_ids = df["session_id"].astype(str).tolist()
    timestamp_column = _resolve_timestamp_column(df)
    session_timestamps = df[timestamp_column].tolist()

    target_mode_cfg = str(train_cfg.get("target_mode", "next")).lower()
    selected_mode = target_mode_override or target_mode_cfg
    if selected_mode not in {"next", "same"}:
        raise ValueError("target_mode must be either 'next' or 'same'")

    trainer_config = TrainerConfig(
        batch_size=int(train_cfg.get("batch_size", 64)),
        max_epochs=int(train_cfg.get("max_epochs", 20)),
        learning_rate=float(train_cfg.get("learning_rate", 1e-3)),
        validation_split=float(train_cfg.get("validation_split", 0.1)),
        early_stopping_patience=int(train_cfg.get("early_stopping_patience", 3)),
        seed=int(train_cfg.get("seed", 42)),
        embedding_dim=int(model_cfg.get("embedding_dim", 64)),
        hidden_size=int(model_cfg.get("hidden_size", 64)),
        num_layers=int(model_cfg.get("num_layers", 1)),
        dropout=float(model_cfg.get("dropout", 0.1)),
        device=train_cfg.get("device", "cpu"),
        target_mode=selected_mode,
    )

    output_dir = Path(logging_cfg.get("dir", "runs"))
    output_dir.mkdir(parents=True, exist_ok=True)
    feature_flags = _normalize_features(features)
    split_cfg = config.get("split", {})
    split_mode = str(split_cfg.get("mode", "legacy")).lower()
    group_key = str(split_cfg.get("group_key", "none")).lower()
    val_fraction = float(split_cfg.get("val_fraction", trainer_config.validation_split))
    embargo_spec = split_cfg.get("embargo_seconds", "auto")
    split_seed = int(split_cfg.get("seed", trainer_config.seed))

    if split_mode == "single":
        group_column = _resolve_group_column(df, group_key)
        events_prepared = prepare_events(df, timestamp_column)
        sessions_table, delta_seconds, _ = aggregate_sessions(
            events_prepared,
            timestamp_column=timestamp_column,
            group_column=group_column,
            session_column="session_id",
            label_column=None,
        )
        single_config = SingleSplitConfig(
            timestamp_column=timestamp_column,
            session_column="session_id",
            group_column=group_column,
            group_key=group_key,
            label_column=None,
            val_fraction=val_fraction,
            embargo=embargo_spec,
            seed=split_seed,
        )
        single_result = make_single_split_with_group_holdout(
            sessions_table,
            df,
            config=single_config,
            delta_seconds=delta_seconds,
        )
        train_ids, val_ids, ordered_ids = single_result.to_session_ids()
        split = SessionSplit(train_ids=train_ids, val_ids=val_ids, test_ids=[], ordered_ids=ordered_ids)
        manifest_path = output_dir / "splits.yaml"
        with manifest_path.open("w", encoding="utf-8") as handle:
            yaml.safe_dump(single_result.manifest, handle, sort_keys=False, allow_unicode=True)
    elif split_mode in {"legacy", ""}:
        split = create_session_split(session_ids, session_timestamps, trainer_config)
    elif split_mode == "tscv":
        raise NotImplementedError("split.mode=tscv is not supported in train CLI; use trainer/scripts/tscv.py")
    else:
        raise ValueError(f"Unsupported split.mode '{split_mode}'")

    training_df = _select_training_rows(df, split)
    feature_pack = build_feature_pack(training_df, extra_features=feature_flags)
    _log_feature_usage(feature_pack, feature_flags)
    encoded = encode_dataframe(df, feature_pack)
    train_model(encoded, session_ids, feature_pack, output_dir, trainer_config, split=split)


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Train Δt-aware LSTM model")
    parser.add_argument(
        "--config",
        default="trainer/configs/default.yaml",
        help="Path to YAML configuration",
    )
    parser.add_argument(
        "--features",
        default="",
        help="Comma separated feature switches (e.g. dt)",
    )
    parser.add_argument(
        "--target-mode",
        choices=["next", "same"],
        default=None,
        help="Target alignment mode: next-event prediction (default) or same-timestep",
    )
    args = parser.parse_args()
    feature_list = [item.strip() for item in args.features.split(",") if item.strip()]
    main(Path(args.config), feature_list, args.target_mode)
