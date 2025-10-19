"""Random search with rolling-origin time series cross-validation."""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
import yaml
from sklearn.metrics import average_precision_score, roc_auc_score

from ..features.encoders import build_feature_pack, encode_dataframe
from ..scoring.anomaly import AnomalyScorer, ScoringConfig
from .trainer import SessionSplit, TrainerConfig, fit_model


@dataclass
class FoldPlan:
    name: str
    train_sessions: List[str]
    validation_sessions: List[str]
    purge: Optional[float] = None
    embargo: Optional[float] = None


@dataclass
class SplitPlan:
    processed_dir: Path
    label_column: str
    timestamp_column: str
    session_column: str
    folds: List[FoldPlan]


def load_split_plan(path: Path) -> SplitPlan:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError("Split specification must be a mapping")

    dataset_cfg = data.get("dataset", {})
    if not isinstance(dataset_cfg, dict):
        raise ValueError("dataset section must be a mapping")
    processed_raw = dataset_cfg.get("processed_dir")
    if not processed_raw:
        raise ValueError("dataset.processed_dir is required")
    processed_dir = (path.parent / Path(processed_raw)).resolve()
    label_column = str(dataset_cfg.get("label_column", "anomaly_label"))
    timestamp_column = str(dataset_cfg.get("timestamp_column", "timestamp_utc"))
    session_column = str(dataset_cfg.get("session_column", "session_id"))

    folds_raw = data.get("folds")
    if not isinstance(folds_raw, list) or not folds_raw:
        raise ValueError("folds must be a non-empty list")

    folds: List[FoldPlan] = []
    for index, item in enumerate(folds_raw):
        if not isinstance(item, dict):
            raise ValueError("Each fold entry must be a mapping")
        name = str(item.get("name") or f"fold_{index}")
        train_sessions = _coerce_session_list(item.get("train_sessions"))
        validation_sessions = _coerce_session_list(item.get("validation_sessions"))
        if not train_sessions:
            raise ValueError(f"Fold '{name}' has no train_sessions")
        if not validation_sessions:
            raise ValueError(f"Fold '{name}' has no validation_sessions")
        purge = _coerce_seconds(item.get("purge"))
        embargo = _coerce_seconds(item.get("embargo"))
        folds.append(
            FoldPlan(
                name=name,
                train_sessions=train_sessions,
                validation_sessions=validation_sessions,
                purge=purge,
                embargo=embargo,
            )
        )

    return SplitPlan(
        processed_dir=processed_dir,
        label_column=label_column,
        timestamp_column=timestamp_column,
        session_column=session_column,
        folds=folds,
    )


def load_search_space(path: Path) -> Dict[str, Dict[str, Dict[str, Any]]]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError("Search space must be a mapping")
    for section in ("trainer", "model", "features"):
        value = data.get(section)
        if value is None:
            data[section] = {}
        elif not isinstance(value, dict):
            raise ValueError(f"Search space section '{section}' must be a mapping")
    return data


