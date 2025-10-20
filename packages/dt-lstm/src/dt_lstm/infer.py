"""Batch inference utilities for dt-lstm."""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import torch

from .data import Vocabulary, load_sequence_dataset, load_vocabulary
from .export import BundleContents, ExportError, load_bundle
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


@dataclass
class _PreparedModel:
    model: DeltaTimeModel
    vocabulary: Optional[Vocabulary]
    numeric_columns: Sequence[str]
    delta_column: str
    idle_timeout: float
    temperature: float


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


def _resolve_data_meta(primary: object, fallback: object) -> Mapping[str, object]:
    if isinstance(primary, Mapping):
        return dict(primary)
    if isinstance(fallback, Mapping):
        return dict(fallback)
    raise InferenceError("config.json に data セクションが存在しません")


def _resolve_data_settings(metadata: Mapping[str, object]) -> Tuple[List[str], str, float]:
    numeric_columns = metadata.get("numeric_columns")
    if not isinstance(numeric_columns, Sequence) or not numeric_columns:
        raise InferenceError("numeric_columns が構成に存在しません")
    delta_column = str(metadata.get("delta_column", "dt_sec"))
    idle_timeout_raw = metadata.get("idle_timeout", 1800.0)
    try:
        idle_timeout = float(idle_timeout_raw)
    except Exception as exc:  # pragma: no cover - defensive
        raise InferenceError("idle_timeout は数値である必要があります") from exc
    return list(numeric_columns), delta_column, idle_timeout


def _extract_temperature(calibration: Mapping[str, object]) -> float:
    value = calibration.get("temperature", 1.0)
    if isinstance(value, Mapping):
        if "value" in value:
            value = value["value"]
        else:
            raise InferenceError("temperature フィールドが不正な形式です")
    temperature = float(value)
    if temperature <= 0.0:
        raise InferenceError("temperature は正の値である必要があります")
    return temperature


def _prepare_from_checkpoint(
    checkpoint_path: Path,
    calibration_path: Optional[Path],
    *,
    device: torch.device,
) -> _PreparedModel:
    config = _load_config(checkpoint_path)
    model_cfg = DeltaTimeModelConfig.from_dict(config.get("model", {}))
    vocab_entry = config.get("vocab")
    vocabulary = load_vocabulary(Path(vocab_entry)) if isinstance(vocab_entry, str) else None
    data_meta = _resolve_data_meta(config.get("data"), config.get("validation"))
    numeric_columns, delta_column, idle_timeout = _resolve_data_settings(data_meta)
    temperature = _load_calibration(calibration_path)
    model = DeltaTimeModel(model_cfg)
    state = torch.load(checkpoint_path, map_location=device)
    model.load_state_dict(state)
    model.to(device)
    model.eval()
    return _PreparedModel(
        model=model,
        vocabulary=vocabulary,
        numeric_columns=numeric_columns,
        delta_column=delta_column,
        idle_timeout=idle_timeout,
        temperature=temperature,
    )


def _prepare_from_bundle(bundle: BundleContents, *, device: torch.device) -> _PreparedModel:
    metadata = bundle.model_def.metadata
    primary = metadata.get("data") if isinstance(metadata, Mapping) else None
    fallback = metadata.get("validation") if isinstance(metadata, Mapping) else None
    if not isinstance(primary, Mapping) and isinstance(bundle.train_meta, Mapping):
        primary = bundle.train_meta
    data_meta = _resolve_data_meta(primary, fallback)
    numeric_columns, delta_column, idle_timeout = _resolve_data_settings(data_meta)
    vocabulary = load_vocabulary(bundle.vocab_path) if bundle.vocab_path is not None else None
    temperature = _extract_temperature(bundle.calibration)
    model = bundle.model_def.build_model()
    state = torch.load(bundle.state_dict_path, map_location=device)
    model.load_state_dict(state)
    model.to(device)
    model.eval()
    return _PreparedModel(
        model=model,
        vocabulary=vocabulary,
        numeric_columns=numeric_columns,
        delta_column=delta_column,
        idle_timeout=idle_timeout,
        temperature=temperature,
    )


