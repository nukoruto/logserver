"""Batch inference utilities for dt-lstm."""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence

import torch

from .data import load_sequence_dataset, load_vocabulary
from .modules import DeltaTimeModel, DeltaTimeModelConfig


class InferenceError(RuntimeError):
    """Raised when inference prerequisites are not satisfied."""


@dataclass
class InferenceSummary:
    """Summary for inference execution."""

    sequences: int
    events: int
    out_path: Path
    audit_path: Optional[Path]


def _load_config(checkpoint_path: Path) -> Mapping[str, object]:
    config_path = checkpoint_path.with_name("config.json")
    if not config_path.exists():
        raise InferenceError(f"構成ファイルが見つかりません: {config_path}")
    return json.loads(config_path.read_text(encoding="utf-8"))


def _load_calibration(calibration_path: Optional[Path]) -> float:
    if calibration_path is None:
        return 1.0
    if not calibration_path.exists():
        raise InferenceError(f"キャリブレーションファイルが見つかりません: {calibration_path}")
    payload = json.loads(calibration_path.read_text(encoding="utf-8"))
    temperature = payload.get("temperature")
    if temperature is None:
        raise InferenceError("キャリブレーションJSONに temperature が含まれていません")
    temperature = float(temperature)
    if temperature <= 0.0:
        raise InferenceError("temperature は正の値である必要があります")
    return temperature


def _chi2_sf(statistic: float, components: int) -> float:
    if components <= 0:
        raise InferenceError("Fisher結合する成分数が正ではありません")
    if statistic < 0:
        statistic = 0.0
    lambda_val = 0.5 * statistic
    # Survival function of chi-square with 2 * components degrees of freedom.
    # Equivalent to regularized upper incomplete gamma with integer shape.
    term = 0.0
    factor = 1.0
    for order in range(components):
        if order > 0:
            factor *= lambda_val / float(order)
        term += factor
    try:
        base = math.exp(-lambda_val)
    except OverflowError:  # pragma: no cover - large lambda handled as 0
        base = 0.0
    return float(base * term)


def _fisher_statistic(components: Iterable[float]) -> float:
    eps = 1e-12
    total = 0.0
    count = 0
    for value in components:
        clipped = max(eps, min(1.0 - eps, float(value)))
        total += math.log(clipped)
        count += 1
    if count == 0:
        raise InferenceError("Fisher結合する要素が存在しません")
    return float(-2.0 * total)


def _rmtpp_cdf(g: float, w: float, delta: float) -> float:
    delta = max(0.0, float(delta))
    g_val = float(g)
    w_val = max(1e-8, float(w))
    log_lambda = g_val + w_val * delta
    try:
        exp_g = math.exp(g_val)
    except OverflowError:
        exp_g = float("inf")
    try:
        exp_term = math.exp(log_lambda)
    except OverflowError:
        exp_term = float("inf")
    if w_val > 1e-6 and math.isfinite(exp_term) and math.isfinite(exp_g):
        integral = (exp_term - exp_g) / w_val
    elif w_val > 1e-6 and (not math.isfinite(exp_term)) and math.isfinite(exp_g):
        integral = float("inf")
    else:
        integral = exp_g * delta
    integral = max(0.0, integral)
    survival = math.exp(-integral)
    cdf = 1.0 - survival
    return float(max(0.0, min(1.0, cdf)))


def _resolve_token(vocab: Optional[Mapping[int, str]], index: int, fallback: Optional[Sequence[str]], step: int) -> str:
    if vocab is not None and index in vocab:
        return str(vocab[index])
    if fallback is not None and 0 <= step < len(fallback):
        return str(fallback[step])
    return str(index)


