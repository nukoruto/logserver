"""CLI for threshold computation with evaluation outputs."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Callable, Dict, Iterable, Optional

import numpy as np
import pandas as pd
import yaml

from trainer.logserver.eval import compute_boundary_metrics
from trainer.logserver.scoring.threshold import (
    ThresholdConfig,
    apply_threshold,
    compute_threshold,
)

LOGGER = logging.getLogger("trainer.scripts.threshold")


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


def run(
    config_path: Path,
    *,
    on_error: str = "abort",
    threshold_fn: Callable[[Iterable[float], ThresholdConfig], tuple[Optional[float], Dict[str, object]]] = compute_threshold,
    apply_threshold_fn: Callable[[Iterable[float], float], Iterable[int]] = apply_threshold,
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

    threshold_config = ThresholdConfig(
        method=threshold_cfg.get("method", "quantile"),
        quantile=float(threshold_cfg.get("quantile", 0.995)),
    )
    threshold, meta = threshold_fn(df["anomaly_score"].tolist(), threshold_config)

    payload: Dict[str, object] = {
        **meta,
        "threshold": threshold,
        "data_path": str(scores_path),
        "data_sha256": scores_hash,
        "scoring_config": scoring_cfg,
    }

    status = payload.get("status")

    if dump_hist_path is not None:
        hist_payload = _build_histogram_payload(df["anomaly_score"], hist_bins)
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

    annotation_column = _detect_annotation_column(df)
    eval_payload: Optional[Dict[str, object]] = None

    def _cleanup_partial() -> None:
        for final_path, partial_path in outputs.items():
            if partial_path.exists():
                if on_error == "abort":
                    partial_path.unlink()
                else:
                    if final_path.exists():
                        final_path.unlink()

    try:
        if status == "ok" and threshold is not None:
            labels_path = processed_dir / "scores_with_labels.csv"
            labels_partial = labels_path.with_suffix(labels_path.suffix + ".partial")
            outputs[labels_path] = labels_partial
            df_with_labels = df.copy()
            labels = list(apply_threshold_fn(df_with_labels["anomaly_score"].tolist(), threshold))
            df_with_labels["anomaly_label"] = labels
            df_with_labels.to_csv(labels_partial, index=False)
            payload["anomaly_label_applied"] = True

            if dump_eval_path is not None:
                if annotation_column is None:
                    eval_payload = {
                        "status": "skipped",
                        "reason": "annotation_column_missing",
                    }
                else:
                    try:
                        metrics = compute_boundary_metrics(
                            [int(value) for value in labels],
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
