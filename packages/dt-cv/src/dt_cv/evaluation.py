"""Fold-level evaluation utilities for dt-cv."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Dict, Iterable, Mapping, MutableMapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score

from .metrics import neglog10_to_prob, _safe_roc_auc


@dataclass
class MethodEvaluation:
    """Container for per-method evaluation results."""

    metrics: Mapping[str, Optional[float]]
    macro_user: Mapping[str, Optional[float]]
    counts: Mapping[str, int]
    segments: Mapping[str, int]
    threshold_value: Optional[float]
    threshold_source: str
    calibration: Optional[Mapping[str, Sequence[float]]]
    predictions: np.ndarray
    mask: np.ndarray

    def to_json(self) -> Mapping[str, object]:
        payload: MutableMapping[str, object] = {
            "metrics": {k: None if v is None else float(v) for k, v in self.metrics.items()},
            "macro_user": {k: None if v is None else float(v) for k, v in self.macro_user.items()},
            "counts": {k: int(v) for k, v in self.counts.items()},
            "segments": {k: int(v) for k, v in self.segments.items()},
            "threshold": {
                "value": None if self.threshold_value is None else float(self.threshold_value),
                "source": self.threshold_source,
            },
        }
        if self.calibration is not None:
            payload["calibration"] = json.loads(json.dumps(self.calibration))
        return payload


def _safe_average_precision(labels: np.ndarray, scores: np.ndarray) -> Optional[float]:
    if np.sum(labels == 1) == 0:
        return None
    return float(average_precision_score(labels, scores))


def _compute_confusion(labels: np.ndarray, predictions: np.ndarray) -> Mapping[str, int]:
    tp = int(np.sum((labels == 1) & (predictions == 1)))
    fp = int(np.sum((labels == 0) & (predictions == 1)))
    fn = int(np.sum((labels == 1) & (predictions == 0)))
    tn = int(np.sum((labels == 0) & (predictions == 0)))
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn}


def _f1_from_confusion(confusion: Mapping[str, int]) -> float:
    tp = confusion["tp"]
    fp = confusion["fp"]
    fn = confusion["fn"]
    denom = (2 * tp) + fp + fn
    if denom == 0:
        return 0.0
    return float((2 * tp) / denom)


def _select_decision_threshold(scores: np.ndarray, labels: np.ndarray) -> Tuple[float, np.ndarray]:
    finite_mask = np.isfinite(scores)
    finite_scores = scores[finite_mask]
    finite_labels = labels[finite_mask]
    if finite_scores.size == 0:
        raise ValueError("No finite scores available for threshold selection")
    unique_scores = np.unique(finite_scores)
    max_score = float(np.max(unique_scores))
    candidates = np.concatenate(([max_score + 1.0], unique_scores[::-1]))
    best_f1 = -1.0
    best_threshold = max_score + 1.0
    best_predictions = np.zeros_like(scores, dtype=int)
    for threshold in candidates:
        preds = (scores >= threshold).astype(int)
        conf = _compute_confusion(labels, preds)
        f1 = _f1_from_confusion(conf)
        if f1 > best_f1 + 1e-12 or (abs(f1 - best_f1) <= 1e-12 and threshold < best_threshold):
            best_f1 = f1
            best_threshold = float(threshold)
            best_predictions = preds
    return best_threshold, best_predictions


def _compute_detection_delay(
    frame: pd.DataFrame,
    predictions: np.ndarray,
    *,
    label_column: str,
    timestamp_column: str,
    session_column: str,
) -> Tuple[Optional[float], int, int]:
    if label_column not in frame.columns or timestamp_column not in frame.columns or session_column not in frame.columns:
        return None, 0, 0
    labels = frame[label_column].to_numpy(dtype=int)
    timestamps = pd.to_datetime(frame[timestamp_column], utc=True, errors="coerce")
    if timestamps.isna().all():
        return None, int(np.sum(labels == 1)), 0
    sessions = frame[session_column].astype(str).to_numpy()
    truth_col = "timestamp_utc_truth" if "timestamp_utc_truth" in frame.columns else timestamp_column
    pred_col = "timestamp_utc_pred" if "timestamp_utc_pred" in frame.columns else timestamp_column
    truth_ts = pd.to_datetime(frame[truth_col], utc=True, errors="coerce")
    pred_ts = pd.to_datetime(frame[pred_col], utc=True, errors="coerce")
    idx_array = np.arange(labels.size)
    order = np.lexsort((idx_array, sessions, truth_ts.to_numpy()))
    labels = labels[order]
    predictions = predictions[order]
    truth_ts = truth_ts.to_numpy()[order]
    pred_ts = pred_ts.to_numpy()[order]
    sessions = sessions[order]
    delays: list[float] = []
    total_segments = 0
    detected_segments = 0
    for index in range(labels.size):
        if labels[index] != 1:
            continue
        if index > 0 and sessions[index] == sessions[index - 1] and labels[index - 1] == 1:
            continue
        total_segments += 1
        same_session = sessions == sessions[index]
        segment_mask = same_session & (truth_ts >= truth_ts[index])
        detection_indices = np.where(segment_mask & (predictions == 1))[0]
        if detection_indices.size == 0:
            continue
        detected_segments += 1
        first_idx = detection_indices[0]
        start_time = truth_ts[index]
        detected_time = pred_ts[first_idx]
        if isinstance(start_time, np.datetime64) and isinstance(detected_time, np.datetime64):
            delay = (detected_time - start_time) / np.timedelta64(1, "s")
        else:
            delay = 0.0
        delays.append(max(0.0, float(delay)))
    if not delays:
        return None, total_segments, detected_segments
    return float(np.mean(delays)), total_segments, detected_segments


def _compute_topk_accuracy(frame: pd.DataFrame) -> Optional[float]:
    if "topk_hit" not in frame.columns:
        return None
    hits = frame["topk_hit"].astype(float).to_numpy()
    if hits.size == 0:
        return None
    return float(np.mean(hits))


def _compute_rmtpp_negloglik(frame: pd.DataFrame) -> Optional[float]:
    if "rmtpp_g" not in frame.columns or "rmtpp_w" not in frame.columns:
        return None
    delta_col = None
    for candidate in ("delta", "dt_sec", "delta_seconds"):
        if candidate in frame.columns:
            delta_col = candidate
            break
    if delta_col is None or "censored" not in frame.columns:
        return None
    g_vals = frame["rmtpp_g"].astype(float).to_numpy()
    w_vals = frame["rmtpp_w"].astype(float).to_numpy()
    deltas = frame[delta_col].astype(float).to_numpy()
    censored = frame["censored"].astype(int).to_numpy()
    losses: list[float] = []
    for g_val, w_val, delta, cens in zip(g_vals, w_vals, deltas, censored, strict=False):
        if not np.isfinite(delta):
            continue
        safe_w = max(float(w_val), 1e-6)
        safe_delta = max(float(delta), 0.0)
        exp_g = math.exp(min(float(g_val), 80.0))
        if safe_w <= 1e-6:
            integral = exp_g * safe_delta
        else:
            try:
                exp_term = math.exp(float(g_val) + safe_w * safe_delta)
            except OverflowError:
                exp_term = float("inf")
            try:
                base = math.exp(float(g_val))
            except OverflowError:
                base = float("inf")
            if math.isfinite(exp_term) and math.isfinite(base):
                integral = (exp_term - base) / safe_w
            elif math.isfinite(base):
                integral = float("inf")
            else:
                integral = exp_g * safe_delta
        integral = max(integral, 0.0)
        if cens:
            losses.append(float(integral))
            continue
        try:
            log_lambda = float(g_val + safe_w * safe_delta)
        except OverflowError:
            log_lambda = 80.0
        losses.append(float(-log_lambda + integral))
    if not losses:
        return None
    return float(np.mean(losses))


def _expected_calibration_error(probabilities: np.ndarray, labels: np.ndarray, bins: int) -> Tuple[Optional[float], list[dict[str, float]]]:
    if probabilities.size == 0:
        return None, []
    probabilities = np.clip(probabilities, 0.0, 1.0)
    labels = labels.astype(int)
    if labels.size == 0:
        return None, []
    edges = np.linspace(0.0, 1.0, bins + 1)
    calibration: list[dict[str, float]] = []
    total = probabilities.size
    ece = 0.0
    for start, end in zip(edges[:-1], edges[1:], strict=False):
        mask = (probabilities >= start) & (probabilities < end)
        if end == 1.0:
            mask = (probabilities >= start) & (probabilities <= end)
        if not np.any(mask):
            continue
        avg_conf = float(np.mean(probabilities[mask]))
        avg_acc = float(np.mean(labels[mask]))
        weight = float(np.sum(mask)) / total
        ece += weight * abs(avg_conf - avg_acc)
        calibration.append({"confidence": avg_conf, "accuracy": avg_acc, "weight": weight})
    if not calibration:
        return None, []
    return float(ece), calibration


def _compute_macro_metrics(
    frame: pd.DataFrame,
    predictions: np.ndarray,
    labels: np.ndarray,
    scores: np.ndarray,
    probabilities: Optional[np.ndarray],
    *,
    bins: int,
    timestamp_column: str,
    session_column: str,
    user_column: str,
) -> Mapping[str, Optional[float]]:
    if user_column not in frame.columns:
        return {k: None for k in ("average_precision", "roc_auc", "f1", "average_detection_delay_sec", "topk_accuracy", "rmtpp_negloglik", "ece")}
    grouped = frame.groupby(user_column, dropna=False)
    ap_values: list[float] = []
    roc_values: list[float] = []
    f1_values: list[float] = []
    delay_values: list[float] = []
    topk_values: list[float] = []
    nll_values: list[float] = []
    ece_values: list[float] = []
    for _, subset in grouped:
        idx = subset.index.to_numpy()
        user_labels = labels[idx]
        user_scores = scores[idx]
        user_predictions = predictions[idx]
        if user_labels.size == 0:
            continue
        ap_val = _safe_average_precision(user_labels, user_scores)
        if ap_val is not None:
            ap_values.append(ap_val)
        roc_val = _safe_roc_auc(user_labels, user_scores)
        if roc_val is not None:
            roc_values.append(roc_val)
        conf = _compute_confusion(user_labels, user_predictions)
        f1_values.append(_f1_from_confusion(conf))
        subset_frame = subset.reset_index(drop=True)
        delay, _, _ = _compute_detection_delay(
            subset_frame,
            user_predictions,
            label_column="anomaly_label",
            timestamp_column=timestamp_column,
            session_column=session_column,
        )
        if delay is not None:
            delay_values.append(delay)
        topk = _compute_topk_accuracy(subset_frame)
        if topk is not None:
            topk_values.append(topk)
        nll = _compute_rmtpp_negloglik(subset_frame)
        if nll is not None:
            nll_values.append(nll)
        if probabilities is not None:
            prob_subset = probabilities[idx]
            ece_val, _ = _expected_calibration_error(prob_subset, user_labels, bins)
            if ece_val is not None:
                ece_values.append(ece_val)
    def _mean(values: Iterable[float]) -> Optional[float]:
        values = list(values)
        if not values:
            return None
        return float(np.mean(values))

    return {
        "average_precision": _mean(ap_values),
        "roc_auc": _mean(roc_values),
        "f1": _mean(f1_values),
        "average_detection_delay_sec": _mean(delay_values),
        "topk_accuracy": _mean(topk_values),
        "rmtpp_negloglik": _mean(nll_values),
        "ece": _mean(ece_values),
    }


def _alpha_q_calibration(p_values: np.ndarray, labels: np.ndarray) -> Optional[Mapping[str, Sequence[float]]]:
    normal_mask = labels == 0
    normal_count = int(np.sum(normal_mask))
    if normal_count == 0:
        return None
    candidate_levels = np.concatenate(
        [
            np.logspace(-4, -2, num=5, base=10.0),
            np.linspace(0.05, 0.5, num=10),
        ]
    )
    candidate_levels = np.clip(np.unique(np.round(candidate_levels, 6)), 1e-6, 0.9)
    samples = p_values[normal_mask]
    empirical: list[float] = []
    delta: list[float] = []
    for alpha in candidate_levels:
        exceedance = float(np.mean(samples <= alpha)) if samples.size > 0 else 0.0
        empirical.append(exceedance)
        delta.append(exceedance - float(alpha))
    return {
        "alpha": [float(x) for x in candidate_levels],
        "empirical_q": empirical,
        "delta": delta,
    }


def evaluate_methods(
    frame: pd.DataFrame,
    *,
    score_columns: Mapping[str, str],
    label_column: str,
    session_column: str,
    timestamp_column: str,
    user_column: str,
    bins: int,
    thresholds: Optional[Mapping[str, float]] = None,
    compute_thresholds: bool = False,
    predictions_map: Optional[Mapping[str, np.ndarray]] = None,
) -> Tuple[Dict[str, MethodEvaluation], Dict[str, float]]:
    evaluations: Dict[str, MethodEvaluation] = {}
    threshold_out: Dict[str, float] = {}
    if label_column not in frame.columns:
        raise ValueError(f"Missing required label column: {label_column}")
    labels_all = frame[label_column].astype(float).to_numpy()
    label_mask = np.isfinite(labels_all)
    labels = labels_all[label_mask].astype(int)
    base_frame = frame.loc[label_mask].reset_index(drop=True)
    for method, column in score_columns.items():
        if column not in base_frame.columns:
            continue
        scores_all = base_frame[column].astype(float).to_numpy()
        mask = np.isfinite(scores_all)
        method_frame = base_frame.loc[mask].reset_index(drop=True)
        method_labels = labels[mask]
        method_scores = scores_all[mask]
        if method_scores.size == 0:
            continue
        preds: np.ndarray
        threshold_value: Optional[float] = None
        threshold_source = "precomputed"
        if compute_thresholds:
            threshold_value, preds = _select_decision_threshold(method_scores, method_labels)
            threshold_source = "validation_opt_f1"
            threshold_out[method] = float(threshold_value)
        elif predictions_map and method in predictions_map:
            preds_full = predictions_map[method]
            if preds_full.shape[0] != base_frame.shape[0]:
                raise ValueError("Prediction map length mismatch for method '%s'" % method)
            preds = preds_full[mask].astype(int)
            threshold_value = None
        else:
            if thresholds and method in thresholds:
                threshold_value = float(thresholds[method])
                preds = (method_scores >= threshold_value).astype(int)
                threshold_source = "provided"
                threshold_out[method] = float(threshold_value)
            else:
                threshold_value, preds = _select_decision_threshold(method_scores, method_labels)
                threshold_source = "auto_opt_f1"
                threshold_out[method] = float(threshold_value)
        ap = _safe_average_precision(method_labels, method_scores)
        roc = _safe_roc_auc(method_labels, method_scores)
        confusion = _compute_confusion(method_labels, preds)
        f1_value = _f1_from_confusion(confusion)
        detection_delay, total_segments, detected_segments = _compute_detection_delay(
            method_frame,
            preds,
            label_column="anomaly_label",
            timestamp_column=timestamp_column,
            session_column=session_column,
        )
        topk_accuracy = _compute_topk_accuracy(method_frame)
        rmtpp_nll = _compute_rmtpp_negloglik(method_frame)
        if method == "dt_lstm" and "combined_p" in method_frame.columns:
            combined = np.clip(method_frame["combined_p"].astype(float).to_numpy(), 0.0, 1.0)
            probabilities = 1.0 - combined
        elif method_frame.columns.str.contains("probability").any():
            prob_col = next(col for col in method_frame.columns if "probability" in col)
            probabilities = np.clip(method_frame[prob_col].astype(float).to_numpy(), 0.0, 1.0)
        else:
            probabilities = 1.0 - neglog10_to_prob(method_scores)
        ece, calibration_points = _expected_calibration_error(probabilities, method_labels, bins)
        macro = _compute_macro_metrics(
            method_frame,
            preds,
            method_labels,
            method_scores,
            probabilities,
            bins=bins,
            timestamp_column=timestamp_column,
            session_column=session_column,
            user_column=user_column,
        )
        calibration = None
        if method == "dt_anom":
            p_values = neglog10_to_prob(method_scores)
            calibration = _alpha_q_calibration(p_values, method_labels)
        evaluations[method] = MethodEvaluation(
            metrics={
                "average_precision": ap,
                "roc_auc": roc,
                "f1": float(f1_value),
                "average_detection_delay_sec": detection_delay,
                "topk_accuracy": topk_accuracy,
                "rmtpp_negloglik": rmtpp_nll,
                "ece": ece,
            },
            macro_user=macro,
            counts={
                "events": int(method_labels.size),
                "positive_events": int(np.sum(method_labels == 1)),
                "predicted_positive_events": int(np.sum(preds == 1)),
            },
            segments={"total": total_segments, "detected": detected_segments},
            threshold_value=threshold_value,
            threshold_source=threshold_source,
            calibration=calibration,
            predictions=preds,
            mask=mask,
        )
    return evaluations, threshold_out


__all__ = ["MethodEvaluation", "evaluate_methods"]

