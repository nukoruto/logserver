"""Rolling-origin split utilities."""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import List, Sequence

import numpy as np
import pandas as pd
import yaml

from .config import (
    FoldDefinition,
    FoldPaths,
    RollingOriginSplitConfig,
    RollingOriginSplitResult,
    ensure_list,
)


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _format_fold_id(index: int) -> str:
    return f"fold_{index:03d}"


def _build_fold_paths(base_dir: Path, has_test: bool) -> FoldPaths:
    raw_dir = base_dir / "raw"
    feat_dir = base_dir / "features"
    preproc_dir = base_dir / "preproc"
    anom_dir = base_dir / "anom"
    lstm_dir = base_dir / "lstm"
    metrics_dir = base_dir / "metrics"
    fisher_dir = base_dir / "fisher"
    return FoldPaths(
        raw_train=raw_dir / "train.csv",
        raw_validation=raw_dir / "validation.csv",
        raw_test=raw_dir / "test.csv" if has_test else None,
        features_train=feat_dir / "train_features.csv",
        features_validation=feat_dir / "validation_features.csv",
        features_test=feat_dir / "test_features.csv" if has_test else None,
        preproc_stats=preproc_dir / "stats.json",
        preproc_meta=preproc_dir / "meta.yaml",
        anomaly_stats=anom_dir / "stats.json",
        anomaly_meta=anom_dir / "meta.json",
        anomaly_scores_validation=anom_dir / "validation_scores.csv",
        anomaly_scores_test=anom_dir / "test_scores.csv" if has_test else None,
        lstm_dir=lstm_dir,
        lstm_validation_scores=lstm_dir / "validation_scores.csv",
        lstm_test_scores=lstm_dir / "test_scores.csv" if has_test else None,
        fisher_validation_scores=fisher_dir / "validation_scores.csv",
        fisher_test_scores=fisher_dir / "test_scores.csv" if has_test else None,
        metrics_validation=metrics_dir / "validation.json",
        metrics_test=metrics_dir / "test.json" if has_test else None,
    )


def _write_csv(df: pd.DataFrame, path: Path) -> None:
    _ensure_parent(path)
    df.to_csv(path, index=False, lineterminator="\n")


def _session_order(
    frame: pd.DataFrame, session_column: str, timestamp_column: str, seed: int
) -> List[str]:
    grouped = (
        frame.groupby(session_column, sort=False)[timestamp_column]
        .min()
        .to_frame("first_ts")
        .reset_index()
    )
    grouped.sort_values("first_ts", inplace=True)
    grouped["rank"] = np.arange(grouped.shape[0])
    tie_groups = grouped.groupby("first_ts")
    rng = random.Random(seed)
    ranks: List[tuple[int, str]] = []
    for _, bucket in tie_groups:
        indices = bucket["rank"].to_list()
        rng.shuffle(indices)
        for idx, session in zip(indices, bucket[session_column].tolist(), strict=True):
            ranks.append((idx, str(session)))
    ranks.sort(key=lambda item: item[0])
    return [session for _, session in ranks]


def _slice_sessions(
    sessions: Sequence[str],
    train_size: int,
    val_size: int,
    test_size: int,
    step_size: int,
    purge_count: int,
    embargo_count: int,
    max_folds: int | None,
) -> List[tuple[List[str], List[str], List[str]]]:
    total = len(sessions)
    folds: List[tuple[List[str], List[str], List[str]]] = []
    fold_index = 0
    while True:
        train_end = train_size + fold_index * step_size
        if train_end > total:
            break
        train_sessions = list(sessions[:train_end])
        if embargo_count > 0:
            train_sessions = train_sessions[:-embargo_count]
        if not train_sessions:
            break
        val_start = train_end + purge_count
        val_end = val_start + val_size
        if val_end > total:
            break
        val_sessions = list(sessions[val_start:val_end])
        if not val_sessions:
            break
        if test_size > 0:
            test_start = val_end
            test_end = test_start + test_size
            if test_end > total:
                break
            test_sessions = list(sessions[test_start:test_end])
        else:
            test_sessions = []
        folds.append((train_sessions, val_sessions, test_sessions))
        fold_index += 1
        if max_folds is not None and fold_index >= max_folds:
            break
    return folds


