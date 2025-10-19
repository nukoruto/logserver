"""Score fusion utilities for dt-cv."""

from __future__ import annotations

from dataclasses import dataclass
import json
import logging
from pathlib import Path
from typing import Sequence

import numpy as np
import pandas as pd

from .metrics import fisher_neglog10

_LOGGER = logging.getLogger("dt_cv.fusion")


class FusionError(RuntimeError):
    """Raised when score fusion cannot be executed safely."""


@dataclass(frozen=True)
class FusionCalibration:
    """Calibration payload persisted between dev/test splits."""

    method: str
    weights: tuple[float, float]
    objective: str
    threshold: float
    metadata: dict[str, float]

    def to_json(self) -> str:
        payload = {
            "method": self.method,
            "weights": list(self.weights),
            "objective": self.objective,
            "threshold": float(self.threshold),
            "metadata": self.metadata,
        }
        return json.dumps(payload, indent=2, sort_keys=True) + "\n"

    @staticmethod
    def from_path(path: Path) -> "FusionCalibration":
        payload = json.loads(path.read_text(encoding="utf-8"))
        weights = payload.get("weights")
        if not isinstance(weights, Sequence) or len(weights) != 2:
            raise FusionError("Calibration file is missing two-element 'weights'")
        return FusionCalibration(
            method=str(payload.get("method")),
            weights=(float(weights[0]), float(weights[1])),
            objective=str(payload.get("objective")),
            threshold=float(payload.get("threshold")),
            metadata={k: float(v) for k, v in (payload.get("metadata") or {}).items()},
        )


def _normalise_weights(raw: Sequence[float] | None) -> tuple[float, float]:
    if raw is None:
        return (1.0, 1.0)
    weights = tuple(float(value) for value in raw)
    if len(weights) != 2:
        raise FusionError("Exactly two weights are required for fusion")
    if any(value < 0 for value in weights):
        raise FusionError("Fusion weights must be non-negative")
    if weights[0] == 0.0 and weights[1] == 0.0:
        raise FusionError("At least one fusion weight must be positive")
    return weights  # type: ignore[return-value]


def _load_scores(path: Path, column_name: str, *, rename_from: str | None = None) -> pd.DataFrame:
    if not path.exists():
        raise FusionError(f"Score file not found: {path}")
    frame = pd.read_csv(path)
    if rename_from and rename_from in frame.columns:
        frame = frame.rename(columns={rename_from: column_name})
    if column_name not in frame.columns:
        raise FusionError(f"Column '{column_name}' is required in {path}")
    frame[column_name] = frame[column_name].astype(float)
    return frame


def _merge_frames(anom: pd.DataFrame, lstm: pd.DataFrame) -> pd.DataFrame:
    special_cols = {"neglog10_p_anom", "neglog10_p_lstm"}
    common = [col for col in anom.columns if col in lstm.columns and col not in special_cols]
    anom_sorted = anom.reset_index(drop=True)
    lstm_sorted = lstm.reset_index(drop=True)
    if len(anom_sorted) != len(lstm_sorted):
        raise FusionError("dt-anom と dt-lstm の行数が一致しません")
    for col in common:
        if not anom_sorted[col].equals(lstm_sorted[col]):
            raise FusionError(f"列 '{col}' の内容が一致しません")
    lstm_unique = [col for col in lstm_sorted.columns if col not in common]
    merged = pd.concat([anom_sorted, lstm_sorted[lstm_unique]], axis=1)
    return merged


def _weighted_fisher(anom: np.ndarray, lstm: np.ndarray, weights: tuple[float, float]) -> np.ndarray:
    w_anom, w_lstm = weights
    if np.isclose(w_anom, 1.0) and np.isclose(w_lstm, 1.0):
        return fisher_neglog10(anom, lstm)
    p_anom = np.clip(np.power(10.0, -anom), 1e-300, 1.0)
    p_lstm = np.clip(np.power(10.0, -lstm), 1e-300, 1.0)
    stat = -2.0 * (w_anom * np.log(p_anom) + w_lstm * np.log(p_lstm))
    df = 2.0 * (w_anom + w_lstm)
    if df <= 0:
        raise FusionError("Weighted Fisher の自由度が正である必要があります")
    from scipy.stats import chi2

    combined_p = chi2.sf(stat, df=df)
    combined_p = np.clip(combined_p, 1e-300, 1.0)
    return -np.log10(combined_p)


def _f1_threshold(scores: np.ndarray, labels: np.ndarray) -> tuple[float, dict[str, float]]:
    positives = float(labels.sum())
    if positives == 0.0:
        raise FusionError("F1 最適化には正例が必要です")
    thresholds = np.unique(scores)
    best_threshold = thresholds[0]
    best_f1 = -1.0
    best_precision = 0.0
    best_recall = 0.0
    for threshold in thresholds:
        predicted = scores >= threshold
        tp = float(np.logical_and(predicted, labels == 1.0).sum())
        fp = float(np.logical_and(predicted, labels == 0.0).sum())
        fn = float((labels == 1.0).sum() - tp)
        if tp == 0.0:
            f1 = 0.0
            precision = 0.0
            recall = 0.0
        else:
            precision = tp / (tp + fp)
            recall = tp / (tp + fn)
            f1 = 2.0 * precision * recall / (precision + recall)
        if (f1 > best_f1 + 1e-12) or (abs(f1 - best_f1) <= 1e-12 and threshold > best_threshold):
            best_f1 = f1
            best_threshold = threshold
            best_precision = precision
            best_recall = recall
    summary = {
        "f1": float(best_f1),
        "precision": float(best_precision),
        "recall": float(best_recall),
    }
    return float(best_threshold), summary


