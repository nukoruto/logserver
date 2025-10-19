"""Workflow orchestration for dt-cv."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, MutableMapping, Optional

import numpy as np
import pandas as pd

from .config import FoldPaths
from .evaluation import MethodEvaluation, evaluate_methods
from .metrics import fisher_neglog10, save_scores
from .runner import CommandSpec, build_deterministic_env, run_command
from .splitter import load_splits


REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_LSTM_CFG = REPO_ROOT / "configs" / "best_from_search.yaml"

_LOGGER = logging.getLogger("dt_cv.workflow")


class WorkflowError(RuntimeError):
    """Raised when workflow execution fails."""


def _resolve_path(base: Path, value: Optional[str]) -> Optional[Path]:
    if value in (None, "", "null"):
        return None
    return (base / value).resolve()


def _fold_paths(base: Path, entry: Mapping[str, object]) -> FoldPaths:
    paths = entry.get("paths", {})
    raw = paths.get("raw", {}) if isinstance(paths, Mapping) else {}
    features = paths.get("features", {}) if isinstance(paths, Mapping) else {}
    preproc = paths.get("preproc", {}) if isinstance(paths, Mapping) else {}
    anom = paths.get("anom", {}) if isinstance(paths, Mapping) else {}
    lstm = paths.get("lstm", {}) if isinstance(paths, Mapping) else {}
    fisher = paths.get("fisher", {}) if isinstance(paths, Mapping) else {}
    metrics = paths.get("metrics", {}) if isinstance(paths, Mapping) else {}
    return FoldPaths(
        raw_train=_resolve_path(base, raw.get("train")),
        raw_validation=_resolve_path(base, raw.get("validation")),
        raw_test=_resolve_path(base, raw.get("test")),
        features_train=_resolve_path(base, features.get("train")),
        features_validation=_resolve_path(base, features.get("validation")),
        features_test=_resolve_path(base, features.get("test")),
        preproc_stats=_resolve_path(base, preproc.get("stats")),
        preproc_meta=_resolve_path(base, preproc.get("meta")),
        anomaly_stats=_resolve_path(base, anom.get("stats")),
        anomaly_meta=_resolve_path(base, anom.get("meta")),
        anomaly_scores_validation=_resolve_path(base, anom.get("validation_scores")),
        anomaly_scores_test=_resolve_path(base, anom.get("test_scores")),
        lstm_dir=_resolve_path(base, lstm.get("dir")) or (base / "lstm"),
        lstm_validation_scores=_resolve_path(base, lstm.get("validation_scores")),
        lstm_test_scores=_resolve_path(base, lstm.get("test_scores")),
        fisher_validation_scores=_resolve_path(base, fisher.get("validation_scores")),
        fisher_test_scores=_resolve_path(base, fisher.get("test_scores")),
        metrics_validation=_resolve_path(base, metrics.get("validation")),
        metrics_test=_resolve_path(base, metrics.get("test")),
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    data = path.read_bytes()
    digest.update(data)
    return digest.hexdigest()


def _ensure_parent(path: Optional[Path]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)


def _subset_pairs(paths: FoldPaths) -> List[tuple[str, Path]]:
    items: List[tuple[str, Path]] = [("train", paths.features_train), ("validation", paths.features_validation)]
    if paths.features_test is not None:
        items.append(("test", paths.features_test))
    return items


def _thresholds_from_metrics(path: Path) -> Dict[str, float]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        return {}
    methods = payload.get("methods", {})
    if not isinstance(methods, Mapping):
        return {}
    result: Dict[str, float] = {}
    for method, info in methods.items():
        if not isinstance(info, Mapping):
            continue
        threshold = info.get("threshold")
        if not isinstance(threshold, Mapping):
            continue
        value = threshold.get("value")
        if value is None:
            continue
        try:
            result[str(method)] = float(value)
        except (TypeError, ValueError):
            continue
    return result


def run_train(
    splits_path: Path,
    *,
    dt_preproc_bin: str,
    dt_anom_bin: str,
    dt_lstm_bin: str,
    seed: int,
    gpu_mode: Optional[str],
    resume: bool = False,
    lstm_cfg: Path | None = None,
) -> None:
    splits = load_splits(splits_path)
    base_dir = splits_path.parent
    for fold in splits.folds:
        fold_id = int(fold.get("id", 0))
        paths = _fold_paths(base_dir, fold)
        if paths.raw_train is None or paths.raw_validation is None:
            raise WorkflowError("Split paths are missing mandatory raw CSVs")
        _ensure_parent(paths.preproc_stats)
        env = build_deterministic_env(seed, gpu_mode)
        # dt-preproc fit
        if resume and paths.preproc_stats.exists() and paths.preproc_meta.exists():
            _LOGGER.debug("resume.skip", extra={"stage": "preproc.fit", "fold": fold_id})
        else:
            argv_fit = [
                dt_preproc_bin,
                "fit",
                "--in",
                str(paths.raw_train),
                "--out",
                str(paths.preproc_stats),
                "--meta",
                str(paths.preproc_meta),
                "--pretty",
            ]
            run_command(
                CommandSpec(
                    name=f"fold{fold_id}.preproc.fit",
                    argv=argv_fit,
                    cwd=paths.preproc_stats.parent,
                    env=env,
                    outputs={"stats": paths.preproc_stats, "meta": paths.preproc_meta},
                )
            )
        # dt-preproc transform for each subset
        for subset, feature_path in _subset_pairs(paths):
            if feature_path is None:
                continue
            raw_path = {
                "train": paths.raw_train,
                "validation": paths.raw_validation,
                "test": paths.raw_test,
            }[subset]
            if raw_path is None:
                continue
            _ensure_parent(feature_path)
            if resume and feature_path.exists():
                _LOGGER.debug(
                    "resume.skip",
                    extra={"stage": f"preproc.transform.{subset}", "fold": fold_id},
                )
                continue
            argv_transform = [
                dt_preproc_bin,
                "transform",
                "--in",
                str(raw_path),
                "--stats",
                str(paths.preproc_stats),
                "--out",
                str(feature_path),
                "--validate-schema",
            ]
            run_command(
                CommandSpec(
                    name=f"fold{fold_id}.preproc.transform.{subset}",
                    argv=argv_transform,
                    cwd=paths.preproc_stats.parent,
                    env=env,
                    outputs={"features": feature_path},
                )
            )
        stats_hash = _sha256(paths.preproc_stats)
        # dt-anom fit
        if resume and paths.anomaly_stats.exists() and paths.anomaly_meta.exists():
            _LOGGER.debug("resume.skip", extra={"stage": "anom.fit", "fold": fold_id})
        else:
            argv_anom_fit = [
                dt_anom_bin,
                "fit",
                "-i",
                str(paths.features_train),
                "-s",
                str(paths.anomaly_stats),
                "-m",
                str(paths.anomaly_meta),
                "--column",
                "dt_sec",
                "--seed",
                str(seed),
                "--preproc-hash",
                stats_hash,
            ]
            run_command(
                CommandSpec(
                    name=f"fold{fold_id}.anom.fit",
                    argv=argv_anom_fit,
                    cwd=paths.anomaly_stats.parent,
                    env=env,
                    outputs={"stats": paths.anomaly_stats, "meta": paths.anomaly_meta},
                )
            )
        cfg_path = lstm_cfg or DEFAULT_LSTM_CFG
        if not cfg_path.exists():
            raise WorkflowError(f"dt-lstm 設定ファイルが見つかりません: {cfg_path}")
        # dt-lstm train
        lstm_dir = paths.lstm_dir
        lstm_dir.mkdir(parents=True, exist_ok=True)
        model_path = lstm_dir / "model.pt"
        if resume and model_path.exists():
            _LOGGER.debug("resume.skip", extra={"stage": "lstm.train", "fold": fold_id})
        else:
            argv_lstm_train = [
                dt_lstm_bin,
                "train",
                "--train",
                str(paths.features_train),
                "--dev",
                str(paths.features_validation),
                "--cfg",
                str(cfg_path),
                "--seed",
                str(seed),
                "--out",
                str(lstm_dir),
            ]
            run_command(
                CommandSpec(
                    name=f"fold{fold_id}.lstm.train",
                    argv=argv_lstm_train,
                    cwd=lstm_dir,
                    env=env,
                    outputs={"dir": lstm_dir},
                )
            )
        # dt-lstm calibrate
        calib_path = lstm_dir / "calib.json"
        if resume and calib_path.exists():
            _LOGGER.debug("resume.skip", extra={"stage": "lstm.calibrate", "fold": fold_id})
        else:
            argv_lstm_calibrate = [
                dt_lstm_bin,
                "calibrate",
                "--dev",
                str(paths.features_validation),
                "--model",
                str(model_path),
                "--out",
                str(calib_path),
                "--cfg",
                str(cfg_path),
                "--seed",
                str(seed),
            ]
            run_command(
                CommandSpec(
                    name=f"fold{fold_id}.lstm.calibrate",
                    argv=argv_lstm_calibrate,
                    cwd=lstm_dir,
                    env=env,
                    outputs={"calib": calib_path},
                )
            )


def _join_scores(
    base_frame: pd.DataFrame,
    anom_scores: pd.DataFrame,
    lstm_scores: pd.DataFrame,
) -> pd.DataFrame:
    base = base_frame.copy()
    anom = anom_scores.copy()
    lstm = lstm_scores.copy()

    use_row_index = "row_index" in anom.columns and "row_index" in lstm.columns
    synthetic_key = "__merge_id"
    join_key = "row_index" if use_row_index else synthetic_key

    if use_row_index:
        if "row_index" not in base.columns:
            base["row_index"] = np.arange(len(base), dtype=np.int64)
        if base["row_index"].duplicated().any():
            raise WorkflowError("'row_index' column must be unique when joining scores")
        # Normalize dtype to avoid mismatched joins caused by object/int differences.
        base["row_index"] = base["row_index"].astype(str)
        anom["row_index"] = anom["row_index"].astype(str)
        lstm["row_index"] = lstm["row_index"].astype(str)
    else:
        if len({len(base), len(anom), len(lstm)}) != 1:
            raise WorkflowError("Score outputs must align with input rows for join without 'row_index'")
        base[synthetic_key] = np.arange(len(base), dtype=np.int64)
        anom[synthetic_key] = np.arange(len(anom), dtype=np.int64)
        lstm[synthetic_key] = np.arange(len(lstm), dtype=np.int64)

    # Retain only the join key and score column from the score frames.
    anom_keep = [join_key]
    if "neglog10_p" in anom.columns:
        anom_keep.append("neglog10_p")
    anom = anom.loc[:, list(dict.fromkeys(anom_keep))]

    lstm_keep = [join_key]
    lstm_col = "neglog10_p"
    for candidate in ("neglog10_p_lstm", "neglog10_p"):
        if candidate in lstm.columns:
            lstm_col = candidate
            break
    lstm_keep.append(lstm_col)
    lstm = lstm.loc[:, list(dict.fromkeys(lstm_keep))]

    merged = base.merge(anom, on=join_key, how="inner", suffixes=("", "_anom"))
    merged = merged.merge(lstm, on=join_key, how="inner", suffixes=("_anom", "_lstm"))

    if len(merged) != len(base):
        raise WorkflowError("Joining score frames produced mismatched row count")

    if join_key == synthetic_key:
        merged = merged.drop(columns=[synthetic_key])

    return merged


def _score_subset(
    subset: str,
    fold_id: int,
    paths: FoldPaths,
    *,
    dt_anom_bin: str,
    dt_lstm_bin: str,
    env: Mapping[str, str],
    thresholds: Optional[Mapping[str, float]] = None,
    bins: int = 15,
    resume: bool = False,
    lstm_cfg: Path | None = None,
) -> tuple[Optional[Path], Dict[str, float]]:
    raw_path = {
        "validation": paths.raw_validation,
        "test": paths.raw_test,
    }.get(subset)
    if raw_path is None:
        return None
    feature_path = {
        "validation": paths.features_validation,
        "test": paths.features_test,
    }[subset]
    if feature_path is None:
        return None
    anom_output = {
        "validation": paths.anomaly_scores_validation,
        "test": paths.anomaly_scores_test,
    }[subset]
    lstm_output = {
        "validation": paths.lstm_validation_scores,
        "test": paths.lstm_test_scores,
    }[subset]
    fisher_output = {
        "validation": paths.fisher_validation_scores,
        "test": paths.fisher_test_scores,
    }[subset]
    metrics_output = {
        "validation": paths.metrics_validation,
        "test": paths.metrics_test,
    }[subset]
    if any(path is None for path in (anom_output, lstm_output, fisher_output, metrics_output)):
        return None, dict(thresholds or {})
    assert anom_output is not None and lstm_output is not None
    assert fisher_output is not None and metrics_output is not None
    _ensure_parent(anom_output)
    _ensure_parent(lstm_output)
    _ensure_parent(fisher_output)
    _ensure_parent(metrics_output)
    audit_path = anom_output.with_suffix(".audit.jsonl")
    _ensure_parent(audit_path)
    lstm_audit = paths.lstm_dir / "audit" / f"{subset}_lstm_audit.jsonl"
    _ensure_parent(lstm_audit)
    outputs_exist = (
        anom_output.exists()
        and lstm_output.exists()
        and fisher_output.exists()
        and metrics_output.exists()
        and audit_path.exists()
        and lstm_audit.exists()
    )
    if resume and outputs_exist:
        restored = dict(thresholds or {})
        restored.update(_thresholds_from_metrics(metrics_output))
        return metrics_output, restored
    # dt-anom score
    argv_anom_score = [
        dt_anom_bin,
        "score",
        "-i",
        str(feature_path),
        "-o",
        str(anom_output),
        "--stats",
        str(paths.anomaly_stats),
        "--meta",
        str(paths.anomaly_meta),
        "--audit",
        str(audit_path),
    ]
    run_command(
        CommandSpec(
            name=f"fold{fold_id}.anom.score.{subset}",
            argv=argv_anom_score,
            cwd=paths.anomaly_stats.parent,
            env=env,
            outputs={
                "scores": anom_output,
                "audit": audit_path,
            },
        )
    )
    # dt-lstm infer
    lstm_ckpt = paths.lstm_dir / "model.pt"
    calib_path = paths.lstm_dir / "calib.json"
    if not calib_path.exists():
        raise WorkflowError(f"Calibration artifact not found: {calib_path}")
    cfg_path = lstm_cfg or DEFAULT_LSTM_CFG
    argv_lstm_infer = [
        dt_lstm_bin,
        "infer",
        "--test",
        str(feature_path),
        "--model",
        str(lstm_ckpt),
        "--calib",
        str(calib_path),
        "--out",
        str(lstm_output),
        "--audit",
        str(lstm_audit),
        "--cfg",
        str(cfg_path),
        "--seed",
        str(env.get("DT_GLOBAL_SEED", "0")),
    ]
    run_command(
        CommandSpec(
            name=f"fold{fold_id}.lstm.infer.{subset}",
            argv=argv_lstm_infer,
            cwd=paths.lstm_dir,
            env=env,
            outputs={"scores": lstm_output, "audit": lstm_audit},
        )
    )
    # Metrics computation
    base_frame = pd.read_csv(raw_path)
    if "anomaly_label" not in base_frame.columns:
        raise WorkflowError("Input dataset must contain 'anomaly_label' column for evaluation")
    anom_scores = pd.read_csv(anom_output)
    lstm_scores = pd.read_csv(lstm_output)
    merged = _join_scores(base_frame, anom_scores, lstm_scores)
    merged = merged.reset_index(drop=True)
    if "timestamp_utc" in merged.columns:
        merged["timestamp_utc"] = pd.to_datetime(merged["timestamp_utc"], utc=True, errors="coerce")
    anom_col = "neglog10_p"
    if "neglog10_p_anom" in merged.columns:
        anom_col = "neglog10_p_anom"
    if anom_col not in merged.columns:
        raise WorkflowError("dt-anom scores must contain 'neglog10_p'")
    if "neglog10_p_lstm" not in merged.columns:
        raise WorkflowError("dt-lstm scores must contain 'neglog10_p'")
    anom_neglog = merged[anom_col].astype(float).to_numpy()
    lstm_neglog = merged["neglog10_p_lstm"].astype(float).to_numpy()
    fisher_neglog = fisher_neglog10(anom_neglog, lstm_neglog)
    merged["neglog10_p_anom"] = anom_neglog
    merged["neglog10_p_lstm"] = lstm_neglog
    merged["neglog10_p_fisher"] = fisher_neglog
    score_columns = {
        "dt_anom": "neglog10_p_anom",
        "dt_lstm": "neglog10_p_lstm",
        "fisher": "neglog10_p_fisher",
    }
    eval_results, threshold_map = evaluate_methods(
        merged,
        score_columns=score_columns,
        label_column="anomaly_label",
        session_column="session_id",
        timestamp_column="timestamp_utc",
        user_column="uid",
        bins=bins,
        thresholds=thresholds,
        compute_thresholds=thresholds is None,
    )
    metrics_payload: Dict[str, object] = {
        "subset": subset,
        "fold_id": fold_id,
        "counts": {
            "events": int(len(merged)),
            "positive_events": int(np.sum(merged["anomaly_label"].astype(float) == 1.0)),
        },
        "methods": {},
    }
    for method, evaluation in eval_results.items():
        column_name = f"prediction_{method}"
        prediction_series = pd.Series(pd.NA, index=merged.index, dtype="Int64")
        mask = evaluation.mask
        if mask.size != prediction_series.size:
            raise WorkflowError("Prediction mask length mismatch for method '%s'" % method)
        prediction_series.loc[mask] = evaluation.predictions.astype(int)
        merged[column_name] = prediction_series
        metrics_payload["methods"][method] = evaluation.to_json()
    _ensure_parent(metrics_output)
    metrics_output.write_text(json.dumps(metrics_payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    _ensure_parent(fisher_output)
    save_scores(fisher_output, merged)
    if not threshold_map and thresholds is not None:
        threshold_map = dict(thresholds)
    return metrics_output, threshold_map


def run_eval(
    splits_path: Path,
    *,
    dt_anom_bin: str,
    dt_lstm_bin: str,
    seed: int,
    gpu_mode: Optional[str],
    bins: int = 15,
    resume: bool = False,
    lstm_cfg: Path | None = None,
) -> None:
    splits = load_splits(splits_path)
    base_dir = splits_path.parent
    for fold in splits.folds:
        fold_id = int(fold.get("id", 0))
        paths = _fold_paths(base_dir, fold)
        env = build_deterministic_env(seed, gpu_mode)
        thresholds_map: Dict[str, float] | None = None
        for subset in ("validation", "test"):
            _, new_thresholds = _score_subset(
                subset,
                fold_id,
                paths,
                dt_anom_bin=dt_anom_bin,
                dt_lstm_bin=dt_lstm_bin,
                env=env,
                thresholds=thresholds_map,
                bins=bins,
                resume=resume,
                lstm_cfg=lstm_cfg,
            )
            if new_thresholds:
                if thresholds_map is None:
                    thresholds_map = dict(new_thresholds)
                else:
                    thresholds_map.update(new_thresholds)


def run_report(splits_path: Path, *, subsets: Iterable[str] = ("validation", "test")) -> Path:
    splits = load_splits(splits_path)
    base_dir = splits_path.parent
    summary: Dict[str, Dict[str, List[float]]] = {}
    for fold in splits.folds:
        paths = _fold_paths(base_dir, fold)
        for subset in subsets:
            metrics_path = {
                "validation": paths.metrics_validation,
                "test": paths.metrics_test,
            }.get(subset)
            if metrics_path is None or not metrics_path.exists():
                continue
            payload = json.loads(metrics_path.read_text(encoding="utf-8"))
            methods_payload = payload.get("methods", {}) if isinstance(payload, Mapping) else {}
            for method, values in methods_payload.items():
                metrics_info = values.get("metrics", {}) if isinstance(values, Mapping) else {}
                method_entry = summary.setdefault(method, {})
                subset_entry = method_entry.setdefault(subset, {"average_precision": [], "roc_auc": []})
                ap_val = metrics_info.get("average_precision")
                if ap_val is not None:
                    subset_entry["average_precision"].append(float(ap_val))
                roc_val = metrics_info.get("roc_auc")
                if roc_val is not None:
                    subset_entry.setdefault("roc_auc", []).append(float(roc_val))
    report = {}
    for method, subset_values in summary.items():
        report[method] = {}
        for subset, metrics in subset_values.items():
            method_subset = {}
            for metric_name, samples in metrics.items():
                if not samples:
                    continue
                arr = np.asarray(samples, dtype=float)
                method_subset[metric_name] = {
                    "mean": float(arr.mean()),
                    "std": float(arr.std(ddof=0)),
                }
            if method_subset:
                report[method][subset] = method_subset
    out_path = base_dir / "cv_report.json"
    out_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return out_path
