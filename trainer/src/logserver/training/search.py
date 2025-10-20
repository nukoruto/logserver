"""Advanced random search with deterministic rolling-origin cross-validation."""

from __future__ import annotations

import concurrent.futures
import json
import math
import os
import random
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import yaml

from ..features.encoders import build_feature_pack, encode_dataframe
from ..metrics import (
    AggregatorConfig,
    FoldMetric,
    ObjectiveConfig,
    SearchDeviceConfig,
    SearchExecutionConfig,
    TrialStatus,
    deterministic_hash,
    safe_average_precision,
    safe_f1_at_best_threshold,
    safe_roc_auc,
    summarise_metrics,
)
from ..scoring.anomaly import AnomalyScorer, ScoringConfig
from .trainer import SessionSplit, TrainerConfig, fit_model, _set_seed


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


@dataclass
class CVConfig:
    use_rolling_origin: bool = True
    require_group_disjoint: bool = True


@dataclass
class TrialResult:
    trial_id: int
    trial_seed: int
    params: Dict[str, Any]
    fold_metrics: List[Dict[str, Any]]
    aggregated: Dict[str, Any]
    objective_value: Optional[float]
    status: str
    message: Optional[str]
    valid_mask: Dict[str, List[bool]]
    device: Dict[str, Any]


_GPU_MAPPING = {
    "ada6000": os.environ.get("CUDA_DEVICE_ADA6000", "0"),
    "4060": os.environ.get("CUDA_DEVICE_4060", "1"),
}


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