def _budget_threshold(scores: np.ndarray, *, budget: float) -> tuple[float, dict[str, float]]:
    if not (0.0 < budget < 1.0):
        raise FusionError("Alarm budget は 0 と 1 の間で指定してください")
    total = len(scores)
    limit = int(np.floor(total * budget))
    if limit <= 0:
        return float("inf"), {"activated_ratio": 0.0}
    sorted_scores = np.sort(scores)[::-1]
    threshold = float(sorted_scores[min(limit - 1, total - 1)])
    activated_ratio = float((scores >= threshold).sum()) / float(total)
    return threshold, {"activated_ratio": activated_ratio}


def _calibrate(
    scores: np.ndarray,
    labels: np.ndarray,
    *,
    objective: str,
    budget: float | None,
) -> tuple[float, dict[str, float]]:
    if objective == "f1":
        return _f1_threshold(scores, labels)
    if objective == "budget":
        if budget is None:
            raise FusionError("objective=budget の場合は --budget を指定してください")
        return _budget_threshold(scores, budget=budget)
    raise FusionError(f"Unknown calibration objective: {objective}")


def fuse_scores(
    *,
    anom_path: Path,
    lstm_path: Path,
    out_path: Path,
    calib_path: Path,
    method: str,
    weights: Sequence[float] | None,
    label_column: str,
    objective: str,
    budget: float | None,
) -> None:
    if method != "fisher":
        raise FusionError(f"Unsupported fusion method: {method}")

    raw_weights = _normalise_weights(weights)
    anom_frame = _load_scores(anom_path, "neglog10_p_anom", rename_from="neglog10_p")
    lstm_frame = _load_scores(lstm_path, "neglog10_p_lstm")
    merged = _merge_frames(anom_frame, lstm_frame)

    neglog_anom = merged["neglog10_p_anom"].to_numpy(dtype=float)
    neglog_lstm = merged["neglog10_p_lstm"].to_numpy(dtype=float)
    fused = _weighted_fisher(neglog_anom, neglog_lstm, raw_weights)
    merged["neglog10_p_fisher"] = fused

    calibration: FusionCalibration | None = None
    if calib_path.exists():
        calibration = FusionCalibration.from_path(calib_path)
        if calibration.method != method:
            raise FusionError("Calibration method と指定 method が一致しません")
        if tuple(round(w, 12) for w in calibration.weights) != tuple(round(w, 12) for w in raw_weights):
            raise FusionError("Calibration 時の重みと一致する必要があります")
        threshold = calibration.threshold
        merged["alarm_fisher"] = (merged["neglog10_p_fisher"] >= threshold).astype(int)
    else:
        if label_column not in merged.columns:
            raise FusionError("Dev calibration にはラベル列が必要です")
        labels = merged[label_column].astype(float).to_numpy()
        threshold, metrics = _calibrate(
            merged["neglog10_p_fisher"].to_numpy(dtype=float),
            labels,
            objective=objective,
            budget=budget,
        )
        metadata = {
            "events": float(len(labels)),
            "positives": float(labels.sum()),
        }
        metadata.update(metrics)
        calibration = FusionCalibration(
            method=method,
            weights=raw_weights,
            objective=objective,
            threshold=threshold,
            metadata=metadata,
        )
        calib_path.parent.mkdir(parents=True, exist_ok=True)
        calib_path.write_text(calibration.to_json(), encoding="utf-8")
        merged["alarm_fisher"] = (merged["neglog10_p_fisher"] >= threshold).astype(int)

    if calibration is not None and label_column in merged.columns:
        labels = merged[label_column].astype(float).to_numpy()
        preds = merged["alarm_fisher"].to_numpy(dtype=int)
        tp = float(np.logical_and(preds == 1, labels == 1.0).sum())
        fp = float(np.logical_and(preds == 1, labels == 0.0).sum())
        fn = float(np.logical_and(preds == 0, labels == 1.0).sum())
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 0.0 if (precision + recall) == 0 else 2.0 * precision * recall / (precision + recall)
        _LOGGER.info(
            "fuse.metrics", extra={"precision": precision, "recall": recall, "f1": f1}
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    merged.to_csv(out_path, index=False, lineterminator="\n")

    if calibration is not None:
        _LOGGER.info(
            "fuse.threshold",
            extra={
                "threshold": calibration.threshold,
                "objective": calibration.objective,
                "weights": calibration.weights,
            },
        )

