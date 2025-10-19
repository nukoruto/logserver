"""Fold-level summary aggregation for dt-cv."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Mapping, MutableMapping, Optional

import numpy as np
import pandas as pd

from .evaluation import evaluate_methods


@dataclass
class FoldData:
    """Container describing per-fold evaluation artifacts."""

    metrics_path: Path
    fisher_path: Path


def _discover_folds(base_dir: Path) -> Dict[str, Dict[str, FoldData]]:
    folds: Dict[str, Dict[str, FoldData]] = {}
    for fold_dir in sorted(path for path in base_dir.iterdir() if path.is_dir() and path.name.startswith("fold_")):
        subsets: Dict[str, FoldData] = {}
        metrics_dir = fold_dir / "metrics"
        fisher_dir = fold_dir / "fisher"
        for subset in ("validation", "test"):
            metrics_path = metrics_dir / f"{subset}.json"
            fisher_path = fisher_dir / f"{subset}_scores.csv"
            if metrics_path.exists() and fisher_path.exists():
                subsets[subset] = FoldData(metrics_path=metrics_path, fisher_path=fisher_path)
        if subsets:
            folds[fold_dir.name] = subsets
    return folds


def _stationary_bootstrap_indices(length: int, block_mean: int, rng: np.random.Generator) -> np.ndarray:
    if length <= 0:
        return np.empty(0, dtype=int)
    block_mean = max(int(block_mean), 1)
    prob = 1.0 / float(block_mean)
    indices = np.empty(length, dtype=int)
    indices[0] = rng.integers(0, length)
    for i in range(1, length):
        if rng.random() < prob:
            indices[i] = rng.integers(0, length)
        else:
            indices[i] = (indices[i - 1] + 1) % length
    return indices


def _append_metric(samples: MutableMapping[str, list[float]], name: str, value: Optional[float]) -> None:
    if value is None:
        return
    samples.setdefault(name, []).append(float(value))


def _parse_metrics_payload(path: Path) -> Mapping[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        return {}
    return payload


def summarize_folds(
    base_dir: Path,
    *,
    out_dir: Path,
    bootstrap: str,
    block_mean: Optional[int],
    bootstrap_samples: int,
    seed: int,
    bins: int = 15,
) -> Path:
    folds = _discover_folds(base_dir)
    if not folds:
        raise ValueError(f"No fold artifacts found under {base_dir}")

    fold_metrics: Dict[str, Dict[str, Dict[str, list[float]]]] = {}
    fold_macro: Dict[str, Dict[str, Dict[str, list[float]]]] = {}
    combined_frames: Dict[str, list[pd.DataFrame]] = {"validation": [], "test": []}

    for fold_name, subsets in folds.items():
        for subset, data in subsets.items():
            payload = _parse_metrics_payload(data.metrics_path)
            methods_payload = payload.get("methods", {}) if isinstance(payload, Mapping) else {}
            for method, info in methods_payload.items():
                metrics_info = info.get("metrics", {}) if isinstance(info, Mapping) else {}
                macro_info = info.get("macro_user", {}) if isinstance(info, Mapping) else {}
                subset_metrics = fold_metrics.setdefault(subset, {}).setdefault(method, {})
                subset_macro = fold_macro.setdefault(subset, {}).setdefault(method, {})
                for metric_name, metric_value in metrics_info.items():
                    if metric_value is None:
                        continue
                    subset_metrics.setdefault(metric_name, []).append(float(metric_value))
                for metric_name, macro_value in macro_info.items():
                    if macro_value is None:
                        continue
                    subset_macro.setdefault(metric_name, []).append(float(macro_value))
            frame = pd.read_csv(data.fisher_path)
            for column in ("timestamp_utc", "timestamp_utc_truth", "timestamp_utc_pred"):
                if column in frame.columns:
                    frame[column] = pd.to_datetime(frame[column], utc=True, errors="coerce")
            frame["fold_id"] = fold_name
            combined_frames.setdefault(subset, []).append(frame)

    bootstrap_results: Dict[str, Dict[str, Dict[str, list[float]]]] = {}
    bootstrap_macro: Dict[str, Dict[str, Dict[str, list[float]]]] = {}
    if bootstrap == "stationary":
        if block_mean is None or block_mean <= 0:
            raise ValueError("Stationary bootstrap requires positive block_mean")
        rng = np.random.default_rng(seed)
        for subset, frames in combined_frames.items():
            if not frames:
                continue
            frame = pd.concat(frames, ignore_index=True)
            if frame.empty:
                continue
            score_columns = {
                "dt_anom": "neglog10_p_anom",
                "dt_lstm": "neglog10_p_lstm",
                "fisher": "neglog10_p_fisher",
            }
            for metric_col in score_columns.values():
                if metric_col not in frame.columns:
                    raise ValueError(f"Missing score column '{metric_col}' in aggregated frame for subset '{subset}'")
            for _ in range(bootstrap_samples):
                indices = _stationary_bootstrap_indices(len(frame), block_mean, rng)
                sampled = frame.iloc[indices].reset_index(drop=True)
                predictions_map: Dict[str, np.ndarray] = {}
                for method in score_columns.keys():
                    pred_col = f"prediction_{method}"
                    if pred_col in sampled.columns:
                        preds_series = sampled[pred_col].fillna(0).astype(int)
                        predictions_map[method] = preds_series.to_numpy()
                evaluations, _ = evaluate_methods(
                    sampled,
                    score_columns=score_columns,
                    label_column="anomaly_label",
                    session_column="session_id",
                    timestamp_column="timestamp_utc",
                    user_column="uid",
                    bins=bins,
                    predictions_map=predictions_map,
                )
                subset_metrics = bootstrap_results.setdefault(subset, {})
                subset_macro = bootstrap_macro.setdefault(subset, {})
                for method, evaluation in evaluations.items():
                    metric_samples = subset_metrics.setdefault(method, {})
                    macro_samples = subset_macro.setdefault(method, {})
                    for metric_name, metric_value in evaluation.metrics.items():
                        _append_metric(metric_samples, metric_name, metric_value)
                    for macro_name, macro_value in evaluation.macro_user.items():
                        _append_metric(macro_samples, macro_name, macro_value)

    summary: Dict[str, object] = {
        "config": {
            "bootstrap": bootstrap,
            "block_mean": block_mean,
            "bootstrap_samples": bootstrap_samples,
            "seed": seed,
        },
        "subsets": {},
    }

    for subset, methods in fold_metrics.items():
        subset_entry: Dict[str, object] = {}
        for method, metrics_dict in methods.items():
            method_entry: Dict[str, object] = {"metrics": {}, "macro_user": {}}
            for metric_name, values in metrics_dict.items():
                filtered = [float(v) for v in values if v is not None]
                stats: Dict[str, Optional[float]] = {
                    "fold_mean": float(np.mean(filtered)) if filtered else None,
                    "fold_std": float(np.std(filtered, ddof=0)) if filtered else None,
                    "ci_low": None,
                    "ci_high": None,
                }
                if bootstrap_results.get(subset, {}).get(method, {}).get(metric_name):
                    samples = bootstrap_results[subset][method][metric_name]
                    stats["ci_low"] = float(np.percentile(samples, 2.5))
                    stats["ci_high"] = float(np.percentile(samples, 97.5))
                stats["fold_values"] = filtered
                stats["bootstrap_sample_count"] = (
                    len(bootstrap_results.get(subset, {}).get(method, {}).get(metric_name, []))
                )
                method_entry["metrics"][metric_name] = stats
            macro_dict = fold_macro.get(subset, {}).get(method, {})
            for metric_name, values in macro_dict.items():
                filtered = [float(v) for v in values if v is not None]
                stats: Dict[str, Optional[float]] = {
                    "fold_mean": float(np.mean(filtered)) if filtered else None,
                    "fold_std": float(np.std(filtered, ddof=0)) if filtered else None,
                    "ci_low": None,
                    "ci_high": None,
                }
                if bootstrap_macro.get(subset, {}).get(method, {}).get(metric_name):
                    samples = bootstrap_macro[subset][method][metric_name]
                    stats["ci_low"] = float(np.percentile(samples, 2.5))
                    stats["ci_high"] = float(np.percentile(samples, 97.5))
                stats["fold_values"] = filtered
                stats["bootstrap_sample_count"] = (
                    len(bootstrap_macro.get(subset, {}).get(method, {}).get(metric_name, []))
                )
                method_entry["macro_user"][metric_name] = stats
            subset_entry[method] = method_entry
        summary["subsets"][subset] = subset_entry

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "metrics_summary.json"
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return out_path


__all__ = ["summarize_folds"]