def run_inference(
    patterns: Sequence[str],
    *,
    checkpoint_path: Path,
    calibration_path: Optional[Path],
    output_path: Path,
    audit_path: Optional[Path],
    topk: int,
    device: torch.device,
) -> InferenceSummary:
    if topk <= 0:
        raise InferenceError("topk は 1 以上である必要があります")
    config = _load_config(checkpoint_path)
    model_cfg = DeltaTimeModelConfig.from_dict(config["model"])
    if model_cfg.time_head != "rmtpp":
        raise InferenceError("time_head が rmtpp のモデルのみ推論で利用できます")
    vocab_path = config.get("vocab")
    vocabulary = load_vocabulary(Path(vocab_path)) if vocab_path else None
    vocab_lookup: Optional[Dict[int, str]] = None
    if vocabulary is not None:
        vocab_lookup = {index: token for index, token in enumerate(vocabulary.itos)}
    data_meta = config.get("data") or config.get("validation")
    if data_meta is None:
        raise InferenceError("config.json に data 情報が存在しません")
    numeric_columns = data_meta.get("numeric_columns")
    if not numeric_columns:
        raise InferenceError("numeric_columns が構成に存在しません")
    delta_column = str(data_meta.get("delta_column", "dt_sec"))
    idle_timeout = float(data_meta.get("idle_timeout", 1800.0))
    dataset, _ = load_sequence_dataset(
        patterns,
        numeric_columns=list(numeric_columns),
        delta_column=delta_column,
        vocab=vocabulary,
        idle_timeout=idle_timeout,
        include_context=True,
    )
    if len(dataset) == 0:
        raise InferenceError("推論対象のシーケンスが存在しません")
    temperature = _load_calibration(calibration_path)
    model = DeltaTimeModel(model_cfg)
    state = torch.load(checkpoint_path, map_location=device)
    model.load_state_dict(state)
    model.to(device)
    model.eval()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if audit_path is not None:
        audit_path.parent.mkdir(parents=True, exist_ok=True)

    total_events = 0
    audit_records: List[str] = []
    rows: List[List[object]] = []

    with torch.no_grad():
        for seq_index in range(len(dataset)):
            item = dataset._sequences[seq_index]  # type: ignore[attr-defined]
            events = torch.from_numpy(item["events"]).unsqueeze(0).to(device)
            numeric = torch.from_numpy(item["numeric"]).unsqueeze(0).to(device)
            length = events.shape[1]
            lengths = torch.tensor([length], dtype=torch.long, device=device)
            outputs = model(events, numeric, lengths=lengths)
            logits = outputs["event_logits"] / temperature
            probabilities = torch.softmax(logits, dim=-1).squeeze(0).cpu()
            g_values = outputs["rmtpp_g"].squeeze(0).cpu()
            w_values = outputs["rmtpp_w"].squeeze(0).cpu()
            targets = torch.from_numpy(item["targets"]).long()
            delta_values = torch.from_numpy(item["delta"]).float()
            censor_flags = torch.from_numpy(item["censor"]).bool()
            context = item.get("_context") if isinstance(item, Mapping) else None
            fallback_tokens = None
            if isinstance(context, Mapping):
                fallback_tokens = context.get("target_tokens")
            timestamps: Optional[Sequence[str]] = None
            session_id: Optional[str] = None
            uid: Optional[str] = None
            source: Optional[str] = None
            if isinstance(context, Mapping):
                timestamps = context.get("timestamps")  # type: ignore[assignment]
                session_id = context.get("session_id") and str(context.get("session_id"))
                uid = context.get("uid") and str(context.get("uid"))
                source = context.get("file") and str(context.get("file"))

            for step in range(length):
                probs = probabilities[step]
                effective_k = min(int(topk), probs.numel())
                top_values, top_indices = torch.topk(probs, effective_k)
                top_mass = float(top_values.sum().item())
                top_mass = max(0.0, min(1.0, top_mass))
                p_ev = float(max(0.0, min(1.0, 1.0 - top_mass)))
                components = [top_mass]
                target_id = int(targets[step].item())
                delta = float(delta_values[step].item())
                censored = bool(censor_flags[step].item())
                g_val = float(g_values[step].item())
                w_val = float(w_values[step].item())
                if not censored:
                    p_time = _rmtpp_cdf(g_val, w_val, delta)
                    components.append(1.0 - p_time)
                else:
                    p_time = None
                statistic = _fisher_statistic(components)
                combined_p = _chi2_sf(statistic, len(components))
                combined_p = max(0.0, min(1.0, combined_p))
                neglog10 = -math.log10(max(combined_p, 1e-300))
                token = _resolve_token(vocab_lookup, target_id, fallback_tokens, step)
                timestamp = timestamps[step] if timestamps is not None and step < len(timestamps) else None
                row = [
                    seq_index,
                    step,
                    source or "",
                    session_id or "",
                    uid or "",
                    timestamp or "",
                    target_id,
                    token,
                    round(delta, 6),
                    int(censored),
                    round(top_mass, 10),
                    round(p_ev, 10),
                    None if p_time is None else round(p_time, 10),
                    round(statistic, 10),
                    round(combined_p, 12),
                    round(neglog10, 10),
                ]
                rows.append(row)
                topk_payload = []
                for rank, (value, index) in enumerate(zip(top_values.tolist(), top_indices.tolist()), start=1):
                    token_name = _resolve_token(vocab_lookup, int(index), fallback_tokens, step)
                    topk_payload.append(
                        {
                            "rank": rank,
                            "id": int(index),
                            "token": token_name,
                            "prob": round(float(value), 10),
                        }
                    )
                audit_entry = {
                    "sequence": seq_index,
                    "step": step,
                    "target_id": target_id,
                    "target_token": token,
                    "delta": round(delta, 6),
                    "censored": censored,
                    "g": round(g_val, 10),
                    "w": round(w_val, 10),
                    "topk": topk_payload,
                    "topk_mass": round(top_mass, 10),
                    "p_ev": round(p_ev, 10),
                    "p_time": None if p_time is None else round(p_time, 10),
                    "statistic": round(statistic, 10),
                    "combined_p": round(combined_p, 12),
                    "neglog10_p": round(neglog10, 10),
                }
                audit_records.append(json.dumps(audit_entry, ensure_ascii=False, sort_keys=True))
                total_events += 1

    header = [
        "sequence_index",
        "step_index",
        "source",
        "session_id",
        "uid",
        "timestamp",
        "target_id",
        "target_token",
        "delta",
        "censored",
        "topk_mass",
        "p_ev",
        "p_time",
        "fisher_statistic",
        "combined_p",
        "neglog10_p",
    ]
    with output_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)

    if audit_path is not None:
        audit_path.write_text("\n".join(audit_records) + "\n", encoding="utf-8")

    return InferenceSummary(sequences=len(dataset), events=total_events, out_path=output_path, audit_path=audit_path)

