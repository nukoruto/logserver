"""温度スケーリングによるキャリブレーション実装。"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence

import numpy as np
import torch
from torch import Tensor
from torch.utils.data import DataLoader

from .data import collate_batch, load_sequence_dataset
from .export import ExportError, load_bundle
from .infer import _prepare_from_bundle, _prepare_from_checkpoint


@dataclass
class CalibrationSummary:
    """キャリブレーション結果のサマリ構造。"""

    temperature: float
    ece_before: float
    ece_after: float
    bins: int
    coverage_curve: List[Mapping[str, float]]
    selected_k: int | None
    coverage_rate: float | None
    comparison: Mapping[str, Mapping[str, float | int | None]]


class CalibrationError(RuntimeError):
    """キャリブレーション処理における例外。"""


def _expected_calibration_error(confidence: np.ndarray, correctness: np.ndarray, bins: int) -> float:
    if confidence.size == 0:
        raise CalibrationError("キャリブレーション対象のサンプルが存在しません")
    bin_boundaries = np.linspace(0.0, 1.0, bins + 1)
    total = float(confidence.size)
    ece = 0.0
    for index in range(bins):
        lower = bin_boundaries[index]
        upper = bin_boundaries[index + 1]
        if index == bins - 1:
            mask = (confidence >= lower) & (confidence <= upper)
        else:
            mask = (confidence >= lower) & (confidence < upper)
        if not np.any(mask):
            continue
        bin_conf = float(confidence[mask].mean())
        bin_acc = float(correctness[mask].mean())
        weight = float(mask.mean())
        ece += abs(bin_acc - bin_conf) * weight
    return float(ece)


def _flatten_predictions(logits: Tensor, targets: Tensor, mask: Tensor) -> tuple[Tensor, Tensor]:
    batch, steps, vocab = logits.shape
    valid = mask.view(batch * steps)
    flat_logits = logits.view(batch * steps, vocab)[valid]
    flat_targets = targets.view(batch * steps)[valid]
    if flat_logits.numel() == 0:
        raise CalibrationError("有効なターゲットが存在しないためキャリブレーションできません")
    return flat_logits, flat_targets


def _ece_from_logits(logits: Tensor, targets: Tensor, *, temperature: float, bins: int) -> float:
    scaled = logits / temperature
    probabilities = torch.softmax(scaled, dim=-1)
    confidence, prediction = probabilities.max(dim=-1)
    correctness = prediction.eq(targets)
    conf_np = confidence.detach().cpu().numpy()
    correct_np = correctness.detach().cpu().numpy().astype(np.float32)
    return _expected_calibration_error(conf_np, correct_np, bins)


def _search_temperature(logits: Tensor, targets: Tensor, bins: int) -> tuple[float, float]:
    base_temp = 1.0
    best_temp = base_temp
    best_ece = _ece_from_logits(logits, targets, temperature=base_temp, bins=bins)
    log_min = math.log(0.05)
    log_max = math.log(10.0)
    grid = np.linspace(log_min, log_max, num=50)
    for value in grid:
        temperature = float(math.exp(float(value)))
        ece = _ece_from_logits(logits, targets, temperature=temperature, bins=bins)
        if ece < best_ece - 1e-6 or (abs(ece - best_ece) <= 1e-6 and temperature < best_temp):
            best_temp = temperature
            best_ece = ece
    span = 0.25
    for _ in range(3):
        local_min = max(log_min, math.log(best_temp) - span)
        local_max = min(log_max, math.log(best_temp) + span)
        local_grid = np.linspace(local_min, local_max, num=25)
        for value in local_grid:
            temperature = float(math.exp(float(value)))
            ece = _ece_from_logits(logits, targets, temperature=temperature, bins=bins)
            if ece < best_ece - 1e-6 or (abs(ece - best_ece) <= 1e-6 and temperature < best_temp):
                best_temp = temperature
                best_ece = ece
        span *= 0.5
    return best_temp, best_ece


def _coverage_curve(
    logits: Tensor,
    targets: Tensor,
    *,
    temperature: float,
    max_k: int,
) -> list[Mapping[str, float]]:
    probabilities = torch.softmax(logits / temperature, dim=-1)
    vocab_size = probabilities.size(-1)
    effective_max = max(1, min(max_k, vocab_size))
    curve: List[Mapping[str, float]] = []
    for k in range(1, effective_max + 1):
        topk = torch.topk(probabilities, k=k, dim=-1).indices
        matches = topk.eq(targets.unsqueeze(1))
        coverage = matches.any(dim=1).float().mean().item()
        curve.append({"k": float(k), "coverage": float(coverage), "redundancy": float(k)})
    return curve


def _select_k(curve: Sequence[Mapping[str, float]]) -> tuple[int | None, float | None]:
    if not curve:
        return None, None
    max_coverage = max(point["coverage"] for point in curve)
    target = max_coverage * 0.99
    for point in curve:
        if point["coverage"] >= target:
            return int(point["k"]), float(point["coverage"])
    last = curve[-1]
    return int(last["k"]), float(last["coverage"])


def _comparison_entries(
    curve: Sequence[Mapping[str, float]],
    *,
    keys: Iterable[int],
) -> Dict[str, Mapping[str, float | int | None]]:
    lookup: MutableMapping[int, Mapping[str, float]] = {int(point["k"]): point for point in curve}
    result: Dict[str, Mapping[str, float | int | None]] = {}
    for key in keys:
        point = lookup.get(int(key))
        if point is None:
            result[f"k{key}"] = {"k": int(key), "coverage": None, "redundancy": None}
        else:
            result[f"k{key}"] = {
                "k": int(key),
                "coverage": float(point["coverage"]),
                "redundancy": float(point["redundancy"]),
            }
    return result


def calibrate_temperature(
    val_patterns: Sequence[str],
    *,
    checkpoint_path: Path | None,
    bundle_path: Path | None = None,
    output_path: Path,
    device: torch.device,
    batch_size: int,
    bins: int,
    max_k: int,
) -> Mapping[str, object]:
    if checkpoint_path is None and bundle_path is None:
        raise CalibrationError("checkpoint または bundle のいずれかを指定してください")
    if checkpoint_path is not None and bundle_path is not None:
        raise CalibrationError("checkpoint と bundle は同時に指定できません")

    prepared = None
    dataset = None
    meta: Mapping[str, object] | None = None

    if bundle_path is not None:
        bundle_path = bundle_path.expanduser().resolve()
        try:
            with load_bundle(bundle_path) as bundle:
                prepared = _prepare_from_bundle(bundle, device=device)
                dataset, meta = load_sequence_dataset(
                    val_patterns,
                    numeric_columns=list(prepared.numeric_columns),
                    delta_column=prepared.delta_column,
                    vocab=prepared.vocabulary,
                    idle_timeout=prepared.idle_timeout,
                )
        except ExportError as exc:
            raise CalibrationError(f"エクスポートバンドルの読み込みに失敗しました: {exc}") from exc
    else:
        assert checkpoint_path is not None
        checkpoint_path = checkpoint_path.expanduser().resolve()
        prepared = _prepare_from_checkpoint(checkpoint_path, calibration_path=None, device=device)
        dataset, meta = load_sequence_dataset(
            val_patterns,
            numeric_columns=list(prepared.numeric_columns),
            delta_column=prepared.delta_column,
            vocab=prepared.vocabulary,
            idle_timeout=prepared.idle_timeout,
        )

    assert prepared is not None and dataset is not None and meta is not None
    if int(meta["numeric_dim"]) != prepared.model.config.numeric_dim:
        raise CalibrationError("モデル設定とデータの連続特徴次元が一致しません")

    loader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=0,
        collate_fn=collate_batch,
        pin_memory=False,
    )
    model = prepared.model
    model.eval()
    logits_list: List[Tensor] = []
    targets_list: List[Tensor] = []
    mask_list: List[Tensor] = []
    with torch.no_grad():
        for batch in loader:
            events = batch["events"].to(device)
            numeric = batch["numeric"].to(device)
            mask = batch["mask"].to(device)
            lengths = mask.sum(dim=1)
            outputs = model(events, numeric, lengths=lengths)
            logits_list.append(outputs["event_logits"].detach().cpu())
            targets_list.append(batch["targets"].detach().cpu())
            mask_list.append(batch["mask"].detach().cpu())
    logits = torch.cat(logits_list, dim=0)
    targets = torch.cat(targets_list, dim=0)
    mask = torch.cat(mask_list, dim=0)
    flat_logits, flat_targets = _flatten_predictions(logits, targets, mask)
    base_ece = _ece_from_logits(flat_logits, flat_targets, temperature=1.0, bins=bins)
    best_temp, best_ece = _search_temperature(flat_logits, flat_targets, bins)
    if best_ece >= base_ece:
        best_temp = 1.0
        best_ece = base_ece
    curve = _coverage_curve(flat_logits, flat_targets, temperature=best_temp, max_k=max_k)
    selected_k, coverage_rate = _select_k(curve)
    comparison = _comparison_entries(curve, keys=[3, 5])
    summary = CalibrationSummary(
        temperature=float(best_temp),
        ece_before=float(base_ece),
        ece_after=float(best_ece),
        bins=int(bins),
        coverage_curve=[{k: float(v) for k, v in point.items()} for point in curve],
        selected_k=selected_k,
        coverage_rate=coverage_rate,
        comparison=comparison,
    )
    payload: Mapping[str, object] = {
        "temperature": round(summary.temperature, 6),
        "ece": {
            "before": round(summary.ece_before, 6),
            "after": round(summary.ece_after, 6),
            "bins": summary.bins,
        },
        "coverage": {
            "selected_k": summary.selected_k,
            "coverage_rate": None if summary.coverage_rate is None else round(summary.coverage_rate, 6),
            "curve": [
                {
                    "k": int(point["k"]),
                    "coverage": round(point["coverage"], 6),
                    "redundancy": round(point["redundancy"], 6),
                }
                for point in summary.coverage_curve
            ],
            "comparison": {
                key: {
                    "k": value["k"],
                    "coverage": None
                    if value["coverage"] is None
                    else round(float(value["coverage"]), 6),
                    "redundancy": None
                    if value["redundancy"] is None
                    else round(float(value["redundancy"]), 6),
                }
                for key, value in summary.comparison.items()
            },
        },
    }
    model.cpu()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    return payload