def _build_dataset(
    patterns: Sequence[str],
    prepared: _PreparedModel,
):
    return load_sequence_dataset(
        patterns,
        numeric_columns=list(prepared.numeric_columns),
        delta_column=prepared.delta_column,
        vocab=prepared.vocabulary,
        idle_timeout=prepared.idle_timeout,
        include_context=True,
    )


def _chi2_sf(statistic: float, components: int) -> float:
    if components <= 0:
        raise InferenceError("Fisher結合する成分数が正ではありません")
    if statistic < 0:
        statistic = 0.0
    lambda_val = 0.5 * statistic
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


def _execute_inference(
    dataset,
    prepared: _PreparedModel,
    *,
    output_path: Path,
    audit_path: Optional[Path],
    topk: int,
    device: torch.device,
) -> InferenceSummary:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if audit_path is not None:
        audit_path.parent.mkdir(parents=True, exist_ok=True)

    vocab_lookup: Optional[Dict[int, str]] = None
    if prepared.vocabulary is not None:
        vocab_lookup = {index: token for index, token in enumerate(prepared.vocabulary.itos)}

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
            outputs = prepared.model(events, numeric, lengths=lengths)
            logits = outputs["event_logits"] / prepared.temperature
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
                hit_rank = None
                topk_hit = 0
                if effective_k > 0:
                    matches = (top_indices == target_id).nonzero(as_tuple=False)
                    if matches.numel() > 0:
                        hit_rank = int(matches[0, 0].item()) + 1
                        topk_hit = 1
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
                    round(g_val, 10),
                    round(w_val, 10),
                    topk_hit,
                    hit_rank,
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
                    "rmtpp_g": round(g_val, 10),
                    "rmtpp_w": round(w_val, 10),
                    "topk_hit": bool(topk_hit),
                    "topk_rank": hit_rank,
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
        "rmtpp_g",
        "rmtpp_w",
        "topk_hit",
        "topk_rank",
    ]
    with output_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)

    if audit_path is not None and audit_records:
        audit_path.write_text("\n".join(audit_records) + "\n", encoding="utf-8")

    prepared.model.cpu()
    return InferenceSummary(
        sequences=len(dataset),
        events=total_events,
        out_path=output_path,
        audit_path=audit_path,
    )


def run_inference(
    patterns: Sequence[str],
    *,
    checkpoint_path: Optional[Path],
    calibration_path: Optional[Path],
    output_path: Path,
    audit_path: Optional[Path],
    topk: int,
    device: torch.device,
    bundle_path: Optional[Path] = None,
) -> InferenceSummary:
    if topk <= 0:
        raise InferenceError("topk は 1 以上である必要があります")
    if (checkpoint_path is None) == (bundle_path is None):
        raise InferenceError("checkpoint または bundle のどちらか一方を指定してください")

    if bundle_path is not None:
        bundle_path = bundle_path.expanduser().resolve()
        try:
            with load_bundle(bundle_path) as bundle:
                prepared = _prepare_from_bundle(bundle, device=device)
                model_cfg = prepared.model.config
                if model_cfg.time_head != "rmtpp":
                    raise InferenceError("time_head が rmtpp のモデルのみ推論で利用できます")
                dataset, _ = _build_dataset(patterns, prepared)
                if len(dataset) == 0:
                    raise InferenceError("推論対象のシーケンスが存在しません")
                return _execute_inference(
                    dataset,
                    prepared,
                    output_path=output_path,
                    audit_path=audit_path,
                    topk=topk,
                    device=device,
                )
        except ExportError as exc:
            raise InferenceError(f"エクスポートバンドルの読み込みに失敗しました: {exc}") from exc

    assert checkpoint_path is not None
    checkpoint_path = checkpoint_path.expanduser().resolve()
    prepared = _prepare_from_checkpoint(checkpoint_path, calibration_path, device=device)
    model_cfg = prepared.model.config
    if model_cfg.time_head != "rmtpp":
        raise InferenceError("time_head が rmtpp のモデルのみ推論で利用できます")
    dataset, _ = _build_dataset(patterns, prepared)
    if len(dataset) == 0:
        raise InferenceError("推論対象のシーケンスが存在しません")
    return _execute_inference(
        dataset,
        prepared,
        output_path=output_path,
        audit_path=audit_path,
        topk=topk,
        device=device,
    )