def run_random_search(
    df: pd.DataFrame,
    plan: SplitPlan,
    search_space: Dict[str, Dict[str, Dict[str, Any]]],
    *,
    n_trials: int,
    metric: str,
    out_path: Path,
    log_path: Path,
    base_seed: int = 42,
) -> Dict[str, Any]:
    if metric not in {"ap", "roc_auc"}:
        raise ValueError("metric must be either 'ap' or 'roc_auc'")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    df = df.copy()
    if plan.timestamp_column not in df.columns:
        raise ValueError(f"Timestamp column '{plan.timestamp_column}' not found in dataset")
    if plan.session_column not in df.columns:
        raise ValueError(f"Session column '{plan.session_column}' not found in dataset")
    if plan.label_column not in df.columns:
        raise ValueError(f"Label column '{plan.label_column}' not found in dataset")

    df[plan.timestamp_column] = pd.to_datetime(df[plan.timestamp_column], utc=True, errors="coerce")
    df.sort_values(plan.timestamp_column, inplace=True)
    df.reset_index(drop=True, inplace=True)
    df[plan.session_column] = df[plan.session_column].astype(str)

    rng = random.Random(base_seed)
    best_record: Optional[Dict[str, Any]] = None

    with log_path.open("w", encoding="utf-8") as log_handle:
        for trial_idx in range(n_trials):
            params = _sample_parameters(search_space, rng)
            trial_seed = base_seed + trial_idx
            try:
                fold_results: List[Dict[str, Any]] = []
                for fold_idx, fold in enumerate(plan.folds):
                    fold_seed = trial_seed + fold_idx
                    fold_result = _evaluate_fold(
                        df,
                        plan,
                        fold,
                        params,
                        fold_seed,
                    )
                    fold_results.append(fold_result)
                aggregated = _aggregate_metrics(fold_results)
                score = aggregated.get(metric)
                record: Dict[str, Any] = {
                    "trial": trial_idx,
                    "seed": trial_seed,
                    "status": "ok",
                    "params": params,
                    "metrics": aggregated,
                    "folds": fold_results,
                }
            except Exception as exc:  # noqa: BLE001 - surfacing failure context
                record = {
                    "trial": trial_idx,
                    "seed": trial_seed,
                    "status": "error",
                    "params": params,
                    "error": str(exc),
                }
                score = None

            log_handle.write(json.dumps(_sanitize(record), ensure_ascii=False) + "\n")
            log_handle.flush()

            if record["status"] == "ok" and score is not None:
                if best_record is None or score > best_record["best_score"]:
                    best_record = {
                        "best_score": float(score),
                        "record": record,
                    }

    if best_record is None:
        raise RuntimeError("All trials failed; check search space or data configuration")

    summary = {
        "metric": metric,
        "best_score": best_record["best_score"],
        "best_trial": best_record["record"],
        "n_trials": n_trials,
        "seed": base_seed,
    }
    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(_sanitize(summary), handle, ensure_ascii=False, indent=2)
    return summary


def _evaluate_fold(
    df: pd.DataFrame,
    plan: SplitPlan,
    fold: FoldPlan,
    params: Dict[str, Dict[str, Any]],
    seed: int,
) -> Dict[str, Any]:
    session_column = plan.session_column
    timestamp_column = plan.timestamp_column
    label_column = plan.label_column

    train_mask = df[session_column].isin(fold.train_sessions)
    val_mask = df[session_column].isin(fold.validation_sessions)
    train_df = df.loc[train_mask].copy()
    val_df = df.loc[val_mask].copy()
    if train_df.empty:
        raise RuntimeError(f"Fold '{fold.name}' has empty training partition")
    if val_df.empty:
        raise RuntimeError(f"Fold '{fold.name}' has empty validation partition")

    train_df.sort_values(timestamp_column, inplace=True)
    val_df.sort_values(timestamp_column, inplace=True)

    train_df, dropped_rows = _apply_temporal_exclusions(
        train_df,
        val_df,
        timestamp_column=timestamp_column,
        session_column=session_column,
        purge_seconds=fold.purge,
        embargo_seconds=fold.embargo,
    )
    if train_df.empty:
        raise RuntimeError(
            f"Fold '{fold.name}' has empty training partition after purge/embargo exclusion"
        )

    feature_flags = _coerce_feature_flags(params.get("features", {}).get("extra"))
    feature_pack = build_feature_pack(train_df, extra_features=feature_flags)

    encoded_train = encode_dataframe(train_df, feature_pack)
    encoded_val = encode_dataframe(val_df, feature_pack)
    combined_encoded = _concatenate_encoded(encoded_train, encoded_val)

    train_sessions_sequence = train_df[session_column].tolist()
    val_sessions_sequence = val_df[session_column].tolist()
    combined_sessions = train_sessions_sequence + val_sessions_sequence

    unique_train = _unique_order(train_sessions_sequence)
    unique_val = _unique_order(val_sessions_sequence)

    trainer_config = _build_trainer_config(params, seed)
    split = SessionSplit(
        train_ids=unique_train,
        val_ids=unique_val,
        test_ids=[],
        ordered_ids=unique_train + unique_val,
    )
    model, history, _, best_val, best_epoch = fit_model(
        combined_encoded,
        combined_sessions,
        feature_pack,
        trainer_config,
        split,
    )

    smoothing_value = params.get("features", {}).get("smoothing_window")
    if smoothing_value is None:
        smoothing_window = 5
    else:
        smoothing_window = max(int(smoothing_value), 1)
    scorer = AnomalyScorer(
        model,
        feature_pack,
        ScoringConfig(device=trainer_config.device, smoothing_window=smoothing_window),
    )
    scores_map = scorer.score(encoded_val, val_sessions_sequence)
    label_groups = {
        str(session): group[label_column].to_numpy(dtype=float)
        for session, group in val_df.groupby(session_column, sort=False)
    }

    all_scores: List[np.ndarray] = []
    all_labels: List[np.ndarray] = []
    for session_id in _unique_order(val_sessions_sequence):
        scores = scores_map.get(session_id)
        labels = label_groups.get(session_id)
        if scores is None or labels is None:
            continue
        length = min(len(scores), len(labels))
        if length <= 0:
            continue
        all_scores.append(np.asarray(scores[:length], dtype=float))
        all_labels.append(np.asarray(labels[:length], dtype=float))

    if not all_scores:
        raise RuntimeError(f"Fold '{fold.name}' produced no evaluable validation samples")

    y_score = np.concatenate(all_scores)
    y_true = np.concatenate(all_labels)
    mask = np.isfinite(y_score) & np.isfinite(y_true)
    if not mask.any():
        raise RuntimeError(f"Fold '{fold.name}' labels are all NaN")
    y_score = y_score[mask]
    y_true = y_true[mask]
    y_true = np.asarray(y_true, dtype=int)

    if np.any(y_true == 1):
        ap = float(average_precision_score(y_true, y_score))
    else:
        ap = 0.0
    unique_labels = np.unique(y_true)
    roc_auc: Optional[float]
    if unique_labels.size > 1:
        roc_auc = float(roc_auc_score(y_true, y_score))
    else:
        roc_auc = None

    fold_result: Dict[str, Any] = {
        "name": fold.name,
        "metrics": {"ap": ap, "roc_auc": roc_auc},
        "best_val_loss": float(best_val),
        "val_loss_last": float(history["val_loss"][-1]) if history.get("val_loss") else None,
        "best_epoch": int(best_epoch),
        "train_sessions": len(unique_train),
        "validation_sessions": len(unique_val),
        "purge_seconds": fold.purge,
        "embargo_seconds": fold.embargo,
        "dropped_train_events": int(dropped_rows),
    }
    return fold_result