def generate_splits(config: RollingOriginSplitConfig) -> RollingOriginSplitResult:
    """Generate rolling-origin splits and persist CSV fragments."""

    config.validate()
    df = pd.read_csv(
        config.input_path,
        dtype="string",
        parse_dates=[config.timestamp_column],
    )
    df.sort_values(config.timestamp_column, inplace=True)
    session_ids = _session_order(df, config.session_column, config.timestamp_column, config.seed)
    fold_slices = _slice_sessions(
        session_ids,
        train_size=config.train_size,
        val_size=config.val_size,
        test_size=config.test_size,
        step_size=config.step_size,
        purge_count=config.purge_count,
        embargo_count=config.embargo_count,
        max_folds=config.max_folds,
    )
    if not fold_slices:
        raise ValueError("Unable to construct any folds with the provided configuration")

    base_dir = config.output_dir
    base_dir.mkdir(parents=True, exist_ok=True)

    result = RollingOriginSplitResult(
        version=1,
        seed=config.seed,
        input_path=str(config.input_path),
        session_column=config.session_column,
        timestamp_column=config.timestamp_column,
        label_column=config.label_column,
        params={
            "train_size": config.train_size,
            "val_size": config.val_size,
            "test_size": config.test_size,
            "step_size": config.step_size,
            "purge_count": config.purge_count,
            "embargo_count": config.embargo_count,
            "max_folds": config.max_folds or 0,
        },
    )

    for fold_id, (train_sessions, val_sessions, test_sessions) in enumerate(fold_slices):
        fold_dir = base_dir / _format_fold_id(fold_id)
        paths = _build_fold_paths(fold_dir, has_test=bool(test_sessions))
        train_mask = df[config.session_column].isin(train_sessions)
        val_mask = df[config.session_column].isin(val_sessions)
        train_df = df.loc[train_mask].copy()
        val_df = df.loc[val_mask].copy()
        _write_csv(train_df, paths.raw_train)
        _write_csv(val_df, paths.raw_validation)
        if test_sessions:
            test_mask = df[config.session_column].isin(test_sessions)
            test_df = df.loc[test_mask].copy()
            _write_csv(test_df, paths.raw_test or fold_dir / "raw" / "test.csv")
        manifest = {
            "id": fold_id,
            "sessions": {
                "train": ensure_list(train_sessions),
                "validation": ensure_list(val_sessions),
                "test": ensure_list(test_sessions),
            },
            "purge_count": config.purge_count,
            "embargo_count": config.embargo_count,
        }
        manifest_path = fold_dir / "split_manifest.json"
        _ensure_parent(manifest_path)
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        fold_entry = {
            "id": fold_id,
            "purge_count": config.purge_count,
            "embargo_count": config.embargo_count,
            "sessions": manifest["sessions"],
            "paths": {
                "raw": {
                    "train": str(paths.raw_train.relative_to(base_dir)),
                    "validation": str(paths.raw_validation.relative_to(base_dir)),
                    "test": str(paths.raw_test.relative_to(base_dir)) if paths.raw_test else None,
                },
                "features": {
                    "train": str(paths.features_train.relative_to(base_dir)),
                    "validation": str(paths.features_validation.relative_to(base_dir)),
                    "test": str(paths.features_test.relative_to(base_dir)) if paths.features_test else None,
                },
                "preproc": {
                    "stats": str(paths.preproc_stats.relative_to(base_dir)),
                    "meta": str(paths.preproc_meta.relative_to(base_dir)),
                },
                "anom": {
                    "stats": str(paths.anomaly_stats.relative_to(base_dir)),
                    "meta": str(paths.anomaly_meta.relative_to(base_dir)),
                    "validation_scores": str(paths.anomaly_scores_validation.relative_to(base_dir)),
                    "test_scores": str(paths.anomaly_scores_test.relative_to(base_dir)) if paths.anomaly_scores_test else None,
                },
                "lstm": {
                    "dir": str(paths.lstm_dir.relative_to(base_dir)),
                    "validation_scores": str(paths.lstm_validation_scores.relative_to(base_dir)),
                    "test_scores": str(paths.lstm_test_scores.relative_to(base_dir)) if paths.lstm_test_scores else None,
                },
                "fisher": {
                    "validation_scores": str(paths.fisher_validation_scores.relative_to(base_dir)),
                    "test_scores": str(paths.fisher_test_scores.relative_to(base_dir)) if paths.fisher_test_scores else None,
                },
                "metrics": {
                    "validation": str(paths.metrics_validation.relative_to(base_dir)),
                    "test": str(paths.metrics_test.relative_to(base_dir)) if paths.metrics_test else None,
                },
            },
        }
        result.folds.append(fold_entry)

    splits_path = base_dir / "splits.yaml"
    with splits_path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(result.to_mapping(), handle, sort_keys=True)

    return result


def load_splits(path: Path) -> RollingOriginSplitResult:
    """Load split description from YAML."""

    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Invalid splits file structure")
    params = payload.get("params", {})
    folds = payload.get("folds", [])
    result = RollingOriginSplitResult(
        version=int(payload.get("version", 1)),
        seed=int(payload.get("seed", 0)),
        input_path=str(payload.get("input_path")),
        session_column=str(payload.get("session_column")),
        timestamp_column=str(payload.get("timestamp_column")),
        label_column=payload.get("label_column"),
        params={str(k): int(v) for k, v in params.items()},
        folds=[dict(fold) for fold in folds],
    )
    return result
