"""CLI for threshold computation with evaluation outputs."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import yaml

from trainer.logserver.eval import (
    compute_binary_classification_metrics,
    compute_boundary_metrics,
)
from trainer.logserver.thresholds import (
    ThresholdConfig,
    ThresholdResult,
    ThresholdStatus,
    compute_hierarchical_thresholds,
    prepare_delta_columns,
    resolve_threshold,
)

LOGGER = logging.getLogger("trainer.scripts.threshold")

DEFAULT_REFERENCE_FILENAME = "scores_reference_normal.csv"


def _configure_logging() -> None:
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(message)s")


def _load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _emit(event: str, payload: Dict[str, object], level: int = logging.INFO) -> None:
    LOGGER.log(level, "%s", json.dumps({"event": event, **payload}, ensure_ascii=False))


def _detect_annotation_column(df: pd.DataFrame) -> Optional[str]:
    candidates = (
        "boundary_annotation",
        "boundary_label",
        "is_boundary",
        "boundary",
    )
    for name in candidates:
        if name in df.columns:
            return name
    return None


def _write_json_with_policy(path: Path, payload: Dict[str, object], keep_partial: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    try:
        with partial.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
    except Exception:
        if partial.exists() and not keep_partial:
            partial.unlink()
        raise
    else:
        partial.replace(path)


def _build_histogram_payload(scores: pd.Series, bins: int) -> Dict[str, object]:
    finite_scores = scores[np.isfinite(scores.to_numpy(dtype=np.float64))]
    if finite_scores.empty:
        return {"status": "skipped", "reason": "no_finite_scores"}

    dense = finite_scores.to_numpy(dtype=np.float64)
    counts, edges = np.histogram(dense, bins=bins, density=False)
    centers = (edges[:-1] + edges[1:]) / 2.0
    density, _ = np.histogram(dense, bins=bins, density=True)
    summary = {
        "count": int(finite_scores.size),
        "mean": float(finite_scores.mean()),
        "std": float(finite_scores.std(ddof=0)),
        "min": float(finite_scores.min()),
        "max": float(finite_scores.max()),
        "p05": float(finite_scores.quantile(0.05)),
        "p50": float(finite_scores.quantile(0.5)),
        "p95": float(finite_scores.quantile(0.95)),
    }
    return {
        "status": "ok",
        "bins": bins,
        "counts": counts.tolist(),
        "density": density.tolist(),
        "bin_edges": edges.tolist(),
        "bin_centers": centers.tolist(),
        "summary": summary,
    }


def _parse_threshold_config(cfg: Dict[str, object]) -> ThresholdConfig:
    fallback_methods = tuple(cfg.get("fallback_methods", ("quantile",)))
    group_keys = tuple(cfg.get("group_keys", ("uid", "op_category")))
    refit_period_cfg = cfg.get("refit_period")
    if refit_period_cfg is None:
        refit_period = None
    elif isinstance(refit_period_cfg, str):
        refit_period = None if refit_period_cfg.lower() in {"none", "inf"} else int(refit_period_cfg)
    else:
        refit_period = int(refit_period_cfg)
    bins_value = cfg.get("bins", "fd")
    alpha = float(cfg.get("alpha", cfg.get("target_alpha", 0.005)))
    return ThresholdConfig(
        method=str(cfg.get("method", "quantile")),
        side=str(cfg.get("side", "upper")),
        transform=str(cfg.get("transform", "raw_dt")),
        alpha=alpha,
        fallback_methods=fallback_methods,
        epsilon=float(cfg.get("epsilon", 1e-3)),
        group_keys=group_keys,
        session_key=str(cfg.get("session_key", "session_id")),
        timestamp_key=str(cfg.get("timestamp_key", "timestamp_utc")),
        dt_column=str(cfg.get("dt_column", "dt_sec")),
        score_column=str(cfg.get("score_column", "anomaly_score")),
        n_min=int(cfg.get("n_min", 200)),
        calib_frac=float(cfg.get("calib_frac", 0.5)),
        u_quantile=float(cfg.get("u_quantile", 0.95)),
        min_exceed=int(cfg.get("min_exceed", 50)),
        q=float(cfg.get("q", 1e-3)),
        solver=str(cfg.get("solver", "mle")),
        refit_period=refit_period,
        bins=bins_value,
        knee_curve=str(cfg.get("knee_curve", "cdf")),
        knee_normalize=bool(cfg.get("knee_normalize", True)),
        knee_method=str(cfg.get("knee_method", "distance_max")),
        allow_quantile_fallback=bool(cfg.get("allow_quantile_fallback", True)),
    )


def _metric_column_name(config: ThresholdConfig) -> str:
    if config.transform == "score":
        return config.score_column
    if config.transform == "raw_dt":
        return config.dt_column
    if config.transform == "log_dt":
        return f"__{config.dt_column}_log"
    raise ValueError(f"Unsupported transform: {config.transform}")


def _metric_series(df: pd.DataFrame, config: ThresholdConfig) -> pd.Series:
    column = _metric_column_name(config)
    if column not in df.columns:
        raise KeyError(f"Metric column '{column}' not found in dataframe")
    return pd.to_numeric(df[column], errors="coerce")


def _stringify_values(series: pd.Series) -> pd.Series:
    return series.astype("object").map(lambda value: str(value))


def _build_group_keys(df: pd.DataFrame, columns: Sequence[str]) -> List[Tuple[str, ...]]:
    if not columns:
        return [tuple() for _ in range(len(df))]
    serialized = [_stringify_values(df[col]) for col in columns]
    return [tuple(values) for values in zip(*[s.tolist() for s in serialized])]


def _decide_flag(value: float, result: ThresholdResult) -> int:
    if not np.isfinite(value):
        return 0
    flagged = False
    if result.tau_hi is not None and value >= result.tau_hi:
        flagged = True
    if result.tau_lo is not None and value <= result.tau_lo:
        flagged = True
    return int(flagged)


def _apply_thresholds_to_frame(
    df: pd.DataFrame,
    metric: pd.Series,
    config: ThresholdConfig,
    result_map: Dict[Tuple[str, ...], ThresholdResult],
    top_level: Sequence[str],
) -> Tuple[pd.DataFrame, List[int]]:
    keys = _build_group_keys(df, top_level)
    global_result = result_map.get(tuple())
    if global_result is None:
        raise ValueError("Global threshold result missing")

    tau_hi_values: List[Optional[float]] = []
    tau_lo_values: List[Optional[float]] = []
    applied_methods: List[str] = []
    applied_levels: List[str] = []
    labels: List[int] = []

    metric_values = metric.to_numpy(dtype=np.float64)
    for key, value in zip(keys, metric_values, strict=True):
        result = result_map.get(key, global_result)
        tau_hi_values.append(result.tau_hi)
        tau_lo_values.append(result.tau_lo)
        applied_methods.append(result.applied_method)
        applied_levels.append("::".join(result.group_level) if result.group_level else "global")
        labels.append(_decide_flag(value, result))

    enriched = df.copy()
    metric_column = _metric_column_name(config)
    enriched["threshold_metric"] = metric
    enriched["tau_hi"] = tau_hi_values
    enriched["tau_lo"] = tau_lo_values
    enriched["threshold_applied_method"] = applied_methods
    enriched["threshold_group_level"] = applied_levels
    enriched["anomaly_label"] = labels
    enriched["threshold_metric_column"] = metric_column
    return enriched, labels


def run(
    config_path: Path,
    *,
    on_error: str = "abort",
    dump_eval_path: Optional[Path] = None,
    dump_hist_path: Optional[Path] = None,
    hist_bins: int = 64,
) -> Dict[str, object]:
    if on_error not in {"abort", "keep-partial"}:
        raise ValueError("on_error must be either 'abort' or 'keep-partial'")

    _configure_logging()

    config = _load_config(config_path)
    data_cfg = config.get("data", {})
    scoring_cfg = config.get("scoring", {})
    threshold_cfg = config.get("threshold", {})

    processed_dir = Path(data_cfg.get("processed_dir", "data/processed"))
    scores_path = processed_dir / "scores.csv"
    if not scores_path.exists():
        raise FileNotFoundError(f"Score file not found: {scores_path}")
    processed_dir.mkdir(parents=True, exist_ok=True)

    scores_hash = _sha256(scores_path)
    df = pd.read_csv(scores_path)

    threshold_config = _parse_threshold_config(threshold_cfg)
    prepared_df = prepare_delta_columns(df, threshold_config)
    metric_series = _metric_series(prepared_df, threshold_config)
    metric_values = metric_series.to_numpy(dtype=np.float64)
    global_result = resolve_threshold(metric_values, threshold_config, allow_small_sample=True)
    global_result.group_key = tuple()
    global_result.group_level = tuple()

    hierarchical_results: List[ThresholdResult] = []
    result_map: Dict[Tuple[str, ...], ThresholdResult] = {tuple(): global_result}
    df_with_labels: Optional[pd.DataFrame] = None
    labels: List[int] = []

    top_level = tuple(key for key in threshold_config.group_keys if key in prepared_df.columns)

    if global_result.status == ThresholdStatus.OK:
        hierarchical_results = compute_hierarchical_thresholds(prepared_df, threshold_config)
        for result in hierarchical_results:
            result_map[tuple(result.group_key)] = result
        df_with_labels, labels = _apply_thresholds_to_frame(
            prepared_df,
            metric_series,
            threshold_config,
            result_map,
            top_level,
        )

    threshold_value: Optional[float]
    if threshold_config.side == "lower":
        threshold_value = global_result.tau_lo
    elif threshold_config.side == "both":
        threshold_value = global_result.tau_hi
    else:
        threshold_value = global_result.tau_hi

    payload: Dict[str, object] = {
        "status": global_result.status,
        "method": threshold_config.method,
        "applied_method": global_result.applied_method,
        "side": threshold_config.side,
        "transform": threshold_config.transform,
        "alpha": float(threshold_config.alpha),
        "q": float(threshold_config.q),
        "threshold": threshold_value,
        "tau_hi": global_result.tau_hi,
        "tau_lo": global_result.tau_lo,
        "data_path": str(scores_path),
        "data_sha256": scores_hash,
        "scoring_config": scoring_cfg,
        "group_keys": list(top_level),
        "anomaly_label_applied": global_result.status == ThresholdStatus.OK,
    }

    status = payload["status"]

    reference_name = threshold_cfg.get("normal_reference", DEFAULT_REFERENCE_FILENAME)
    reference_path = Path(reference_name)
    if not reference_path.is_absolute():
        reference_path = processed_dir / reference_path
    payload["reference_dataset"] = str(reference_path)

    if dump_hist_path is not None:
        hist_payload = _build_histogram_payload(metric_series, hist_bins)
        _write_json_with_policy(dump_hist_path, hist_payload, keep_partial=on_error == "keep-partial")

    if status == "ok":
        _emit("threshold_computed", payload)
    else:
        _emit(
            "threshold_skipped",
            {**payload, "message": "threshold computation skipped"},
            level=logging.WARNING,
        )

    outputs: Dict[Path, Path] = {}
    threshold_path = processed_dir / "threshold.json"
    threshold_partial = threshold_path.with_suffix(threshold_path.suffix + ".partial")
    outputs[threshold_path] = threshold_partial
    thresholds_path = processed_dir / "thresholds.json"
    thresholds_partial = thresholds_path.with_suffix(thresholds_path.suffix + ".partial")
    outputs[thresholds_path] = thresholds_partial

    annotation_column = _detect_annotation_column(df)
    eval_payload: Optional[Dict[str, object]] = None
    reference_payload: Optional[Dict[str, object]] = None

    def _cleanup_partial() -> None:
        for final_path, partial_path in outputs.items():
            if partial_path.exists():
                if on_error == "abort":
                    partial_path.unlink()
                else:
                    if final_path.exists():
                        final_path.unlink()

    try:
        if status == "ok" and threshold_value is not None:
            if df_with_labels is not None:
                labels_path = processed_dir / "scores_with_labels.csv"
                labels_partial = labels_path.with_suffix(labels_path.suffix + ".partial")
                outputs[labels_path] = labels_partial
                df_with_labels.to_csv(labels_partial, index=False)

            if reference_path.exists() and global_result.status == ThresholdStatus.OK:
                reference_payload = _evaluate_reference_fpr(
                    reference_path,
                    threshold_config,
                    global_result,
                )
                if reference_payload is not None:
                    payload["reference_fpr"] = reference_payload["metrics"].get("fpr")
                    payload["reference_fpr_counts"] = reference_payload["counts"]
            else:
                _emit(
                    "reference_fpr_skipped",
                    {
                        "reason": "reference_missing",
                        "path": str(reference_path),
                    },
                    level=logging.WARNING,
                )

            if dump_eval_path is not None:
                if annotation_column is None or df_with_labels is None:
                    eval_payload = {
                        "status": "skipped",
                        "reason": "annotation_column_missing" if annotation_column is None else "threshold_not_available",
                    }
                else:
                    try:
                        metrics = compute_boundary_metrics(
                            labels,
                            [
                                int(value)
                                for value in df_with_labels[annotation_column]
                                .fillna(0)
                                .astype(int)
                                .tolist()
                            ],
                        )
                    except ValueError as exc:
                        eval_payload = {
                            "status": "error",
                            "reason": str(exc),
                            "annotation_column": annotation_column,
                        }
                    else:
                        eval_payload = {
                            "status": "ok",
                            "annotation_column": annotation_column,
                            **metrics,
                        }
        else:
            payload["anomaly_label_applied"] = False
            if dump_eval_path is not None:
                eval_payload = {
                    "status": "skipped",
                    "reason": "threshold_not_available",
                }
        thresholds_payload = {
            "thresholds": [result.to_payload() for result in hierarchical_results] + [global_result.to_payload()],
            "config": {
                "method": threshold_config.method,
                "side": threshold_config.side,
                "transform": threshold_config.transform,
                "group_keys": list(threshold_config.group_keys),
                "alpha": float(threshold_config.alpha),
                "q": float(threshold_config.q),
            },
        }
        payload["thresholds_path"] = str(thresholds_path)
        with thresholds_partial.open("w", encoding="utf-8") as handle:
            json.dump(thresholds_payload, handle, ensure_ascii=False, indent=2)
        with threshold_partial.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
    except Exception:
        _cleanup_partial()
        raise
    else:
        for final_path, partial_path in outputs.items():
            if partial_path.exists():
                partial_path.replace(final_path)

    if dump_eval_path is not None and eval_payload is not None:
        _write_json_with_policy(dump_eval_path, eval_payload, keep_partial=on_error == "keep-partial")

    if reference_payload is not None:
        _emit("reference_fpr_evaluated", reference_payload)

    return payload


def _evaluate_reference_fpr(
    reference_path: Path,
    config: ThresholdConfig,
    result: ThresholdResult,
) -> Optional[Dict[str, object]]:
    try:
        df_reference = pd.read_csv(reference_path)
    except FileNotFoundError:
        return None

    try:
        prepared = prepare_delta_columns(df_reference, config)
        metric_series = _metric_series(prepared, config)
    except (KeyError, ValueError):
        return {
            "status": "skipped",
            "reason": "metric_column_missing",
            "path": str(reference_path),
        }

    metric_values = metric_series.to_numpy(dtype=np.float64)
    if metric_values.size == 0:
        return {
            "status": "skipped",
            "reason": "no_finite_scores",
            "path": str(reference_path),
        }

    predicted = [_decide_flag(value, result) for value in metric_values]
    actual = [0 for _ in predicted]
    metrics = compute_binary_classification_metrics(predicted, actual)
    counts = metrics.get("counts", {})
    payload = {
        "status": "ok",
        "path": str(reference_path),
        "samples": int(metric_values.size),
        "threshold": {
            "tau_hi": result.tau_hi,
            "tau_lo": result.tau_lo,
        },
        "counts": counts,
        "metrics": metrics.get("metrics", {}),
    }
    return payload


def main(
    config_path: Path,
    on_error: str = "abort",
    dump_eval: Optional[Path] = None,
    dump_hist: Optional[Path] = None,
    hist_bins: int = 64,
) -> None:
    run(
        config_path,
        on_error=on_error,
        dump_eval_path=dump_eval,
        dump_hist_path=dump_hist,
        hist_bins=hist_bins,
    )


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Compute anomaly score thresholds")
    parser.add_argument(
        "--config",
        default="trainer/configs/default.yaml",
        help="Path to YAML configuration",
    )
    parser.add_argument(
        "--on-error",
        choices=("abort", "keep-partial"),
        default="abort",
        help="Error handling policy for partial outputs",
    )
    parser.add_argument(
        "--dump-eval",
        help="Path to write boundary evaluation metrics JSON",
    )
    parser.add_argument(
        "--dump-hist",
        help="Path to write anomaly score histogram JSON",
    )
    parser.add_argument(
        "--hist-bins",
        type=int,
        default=64,
        help="Number of bins for histogram dump (default: 64)",
    )
    args = parser.parse_args()
    main(
        Path(args.config),
        on_error=args.on_error,
        dump_eval=Path(args.dump_eval) if args.dump_eval else None,
        dump_hist=Path(args.dump_hist) if args.dump_hist else None,
        hist_bins=args.hist_bins,
    )