def load_search_space(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError("Search space must be a mapping")
    if "space" in data:
        space = data["space"]
        if not isinstance(space, dict):
            raise ValueError("space section must be a mapping")
        return space
    for section in ("trainer", "model", "features"):
        value = data.get(section)
        if value is None:
            data[section] = {}
        elif not isinstance(value, dict):
            raise ValueError(f"Search space section '{section}' must be a mapping")
    return data


def load_random_search_manifest(path: Path) -> Tuple[
    SearchExecutionConfig,
    ObjectiveConfig,
    CVConfig,
    SearchDeviceConfig,
    Dict[str, Any],
]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError("Random search manifest must be a mapping")

    search_cfg = data.get("search", {})
    if not isinstance(search_cfg, dict):
        raise ValueError("search section must be a mapping")
    execution = SearchExecutionConfig(
        n_trials=int(search_cfg.get("n_trials", 10)),
        base_seed=int(search_cfg.get("base_seed", 42)),
        parallel=max(int(search_cfg.get("parallel", 1)), 1),
        resume=bool(search_cfg.get("resume", False)),
        dedup=bool(search_cfg.get("dedup", False)),
    )

    aggregator_cfg = AggregatorConfig(
        name=str(
            data.get("objective", {})
            .get("aggregator", {})
            .get("name", "mean")
        ),
        lambda_std=float(
            data.get("objective", {})
            .get("aggregator", {})
            .get("lambda_std", 0.0)
        ),
        trim_ratio=float(
            data.get("objective", {})
            .get("aggregator", {})
            .get("trim_ratio", 0.1)
        ),
    )
    objective = ObjectiveConfig(
        primary=str(data.get("objective", {}).get("primary", "AP")),
        aggregator=aggregator_cfg,
        f1_selection=data.get("objective", {}).get("f1_selection", {}),
    )

    cv_section = data.get("cv", {})
    if not isinstance(cv_section, dict):
        raise ValueError("cv section must be a mapping")
    cv_cfg = CVConfig(
        use_rolling_origin=bool(cv_section.get("use_rolling_origin", True)),
        require_group_disjoint=bool(cv_section.get("require_group_disjoint", True)),
    )

    device_section = data.get("device", {})
    if not isinstance(device_section, dict):
        raise ValueError("device section must be a mapping")
    device_cfg = SearchDeviceConfig(gpu_mode=str(device_section.get("gpu_mode", "auto")))

    space = data.get("space")
    if not isinstance(space, dict):
        raise ValueError("space section is required in manifest")
    return execution, objective, cv_cfg, device_cfg, space


def run_random_search(
    df: pd.DataFrame,
    plan: SplitPlan,
    search_space: Dict[str, Any],
    *,
    n_trials: Optional[int] = None,
    metric: Optional[str] = None,
    out_path: Path,
    log_path: Path,
    base_seed: Optional[int] = None,
    execution: Optional[SearchExecutionConfig] = None,
    objective: Optional[ObjectiveConfig] = None,
    cv_cfg: Optional[CVConfig] = None,
    device_cfg: Optional[SearchDeviceConfig] = None,
) -> Dict[str, Any]:
    df = _prepare_dataframe(df, plan)

    if execution is None:
        total_trials = int(n_trials) if n_trials is not None else 10
        seed = int(base_seed) if base_seed is not None else 42
        execution = SearchExecutionConfig(n_trials=total_trials, base_seed=seed)
    if objective is None:
        primary = (metric or "AP").upper()
        objective = ObjectiveConfig(primary=primary, aggregator=AggregatorConfig())
    if cv_cfg is None:
        cv_cfg = CVConfig()
    if device_cfg is None:
        device_cfg = SearchDeviceConfig()

    _apply_device_mode(device_cfg.gpu_mode)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    dataset_hash = _compute_dataframe_hash(df)
    cv_hash = _compute_cv_hash(plan)
    git_commit = _detect_git_commit()

    if execution.resume:
        existing_records = _load_existing_log(log_path)
    else:
        existing_records = {}
        if log_path.exists():
            log_path.unlink()
    seen_params = {rec["param_key"] for rec in existing_records.values()}
    completed_trials = set(existing_records.keys())

    next_to_log = 0
    while next_to_log in completed_trials:
        next_to_log += 1

    log_mode = "a" if execution.resume and log_path.exists() else "w"
    log_handle = log_path.open(log_mode, encoding="utf-8")

    def _write_record(record: Dict[str, Any]) -> None:
        log_handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        log_handle.flush()

    inflight: Dict[int, concurrent.futures.Future[TrialResult]] = {}
    logged_trials: set[int] = set()
    device_snapshot = _resolve_device_snapshot()

    stop_flag = False

    def _signal_handler(signum: int, frame: Optional[Any]) -> None:  # pragma: no cover - signal path
        nonlocal stop_flag
        stop_flag = True

    previous_handler = signal.signal(signal.SIGINT, _signal_handler)

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=execution.parallel) as executor:
            for trial_idx in range(execution.n_trials):
                if stop_flag:
                    break
                if trial_idx in completed_trials:
                    continue
                trial_seed = execution.base_seed + trial_idx
                params = _sample_parameters_for_trial(search_space, trial_seed)
                param_key = json.dumps(params, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                if execution.dedup and param_key in seen_params:
                    result = TrialResult(
                        trial_id=trial_idx,
                        trial_seed=trial_seed,
                        params=params,
                        fold_metrics=[],
                        aggregated={},
                        objective_value=None,
                        status=TrialStatus.SKIPPED,
                        message="duplicate parameters",  # noqa: EM101
                        valid_mask={},
                        device=device_snapshot,
                    )
                    record = _trial_result_to_dict(
                        result,
                        dataset_hash,
                        cv_hash,
                        git_commit,
                        device_cfg,
                        execution,
                        objective,
                        plan,
                    )
                    _write_record(record)
                    logged_trials.add(trial_idx)
                    seen_params.add(param_key)
                    while next_to_log in completed_trials or next_to_log in logged_trials:
                        next_to_log += 1
                    continue
                seen_params.add(param_key)
                future = executor.submit(
                    _evaluate_trial_safe,
                    df,
                    plan,
                    params,
                    trial_idx,
                    trial_seed,
                    objective,
                )
                inflight[trial_idx] = future
                while inflight and (len(inflight) >= execution.parallel or stop_flag):
                    if next_to_log in inflight:
                        target_idx = next_to_log
                    else:
                        target_idx = min(inflight)
                    future_to_consume = inflight.pop(target_idx)
                    result = future_to_consume.result()
                    result.device = device_snapshot
                    record = _trial_result_to_dict(
                        result,
                        dataset_hash,
                        cv_hash,
                        git_commit,
                        device_cfg,
                        execution,
                        objective,
                        plan,
                    )
                    _write_record(record)
                    logged_trials.add(target_idx)
                    if target_idx == next_to_log:
                        next_to_log += 1
                        while next_to_log in completed_trials or next_to_log in logged_trials:
                            next_to_log += 1
                    if stop_flag:
                        break
            while inflight:
                if next_to_log in inflight:
                    target_idx = next_to_log
                else:
                    target_idx = min(inflight)
                future = inflight.pop(target_idx)
                result = future.result()
                result.device = device_snapshot
                record = _trial_result_to_dict(
                    result,
                    dataset_hash,
                    cv_hash,
                    git_commit,
                    device_cfg,
                    execution,
                    objective,
                    plan,
                )
                _write_record(record)
                logged_trials.add(target_idx)
                if target_idx == next_to_log:
                    next_to_log += 1
                    while next_to_log in completed_trials or next_to_log in logged_trials:
                        next_to_log += 1
    finally:
        signal.signal(signal.SIGINT, previous_handler)
        log_handle.close()

    if stop_flag:
        raise KeyboardInterrupt("Random search interrupted; partial results written")

    all_records = _load_log_json(log_path)
    best_trial = _select_best_trial(all_records, objective.primary)
    if best_trial is None:
        raise RuntimeError("No valid trials were completed")

    summary = {
        "objective": objective.primary,
        "aggregator": objective.aggregator.__dict__,
        "search": {
            "n_trials": execution.n_trials,
            "base_seed": execution.base_seed,
            "parallel": execution.parallel,
            "resume": execution.resume,
            "dedup": execution.dedup,
        },
        "device": {
            "gpu_mode": device_cfg.gpu_mode,
        },
        "git_commit": git_commit,
        "data_hash": dataset_hash,
        "cv_hash": cv_hash,
        "best_trial": best_trial,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)

    summary_copy = out_path.with_name("summary.json")
    if summary_copy != out_path:
        with summary_copy.open("w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)

    best_path = out_path.with_name("best.json")
    with best_path.open("w", encoding="utf-8") as handle:
        json.dump(best_trial, handle, ensure_ascii=False, indent=2)

    return summary


def _trial_result_to_dict(
    result: TrialResult,
    dataset_hash: str,
    cv_hash: str,
    git_commit: Optional[str],
    device_cfg: SearchDeviceConfig,
    execution: SearchExecutionConfig,
    objective: ObjectiveConfig,
    plan: SplitPlan,
) -> Dict[str, Any]:
    record = {
        "trial_id": result.trial_id,
        "trial_seed": result.trial_seed,
        "status": result.status,
        "message": result.message,
        "params": result.params,
        "fold_metrics": result.fold_metrics,
        "aggregated": result.aggregated,
        "objective_value": result.objective_value,
        "valid_mask": result.valid_mask,
        "git_commit": git_commit,
        "data_hash": dataset_hash,
        "cv_hash": cv_hash,
        "device": result.device,
        "gpu_mode": device_cfg.gpu_mode,
        "objective": objective.primary,
        "aggregator": objective.aggregator.__dict__,
        "search": {
            "base_seed": execution.base_seed,
            "trial_seed": result.trial_seed,
        },
        "cv": {
            "n_folds": len(plan.folds),
        },
    }
    return record


def _load_existing_log(log_path: Path) -> Dict[int, Dict[str, Any]]:
    records: Dict[int, Dict[str, Any]] = {}
    if not log_path.exists():
        return records
    with log_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            raw = json.loads(line)
            trial_id = int(raw.get("trial_id", raw.get("trial", 0)))
            params = raw.get("params", {})
            param_key = json.dumps(params, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            records[trial_id] = {
                "raw": raw,
                "param_key": param_key,
            }
    return records


def _load_log_json(log_path: Path) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    if not log_path.exists():
        return entries
    with log_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                entries.append(json.loads(line))
    return entries


def _select_best_trial(records: Sequence[Dict[str, Any]], primary: str) -> Optional[Dict[str, Any]]:
    key = primary.upper()
    best: Optional[Tuple[float, Dict[str, Any]]] = None
    for record in records:
        if record.get("status") != TrialStatus.OK:
            continue
        aggregated = record.get("aggregated", {})
        metric_block = aggregated.get(key)
        if not isinstance(metric_block, dict):
            continue
        value = metric_block.get("aggregate_value")
        if value is None or not np.isfinite(value):
            continue
        score = float(value)
        if best is None or score > best[0]:
            best = (score, record)
    return best[1] if best else None


def _prepare_dataframe(df: pd.DataFrame, plan: SplitPlan) -> pd.DataFrame:
    required = {plan.timestamp_column, plan.session_column, plan.label_column}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Dataset is missing required columns: {sorted(missing)}")
    df = df.copy()
    df[plan.timestamp_column] = pd.to_datetime(df[plan.timestamp_column], utc=True, errors="coerce")
    df.sort_values(plan.timestamp_column, inplace=True)
    df.reset_index(drop=True, inplace=True)
    df[plan.session_column] = df[plan.session_column].astype(str)
    return df


def _evaluate_trial_safe(
    df: pd.DataFrame,
    plan: SplitPlan,
    params: Dict[str, Any],
    trial_idx: int,
    trial_seed: int,
    objective: ObjectiveConfig,
) -> TrialResult:
    try:
        return _evaluate_trial(df, plan, params, trial_idx, trial_seed, objective)
    except Exception as exc:  # noqa: BLE001 - propagate context
        return TrialResult(
            trial_id=trial_idx,
            trial_seed=trial_seed,
            params=params,
            fold_metrics=[],
            aggregated={},
            objective_value=None,
            status=TrialStatus.FAILED,
            message=str(exc),
            valid_mask={},
            device=_resolve_device_snapshot(),
        )


def _evaluate_trial(
    df: pd.DataFrame,
    plan: SplitPlan,
    params: Dict[str, Any],
    trial_idx: int,
    trial_seed: int,
    objective: ObjectiveConfig,
) -> TrialResult:
    fold_records: List[Dict[str, Any]] = []
    fold_metrics: List[FoldMetric] = []
    valid_mask: Dict[str, List[bool]] = {"AP": [], "ROC_AUC": [], "F1": []}

    for fold_idx, fold in enumerate(plan.folds):
        fold_seed = trial_seed + fold_idx
        _set_seed(fold_seed)
        fold_record, metrics = _evaluate_fold(df, plan, fold, params, fold_seed)
        fold_records.append(fold_record)
        fold_metrics.append(metrics)
        valid_mask["AP"].append(metrics.valid_ap)
        valid_mask["ROC_AUC"].append(metrics.valid_roc_auc)
        valid_mask["F1"].append(metrics.valid_f1)

    summary = summarise_metrics(fold_metrics, objective.aggregator, objective.primary)
    objective_metric = summary.metrics[objective.primary.upper()]
    if objective_metric.n_valid == 0:
        status = TrialStatus.INVALID
        objective_value: Optional[float] = None
        message = "no valid folds for objective metric"
    else:
        status = TrialStatus.OK
        objective_value = summary.objective_value if np.isfinite(summary.objective_value) else None
        message = None

    aggregated = {
        metric: {
            "mean": values.mean,
            "std": values.std,
            "n_valid": values.n_valid,
            "aggregate_value": values.aggregate_value,
        }
        for metric, values in summary.metrics.items()
    }

    return TrialResult(
        trial_id=trial_idx,
        trial_seed=trial_seed,
        params=params,
        fold_metrics=fold_records,
        aggregated=aggregated,
        objective_value=objective_value,
        status=status,
        message=message,
        valid_mask=valid_mask,
        device=_resolve_device_snapshot(),
    )


def _evaluate_fold(
    df: pd.DataFrame,
    plan: SplitPlan,
    fold: FoldPlan,
    params: Dict[str, Any],
    seed: int,
) -> Tuple[Dict[str, Any], FoldMetric]:
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
        train_sessions_sequence + val_sessions_sequence,
        feature_pack,
        trainer_config,
        split,
    )

    smoothing_value = params.get("features", {}).get("smoothing_window")
    smoothing_window = max(int(smoothing_value), 1) if smoothing_value is not None else 5
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
    y_true = y_true[mask].astype(int)

    ap, valid_ap = safe_average_precision(y_true, y_score)
    roc_auc, valid_roc = safe_roc_auc(y_true, y_score)
    f1, theta, precision, recall, valid_f1 = safe_f1_at_best_threshold(y_true, y_score)
    n_pos = int(np.sum(y_true == 1))
    n_neg = int(np.sum(y_true == 0))

    fold_metric = FoldMetric(
        ap=float(ap),
        roc_auc=float(roc_auc),
        f1=float(f1),
        threshold=float(theta),
        precision=float(precision),
        recall=float(recall),
        n_pos=n_pos,
        n_neg=n_neg,
        valid_ap=bool(valid_ap),
        valid_roc_auc=bool(valid_roc),
        valid_f1=bool(valid_f1),
    )

    fold_record = {
        "name": fold.name,
        "metrics": {
            "AP": None if not valid_ap else float(ap),
            "ROC_AUC": None if not valid_roc else float(roc_auc),
            "F1": None if not valid_f1 else float(f1),
            "threshold": None if not valid_f1 else float(theta),
            "precision": None if not valid_f1 else float(precision),
            "recall": None if not valid_f1 else float(recall),
            "n_pos": n_pos,
            "n_neg": n_neg,
        },
        "best_val_loss": float(best_val),
        "val_loss_last": float(history.get("val_loss", [np.nan])[-1]) if history.get("val_loss") else None,
        "best_epoch": int(best_epoch),
        "train_sessions": len(unique_train),
        "validation_sessions": len(unique_val),
        "purge_seconds": fold.purge,
        "embargo_seconds": fold.embargo,
        "dropped_train_events": int(dropped_rows),
    }
    return fold_record, fold_metric


def _build_trainer_config(params: Dict[str, Any], seed: int) -> TrainerConfig:
    config_values: Dict[str, Any] = {}
    if "trainer" in params or "model" in params:
        for section in ("trainer", "model"):
            config_values.update(params.get(section, {}))
    else:
        config_values.update(_legacy_param_mapping(params))
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


def _legacy_param_mapping(params: Dict[str, Any]) -> Dict[str, Any]:
    aliases = {
        "lr": ("learning_rate", float),
        "learning_rate": ("learning_rate", float),
        "weight_decay": ("weight_decay", float),
        "batch_size": ("batch_size", int),
        "hidden_size": ("hidden_size", int),
        "embedding_dim": ("embedding_dim", int),
        "dropout": ("dropout", float),
        "num_layers": ("num_layers", int),
    }
    mapped: Dict[str, Any] = {}
    for key, value in params.items():
        if key in {"features", "model", "trainer"}:
            continue
        target = aliases.get(key)
        if target:
            mapped[target[0]] = target[1](value)
    if "trainer" in params:
        mapped.update(params["trainer"])
    if "model" in params:
        mapped.update(params["model"])
    return mapped


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


def _sample_parameters_for_trial(space: Dict[str, Any], seed: int) -> Dict[str, Any]:
    rng = random.Random(seed)
    return _sample_parameters(space, rng)


def _sample_parameters(space: Dict[str, Any], rng: random.Random) -> Dict[str, Any]:
    sampled: Dict[str, Any] = {}
    for key, spec in space.items():
        sampled[key] = _sample_value(spec, rng)
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

    if "type" not in spec and "distribution" not in spec:
        return {key: _sample_value(value, rng) for key, value in spec.items()}

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
    if spec_type in {"int", "randint", "int_uniform"}:
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


def _deepcopy_if_needed(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.loads(json.dumps(value))
    return value


def _compute_dataframe_hash(df: pd.DataFrame) -> str:
    hashed = pd.util.hash_pandas_object(df, index=True).values
    return deterministic_hash(hashed.tolist())


def _compute_cv_hash(plan: SplitPlan) -> str:
    representation = {
        "folds": [
            {
                "name": fold.name,
                "train": fold.train_sessions,
                "validation": fold.validation_sessions,
                "purge": fold.purge,
                "embargo": fold.embargo,
            }
            for fold in plan.folds
        ],
        "label_column": plan.label_column,
        "timestamp_column": plan.timestamp_column,
        "session_column": plan.session_column,
    }
    return deterministic_hash(representation)


def _detect_git_commit() -> Optional[str]:
    try:
        commit = (
            subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=Path.cwd())
            .decode("utf-8")
            .strip()
        )
        return commit
    except Exception:  # pragma: no cover - git may be unavailable
        return None


def _apply_device_mode(mode: str) -> None:
    os.environ["GPU_MODE"] = mode
    mode_lower = mode.lower()
    if mode_lower == "auto":
        for candidate in ("ada6000", "4060"):
            device_id = _GPU_MAPPING.get(candidate)
            if device_id is not None:
                os.environ["CUDA_VISIBLE_DEVICES"] = device_id
                return
        os.environ.pop("CUDA_VISIBLE_DEVICES", None)
        return
    device_id = _GPU_MAPPING.get(mode_lower)
    if device_id is not None:
        os.environ["CUDA_VISIBLE_DEVICES"] = device_id
    else:
        os.environ.pop("CUDA_VISIBLE_DEVICES", None)


def _resolve_device_snapshot() -> Dict[str, Any]:
    info: Dict[str, Any] = {}
    try:
        import torch

        if torch.cuda.is_available():
            info["device"] = "cuda:0"
            info["device_name"] = torch.cuda.get_device_name(0)
        else:
            info["device"] = "cpu"
            info["device_name"] = None
    except Exception:  # pragma: no cover - torch optional in tests
        info["device"] = os.environ.get("TORCH_DEVICE", "cpu")
        info["device_name"] = None
    return info


__all__ = [
    "FoldPlan",
    "SplitPlan",
    "CVConfig",
    "load_split_plan",
    "load_search_space",
    "load_random_search_manifest",
    "run_random_search",
]