def _aggregate_metrics(folds: Iterable[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    aggregate: Dict[str, Optional[float]] = {}
    for metric in ("ap", "roc_auc"):
        values = [fold["metrics"].get(metric) for fold in folds if fold["metrics"].get(metric) is not None]
        if values:
            aggregate[metric] = float(np.mean(values))
        else:
            aggregate[metric] = None
    return aggregate


def _sample_parameters(space: Dict[str, Dict[str, Dict[str, Any]]], rng: random.Random) -> Dict[str, Dict[str, Any]]:
    sampled: Dict[str, Dict[str, Any]] = {}
    for section in ("trainer", "model", "features"):
        group = space.get(section, {})
        result: Dict[str, Any] = {}
        for key, spec in group.items():
            result[key] = _sample_value(spec, rng)
        sampled[section] = result
    return sampled


def _sample_value(spec: Any, rng: random.Random) -> Any:
    if isinstance(spec, (int, float, str)):
        return spec
    if isinstance(spec, list):
        if not spec:
            raise ValueError("Choice list cannot be empty")
        return _deepcopy_if_needed(rng.choice(spec))
    if not isinstance(spec, dict):
        raise ValueError("Search space entry must be a mapping, list, or scalar")

    spec_type = str(spec.get("type", spec.get("distribution", "choice"))).lower()
    if spec_type == "choice":
        values = spec.get("values")
        if not isinstance(values, list) or not values:
            raise ValueError("choice distribution requires non-empty 'values'")
        return _deepcopy_if_needed(rng.choice(values))
    if spec_type == "uniform":
        low = float(spec["low"])
        high = float(spec["high"])
        return rng.uniform(low, high)
    if spec_type in {"loguniform", "log_uniform"}:
        low = float(spec["low"])
        high = float(spec["high"])
        if low <= 0 or high <= 0:
            raise ValueError("loguniform requires positive bounds")
        return math.exp(rng.uniform(math.log(low), math.log(high)))
    if spec_type in {"int", "randint"}:
        low = int(spec["low"])
        high = int(spec["high"])
        return rng.randint(low, high)
    if spec_type == "quniform":
        low = float(spec["low"])
        high = float(spec["high"])
        q = float(spec.get("q", 1.0))
        raw = rng.uniform(low, high)
        return round(raw / q) * q
    raise ValueError(f"Unsupported distribution type '{spec_type}'")


def _build_trainer_config(params: Dict[str, Dict[str, Any]], seed: int) -> TrainerConfig:
    config_values: Dict[str, Any] = {}
    for section in ("trainer", "model"):
        config_values.update(params.get(section, {}))
    config_values.setdefault("validation_split", 0.0)
    config_values.setdefault("device", "cpu")
    config_values["seed"] = int(seed)

    int_fields = {
        "batch_size",
        "max_epochs",
        "early_stopping_patience",
        "seed",
        "embedding_dim",
        "hidden_size",
        "num_layers",
        "num_workers",
        "prefetch_factor",
    }
    float_fields = {"learning_rate", "validation_split", "dropout"}
    bool_fields = {"pin_memory", "persistent_workers"}

    coerced: Dict[str, Any] = {}
    for key, value in config_values.items():
        if key in int_fields and value is not None:
            coerced[key] = int(value)
        elif key in float_fields and value is not None:
            coerced[key] = float(value)
        elif key in bool_fields and value is not None:
            coerced[key] = bool(value)
        else:
            coerced[key] = value
    return TrainerConfig(**coerced)


def _concatenate_encoded(first: Dict[str, np.ndarray], second: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    combined: Dict[str, np.ndarray] = {}
    for key in set(first) | set(second):
        left = first.get(key)
        right = second.get(key)
        if left is None:
            combined[key] = np.asarray(right)
        elif right is None:
            combined[key] = np.asarray(left)
        else:
            combined[key] = np.concatenate([left, right])
    return combined


def _unique_order(values: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            ordered.append(str(value))
    return ordered


def _coerce_session_list(value: Any) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("Session list must be provided as a list")
    return [str(item) for item in value if item is not None]


def _coerce_seconds(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        total = 0.0
        for key, factor in {
            "seconds": 1.0,
            "minutes": 60.0,
            "hours": 3600.0,
            "days": 86400.0,
        }.items():
            if key in value:
                total += float(value[key]) * factor
        return total if total > 0 else None
    raise ValueError("purge/embargo must be numeric seconds or mapping")


def _coerce_feature_flags(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(item) for item in value]
    raise ValueError("features.extra must be a string or list of strings")


def _apply_temporal_exclusions(
    train_df: pd.DataFrame,
    val_df: pd.DataFrame,
    *,
    timestamp_column: str,
    session_column: str,
    purge_seconds: Optional[float],
    embargo_seconds: Optional[float],
) -> Tuple[pd.DataFrame, int]:
    """Drop training rows that fall within purge/embargo windows around validation."""

    purge_seconds = float(purge_seconds) if purge_seconds else 0.0
    embargo_seconds = float(embargo_seconds) if embargo_seconds else 0.0
    if purge_seconds <= 0 and embargo_seconds <= 0:
        return train_df, 0

    if timestamp_column not in train_df.columns or timestamp_column not in val_df.columns:
        return train_df, 0

    exclusions: List[Tuple[pd.Timestamp, pd.Timestamp]] = []
    for _, group in val_df.groupby(session_column, sort=False):
        timestamps = group[timestamp_column].dropna()
        if timestamps.empty:
            continue
        start = timestamps.min()
        end = timestamps.max()
        window_start = start - pd.Timedelta(seconds=purge_seconds)
        window_end = end + pd.Timedelta(seconds=embargo_seconds)
        exclusions.append((window_start, window_end))

    if not exclusions:
        return train_df, 0

    mask = pd.Series(True, index=train_df.index)
    for start, end in exclusions:
        mask &= ~train_df[timestamp_column].between(start, end, inclusive="both")

    filtered = train_df.loc[mask].copy()
    dropped = int((~mask).sum())
    return filtered, dropped


def _sanitize(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _sanitize(val) for key, val in value.items()}
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, np.ndarray):
        return [_sanitize(item) for item in value.tolist()]
    return value


def _deepcopy_if_needed(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.loads(json.dumps(value))
    return value


__all__ = [
    "FoldPlan",
    "SplitPlan",
    "load_split_plan",
    "load_search_space",
    "run_random_search",
]
