"""Evaluation utilities for dt-lstm scored outputs."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Mapping, MutableMapping, Sequence

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402  pylint: disable=wrong-import-position
import numpy as np
import pandas as pd

from .data import resolve_input_files


class EvaluationError(RuntimeError):
    """Raised when evaluation prerequisites are not satisfied."""


@dataclass
class EvaluationArtifacts:
    """Paths of generated evaluation assets."""

    metrics_path: Path
    pr_curve_path: Path
    calibration_path: Path


def _load_ground_truth(patterns: Sequence[str]) -> pd.DataFrame:
    files = resolve_input_files(patterns)
    frames: List[pd.DataFrame] = []
    for path in files:
        frame = pd.read_csv(path)
        if "anomaly_label" not in frame.columns:
            raise EvaluationError(f"anomaly_label 列が存在しません: {path}")
        timestamp_col = "timestamp_utc" if "timestamp_utc" in frame.columns else "timestamp"
        if timestamp_col not in frame.columns:
            raise EvaluationError(f"timestamp 列が存在しません: {path}")
        timestamps = pd.to_datetime(frame[timestamp_col], utc=True, errors="coerce")
        if timestamps.isna().any():
            raise EvaluationError(f"無効なタイムスタンプを検出しました: {path}")
        if "session_id" not in frame.columns:
            raise EvaluationError(f"session_id 列が存在しません: {path}")
        if "uid" not in frame.columns:
            raise EvaluationError(f"uid 列が存在しません: {path}")
        ordered = (
            frame.assign(timestamp_utc=timestamps)
            .sort_values(["uid", "session_id", "timestamp_utc"], kind="mergesort")
            .reset_index(drop=True)
        )
        ordered["step_index"] = ordered.groupby(["uid", "session_id"]).cumcount()
        frames.append(
            ordered[
                [
                    "uid",
                    "session_id",
                    "timestamp_utc",
                    "step_index",
                    "anomaly_label",
                ]
            ].copy()
        )
    combined = pd.concat(frames, ignore_index=True)
    combined.sort_values(["uid", "session_id", "step_index"], inplace=True, kind="mergesort")
    return combined.reset_index(drop=True)


def _load_scored(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise EvaluationError(f"スコアCSVが存在しません: {path}")
    frame = pd.read_csv(path)
    if frame.empty:
        raise EvaluationError("スコアCSVに行が存在しません")
    timestamp_col = None
    for candidate in ("timestamp_utc", "timestamp"):
        if candidate in frame.columns:
            timestamp_col = candidate
            break
    if timestamp_col is None:
        raise EvaluationError("スコアCSVに timestamp / timestamp_utc 列が存在しません")
    timestamps = pd.to_datetime(frame[timestamp_col], utc=True, errors="coerce")
    if timestamps.isna().any():
        raise EvaluationError("スコアCSVに無効なタイムスタンプがあります")
    frame = frame.assign(timestamp_utc=timestamps)
    if "session_id" not in frame.columns:
        raise EvaluationError("スコアCSVに session_id 列が存在しません")
    frame["session_id"] = frame["session_id"].astype(str)
    if "uid" in frame.columns:
        frame["uid"] = frame["uid"].astype(str)
    else:
        frame["uid"] = ""
    if "step_index" in frame.columns:
        frame["step_index"] = pd.to_numeric(frame["step_index"], errors="coerce").astype(int)
    elif "row_index" in frame.columns:
        frame["step_index"] = pd.to_numeric(frame["row_index"], errors="coerce").astype(int)
    else:
        frame = frame.sort_values(["uid", "session_id", "timestamp_utc"], kind="mergesort")
        frame["step_index"] = frame.groupby(["uid", "session_id"]).cumcount()
    numeric_columns = [
        "neglog10_p",
        "combined_p",
        "topk_mass",
        "p_ev",
        "p_time",
        "rmtpp_g",
        "rmtpp_w",
        "delta",
        "dt_sec",
    ]
    for column in numeric_columns:
        if column in frame.columns:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    if "censored" in frame.columns:
        frame["censored"] = pd.to_numeric(frame["censored"], errors="coerce").fillna(0).astype(int)
    else:
        frame["censored"] = 0
    for column in ("alarm_active", "alarm", "kofn_active", "spot_alarm_kofn", "topk_hit"):
        if column in frame.columns:
            frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0).astype(int)
    if "topk_rank" in frame.columns:
        frame["topk_rank"] = pd.to_numeric(frame["topk_rank"], errors="coerce").fillna(0).astype(int)
    frame.sort_values(["uid", "session_id", "step_index"], inplace=True, kind="mergesort")
    return frame.reset_index(drop=True)


def _merge_ground_truth(
    truth: pd.DataFrame, predictions: pd.DataFrame
) -> pd.DataFrame:
    merged = pd.merge(
        truth,
        predictions,
        on=["uid", "session_id", "step_index"],
        suffixes=("_truth", "_pred"),
        how="inner",
    )
    if merged.empty:
        raise EvaluationError("スコアCSVと教師データの突合に失敗しました")
    merged.sort_values(["uid", "session_id", "step_index"], inplace=True, kind="mergesort")
    merged.reset_index(drop=True, inplace=True)
    return merged


def _extract_score_columns(frame: pd.DataFrame) -> Mapping[str, np.ndarray]:
    scores = frame.get("neglog10_p")
    if scores is None and "combined_p" in frame.columns:
        combined = np.clip(frame["combined_p"].to_numpy(dtype=float), 1e-300, 1.0)
        scores = -np.log10(combined)
    if scores is None and "anomaly_score" in frame.columns:
        scores = frame["anomaly_score"].to_numpy(dtype=float)
    if scores is None:
        raise EvaluationError("スコア列 (neglog10_p / combined_p / anomaly_score) が見つかりません")
    scores = np.asarray(scores, dtype=float)
    labels = frame["anomaly_label"].to_numpy(dtype=int)
    valid = np.isfinite(scores) & np.isfinite(labels)
    if not np.any(valid):
        raise EvaluationError("有限なスコアが存在しません")
    return {
        "scores": scores[valid],
        "labels": labels[valid],
        "mask": valid,
    }


def _resolve_probability(frame: pd.DataFrame) -> np.ndarray | None:
    if "combined_p" in frame.columns:
        combined = np.clip(frame["combined_p"].to_numpy(dtype=float), 0.0, 1.0)
    elif "neglog10_p" in frame.columns:
        neglog = frame["neglog10_p"].to_numpy(dtype=float)
        combined = np.clip(np.power(10.0, -np.asarray(neglog, dtype=float)), 0.0, 1.0)
    else:
        return None
    return np.clip(1.0 - combined, 0.0, 1.0)


def _compute_rmtpp_negloglik(frame: pd.DataFrame, mask: np.ndarray) -> float | None:
    if "rmtpp_g" not in frame.columns or "rmtpp_w" not in frame.columns:
        return None
    delta_col = "delta" if "delta" in frame.columns else "dt_sec" if "dt_sec" in frame.columns else None
    if delta_col is None:
        return None
    g_vals = frame["rmtpp_g"].to_numpy(dtype=float)[mask]
    w_vals = frame["rmtpp_w"].to_numpy(dtype=float)[mask]
    deltas = frame[delta_col].to_numpy(dtype=float)[mask]
    censored = frame["censored"].to_numpy(dtype=int)[mask]
    losses: List[float] = []
    for g_val, w_val, delta, cens in zip(g_vals, w_vals, deltas, censored, strict=False):
        if not np.isfinite(delta):
            continue
        safe_w = max(float(w_val), 1e-6)
        safe_delta = max(float(delta), 0.0)
        exp_g = math.exp(float(g_val)) if float(g_val) < 80 else math.exp(80)
        if safe_w <= 1e-6:
            integral = exp_g * safe_delta
        else:
            try:
                exp_term = math.exp(float(g_val) + safe_w * safe_delta)
            except OverflowError:
                exp_term = float("inf")
            try:
                exp_g_val = math.exp(float(g_val))
            except OverflowError:
                exp_g_val = float("inf")
            if math.isfinite(exp_term) and math.isfinite(exp_g_val):
                integral = (exp_term - exp_g_val) / safe_w
            elif math.isfinite(exp_g_val):
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


def _compute_confusion(labels: np.ndarray, predictions: np.ndarray) -> Mapping[str, int]:
    tp = int(np.sum((labels == 1) & (predictions == 1)))
    fp = int(np.sum((labels == 0) & (predictions == 1)))
    fn = int(np.sum((labels == 1) & (predictions == 0)))
    tn = int(np.sum((labels == 0) & (predictions == 0)))
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn}


def _f1_from_confusion(conf: Mapping[str, int]) -> float:
    tp = conf["tp"]
    fp = conf["fp"]
    fn = conf["fn"]
    denom = (2 * tp) + fp + fn
    if denom == 0:
        return 0.0
    return float((2 * tp) / denom)


def _select_decision_threshold(scores: np.ndarray, labels: np.ndarray) -> tuple[float, np.ndarray]:
    unique_scores = np.unique(scores[np.isfinite(scores)])
    if unique_scores.size == 0:
        raise EvaluationError("閾値探索に利用できるスコアが存在しません")
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


def _resolve_predictions(frame: pd.DataFrame, mask: np.ndarray, scores: np.ndarray, labels: np.ndarray) -> tuple[np.ndarray, float, str]:
    for column in ("alarm_active", "alarm", "kofn_active", "spot_alarm_kofn"):
        if column in frame.columns:
            preds = frame[column].to_numpy(dtype=int)[mask]
            return preds, math.nan, column
    threshold, preds = _select_decision_threshold(scores, labels)
    return preds, threshold, "optimal_f1"


def _compute_detection_delay(
    frame: pd.DataFrame,
    mask: np.ndarray,
    predictions: np.ndarray,
) -> tuple[float | None, int, int]:
    truth_col = "timestamp_utc_truth" if "timestamp_utc_truth" in frame.columns else "timestamp_utc"
    pred_col = "timestamp_utc_pred" if "timestamp_utc_pred" in frame.columns else truth_col
    timestamps_truth = frame.loc[mask, truth_col].to_numpy()
    timestamps_pred = frame.loc[mask, pred_col].to_numpy()
    labels = frame.loc[mask, "anomaly_label"].to_numpy(dtype=int)
    sessions = frame.loc[mask, "session_id"].to_numpy()
    detected_delays: List[float] = []
    total_segments = 0
    detected_segments = 0
    idx_array = np.arange(labels.size)
    order = np.lexsort((idx_array, sessions, timestamps_truth))
    labels = labels[order]
    predictions = predictions[order]
    timestamps_truth = timestamps_truth[order]
    timestamps_pred = timestamps_pred[order]
    sessions = sessions[order]
    for start in range(labels.size):
        if labels[start] != 1:
            continue
        prev_same_session = start > 0 and sessions[start] == sessions[start - 1]
        if prev_same_session and labels[start - 1] == 1:
            continue
        total_segments += 1
        segment_session = sessions[start]
        start_time = timestamps_truth[start]
        segment_mask = (sessions == segment_session) & (timestamps_truth >= start_time)
        detection_indices = np.where(segment_mask & (predictions == 1))[0]
        if detection_indices.size == 0:
            continue
        first_idx = detection_indices[0]
        detected_segments += 1
        delay = (timestamps_pred[first_idx] - start_time).total_seconds()
        detected_delays.append(max(0.0, float(delay)))
    if not detected_delays:
        return None, total_segments, detected_segments
    return float(np.mean(detected_delays)), total_segments, detected_segments


def _compute_topk_accuracy(frame: pd.DataFrame, mask: np.ndarray) -> float | None:
    if "topk_hit" not in frame.columns:
        return None
    hits = frame["topk_hit"].to_numpy(dtype=float)[mask]
    if hits.size == 0:
        return None
    return float(np.mean(hits))


def _precision_recall_curve(scores: np.ndarray, labels: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    order = np.argsort(-scores)
    sorted_labels = labels[order]
    total_pos = np.sum(sorted_labels == 1)
    if total_pos == 0:
        return np.array([0.0, 1.0]), np.array([1.0, 1.0])
    tp = np.cumsum(sorted_labels == 1)
    fp = np.cumsum(sorted_labels == 0)
    precision = np.divide(tp, tp + fp, out=np.ones_like(tp, dtype=float), where=(tp + fp) > 0)
    recall = tp / total_pos
    precision = np.concatenate(([1.0], precision))
    recall = np.concatenate(([0.0], recall))
    return recall, precision


def _expected_calibration_error(prob: np.ndarray, labels: np.ndarray, bins: int) -> tuple[float | None, list[dict[str, float]]]:
    if prob.size == 0:
        return None, []
    bin_edges = np.linspace(0.0, 1.0, bins + 1)
    total = prob.size
    ece = 0.0
    calibration: List[dict[str, float]] = []
    for index in range(bins):
        lower = bin_edges[index]
        upper = bin_edges[index + 1]
        if index == bins - 1:
            mask = (prob >= lower) & (prob <= upper)
        else:
            mask = (prob >= lower) & (prob < upper)
        if not np.any(mask):
            continue
        bin_prob = prob[mask]
        bin_labels = labels[mask]
        confidence = float(np.mean(bin_prob))
        accuracy = float(np.mean(bin_labels))
        weight = float(bin_prob.size / total)
        ece += abs(accuracy - confidence) * weight
        calibration.append(
            {
                "lower": float(lower),
                "upper": float(upper),
                "confidence": confidence,
                "accuracy": accuracy,
                "count": float(bin_prob.size),
            }
        )
    if not calibration:
        return None, []
    return float(ece), calibration


def _save_pr_curve(path: Path, recall: np.ndarray, precision: np.ndarray) -> None:
    fig, ax = plt.subplots(figsize=(6, 4), dpi=200)
    ax.step(recall, precision, where="post", color="#2563eb", linewidth=2)
    ax.fill_between(recall, precision, step="post", alpha=0.1, color="#2563eb")
    ax.set_xlabel("Recall")
    ax.set_ylabel("Precision")
    ax.set_xlim(0.0, 1.0)
    ax.set_ylim(0.0, 1.05)
    ax.grid(True, linestyle="--", linewidth=0.5, alpha=0.6)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=200, bbox_inches="tight")
    plt.close(fig)


def _save_calibration_plot(path: Path, calibration: Sequence[Mapping[str, float]]) -> None:
    fig, ax = plt.subplots(figsize=(6, 4), dpi=200)
    ax.plot([0.0, 1.0], [0.0, 1.0], linestyle="--", color="#6b7280", linewidth=1)
    if calibration:
        confidences = [item["confidence"] for item in calibration]
        accuracies = [item["accuracy"] for item in calibration]
        ax.plot(confidences, accuracies, marker="o", color="#dc2626", linewidth=2)
    ax.set_xlabel("Predicted anomaly probability")
    ax.set_ylabel("Empirical anomaly rate")
    ax.set_xlim(0.0, 1.0)
    ax.set_ylim(0.0, 1.0)
    ax.grid(True, linestyle="--", linewidth=0.5, alpha=0.6)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=200, bbox_inches="tight")
    plt.close(fig)


def evaluate(
    patterns: Sequence[str],
    *,
    scored_path: Path,
    metrics_path: Path,
    bins: int = 15,
) -> Mapping[str, object]:
    truth = _load_ground_truth(patterns)
    predictions = _load_scored(scored_path)
    merged = _merge_ground_truth(truth, predictions)
    extracted = _extract_score_columns(merged)
    scores = extracted["scores"]
    labels = extracted["labels"]
    mask = extracted["mask"]

    preds, threshold, threshold_source = _resolve_predictions(merged, mask, scores, labels)
    auroc = _compute_auroc(scores, labels)
    confusion = _compute_confusion(labels, preds)
    f1_value = _f1_from_confusion(confusion)
    delay, segments, detected_segments = _compute_detection_delay(merged, mask, preds)
    topk_accuracy = _compute_topk_accuracy(merged, mask)
    nll = _compute_rmtpp_negloglik(merged, mask)
    probabilities = _resolve_probability(merged)
    if probabilities is not None:
        probabilities = probabilities[mask]
        ece, calibration = _expected_calibration_error(probabilities, labels, bins)
    else:
        ece, calibration = None, []

    recall, precision = _precision_recall_curve(scores, labels)
    pr_path = metrics_path.with_name(metrics_path.stem + "_pr_curve.png")
    calib_path = metrics_path.with_name(metrics_path.stem + "_calibration.png")
    _save_pr_curve(pr_path, recall, precision)
    _save_calibration_plot(calib_path, calibration)

    generated_at = datetime.now(timezone.utc).isoformat()
    if metrics_path.exists():
        try:
            existing_payload = json.loads(metrics_path.read_text(encoding="utf-8"))
            if isinstance(existing_payload, dict) and "generated_at" in existing_payload:
                generated_at = str(existing_payload["generated_at"])
        except json.JSONDecodeError:
            generated_at = generated_at

    payload: MutableMapping[str, object] = {
        "version": "1.0",
        "generated_at": generated_at,
        "metrics": {
            "auroc": None if auroc is None else float(auroc),
            "f1": float(f1_value),
            "average_detection_delay_sec": delay,
            "topk_accuracy": None if topk_accuracy is None else float(topk_accuracy),
            "rmtpp_negloglik": None if nll is None else float(nll),
            "ece": None if ece is None else float(ece),
        },
        "counts": {
            "events": int(mask.sum()),
            "positive_events": int(np.sum(labels == 1)),
            "predicted_positive_events": int(np.sum(preds == 1)),
            "anomaly_segments": int(segments),
            "detected_segments": int(detected_segments),
        },
        "threshold": {
            "decision_threshold": None if math.isnan(threshold) else float(threshold),
            "source": threshold_source,
        },
        "artifacts": {
            "pr_curve_png": str(pr_path),
            "calibration_png": str(calib_path),
        },
    }

    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


def _compute_auroc(scores: np.ndarray, labels: np.ndarray) -> float | None:
    positives = labels == 1
    negatives = labels == 0
    pos_count = int(np.sum(positives))
    neg_count = int(np.sum(negatives))
    if pos_count == 0 or neg_count == 0:
        return None
    order = np.argsort(scores, kind="mergesort")
    sorted_scores = scores[order]
    sorted_labels = labels[order]
    ranks = np.empty_like(sorted_scores, dtype=float)
    start = 0
    total = len(sorted_scores)
    while start < total:
        end = start + 1
        while end < total and math.isclose(sorted_scores[end], sorted_scores[start]):
            end += 1
        average_rank = (start + end - 1) / 2.0 + 1.0
        ranks[start:end] = average_rank
        start = end
    positive_ranks = ranks[sorted_labels == 1]
    rank_sum = positive_ranks.sum()
    auc = (rank_sum - pos_count * (pos_count + 1) / 2.0) / (pos_count * neg_count)
    return float(auc)


__all__ = ["evaluate", "EvaluationError", "EvaluationArtifacts"]

