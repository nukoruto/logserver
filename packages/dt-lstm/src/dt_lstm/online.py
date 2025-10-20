"""Online arrival-time monitoring utilities for dt-lstm."""

from __future__ import annotations

import csv
import json
import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Deque, List, Optional, Tuple

import torch

from .data import load_sequence_dataset, load_vocabulary
from .infer import _load_calibration, _load_config  # pylint: disable=protected-access
from .modules import DeltaTimeModel, DeltaTimeModelConfig


class OnlineError(RuntimeError):
    """Raised when online monitoring prerequisites fail."""


@dataclass
class OnlineSummary:
    """Summary produced by online monitoring execution."""

    sequences: int
    events: int
    raw_alarms: int
    kofn_alarms: int
    active_steps: int
    triggers: int
    out_path: Path
    audit_path: Optional[Path]


def _rmtpp_survival(g: float, w: float, delta: float) -> float:
    delta = max(0.0, float(delta))
    g_val = float(g)
    w_val = max(0.0, float(w))
    try:
        exp_g = math.exp(g_val)
    except OverflowError:
        exp_g = float("inf")
    if w_val <= 1e-6:
        integral = exp_g * delta
    else:
        try:
            expm1_term = math.expm1(w_val * delta)
        except OverflowError:
            return 0.0
        integral = exp_g * expm1_term / w_val
    if not math.isfinite(integral):
        return 0.0
    try:
        survival = math.exp(-integral)
    except OverflowError:  # pragma: no cover - exp of large negative saturates to 0
        survival = 0.0
    return float(max(0.0, min(1.0, survival)))


def _solve_tau_for_q(g: float, w: float, q: float) -> Optional[float]:
    if not 0.0 < q < 1.0:
        raise ValueError("q は (0, 1) の範囲で指定してください")
    g_val = float(g)
    w_val = max(0.0, float(w))
    log_q = math.log(q)
    minus_log_q = -log_q
    if minus_log_q <= 0.0:
        return None
    if w_val <= 1e-6:
        try:
            exp_g = math.exp(g_val)
        except OverflowError:
            exp_g = float("inf")
        if exp_g == 0.0:
            return float("inf")
        if not math.isfinite(exp_g):
            return 0.0
        tau = minus_log_q / exp_g
        return float(max(0.0, tau))
    try:
        exp_neg_g = math.exp(-g_val)
    except OverflowError:
        exp_neg_g = float("inf")
    adjustment = (-w_val * log_q) * exp_neg_g
    if adjustment <= -1.0:
        return None
    try:
        log_rhs = g_val + math.log1p(adjustment)
    except ValueError:
        return None
    if not math.isfinite(log_rhs):
        return None
    tau = (log_rhs - g_val) / w_val
    if tau < 0.0:
        return None
    return float(tau)


def _update_window(window: Deque[bool], value: bool, *, maxlen: int) -> None:
    if len(window) == maxlen:
        window.popleft()
    window.append(value)


def _update_ratio_window(window: Deque[float], value: float, *, maxlen: int) -> None:
    if len(window) == maxlen:
        window.popleft()
    window.append(value)


def run_online_stream(
    *,
    stream_path: Path,
    checkpoint_path: Path,
    calibration_path: Optional[Path],
    output_path: Path,
    audit_path: Optional[Path],
    q: float,
    kofn: Tuple[int, int],
    hysteresis: float,
    device: torch.device,
) -> OnlineSummary:
    if not 0.0 < q < 1.0:
        raise OnlineError("q は (0, 1) の範囲で指定してください")
    k_value, n_value = kofn
    if n_value <= 0 or k_value <= 0 or k_value > n_value:
        raise OnlineError("k-of-n パラメータが不正です")
    if hysteresis <= 1.0:
        raise OnlineError("hysteresis は 1 より大きい値で指定してください")
    if not stream_path.exists():
        raise OnlineError(f"ストリームCSVが存在しません: {stream_path}")

    config = _load_config(checkpoint_path)
    model_cfg = DeltaTimeModelConfig.from_dict(config["model"])
    if model_cfg.time_head != "rmtpp":
        raise OnlineError("time_head が rmtpp のモデルのみオンライン監視に対応しています")
    vocab_path = config.get("vocab")
    vocabulary = load_vocabulary(Path(vocab_path)) if vocab_path else None
    data_meta = config.get("data") or config.get("validation")
    if data_meta is None:
        raise OnlineError("config.json に data 情報が存在しません")
    numeric_columns = data_meta.get("numeric_columns")
    if not numeric_columns:
        raise OnlineError("numeric_columns が構成に存在しません")
    delta_column = str(data_meta.get("delta_column", "dt_sec"))
    idle_timeout = float(data_meta.get("idle_timeout", 1800.0))
    dataset, _ = load_sequence_dataset(
        [str(stream_path)],
        numeric_columns=list(numeric_columns),
        delta_column=delta_column,
        vocab=vocabulary,
        idle_timeout=idle_timeout,
        include_context=True,
    )
    if len(dataset) == 0:
        raise OnlineError("処理可能なシーケンスが存在しません")

    _ = _load_calibration(calibration_path)
    model = DeltaTimeModel(model_cfg)
    state = torch.load(checkpoint_path, map_location=device)
    model.load_state_dict(state)
    model.to(device)
    model.eval()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if audit_path is not None:
        audit_path.parent.mkdir(parents=True, exist_ok=True)

    rows: List[List[object]] = []
    audit_records: List[str] = []
    total_events = 0
    raw_alarm_count = 0
    kofn_alarm_steps = 0
    active_steps = 0
    trigger_count = 0

    with torch.no_grad():
        for seq_index in range(len(dataset)):
            item = dataset._sequences[seq_index]  # type: ignore[attr-defined]
            events = torch.from_numpy(item["events"]).unsqueeze(0).to(device)
            numeric = torch.from_numpy(item["numeric"]).unsqueeze(0).to(device)
            length = events.shape[1]
            lengths = torch.tensor([length], dtype=torch.long, device=device)
            outputs = model(events, numeric, lengths=lengths)
            g_values = outputs["rmtpp_g"].squeeze(0).cpu()
            w_values = outputs["rmtpp_w"].squeeze(0).cpu()
            delta_values = torch.from_numpy(item["delta"]).float()
            censor_flags = torch.from_numpy(item["censor"]).bool()
            context = item.get("_context") if isinstance(item, dict) else None
            timestamps = context.get("timestamps") if isinstance(context, dict) else None
            session_id = context.get("session_id") if isinstance(context, dict) else None
            uid = context.get("uid") if isinstance(context, dict) else None
            source = context.get("file") if isinstance(context, dict) else None
            rows_index = context.get("row_index") if isinstance(context, dict) else None

            flag_window: Deque[bool] = deque()
            ratio_window: Deque[float] = deque()
            alarm_active = False

            for step in range(length):
                delta = float(delta_values[step].item())
                censored = bool(censor_flags[step].item())
                g_val = float(g_values[step].item())
                w_val = float(w_values[step].item())
                survival = _rmtpp_survival(g_val, w_val, delta)
                tau_q = _solve_tau_for_q(g_val, w_val, q)
                ratio = 0.0
                if tau_q is not None and tau_q > 0.0 and math.isfinite(tau_q):
                    ratio = delta / tau_q
                raw_alarm = not censored and survival <= q and tau_q is not None
                if raw_alarm:
                    raw_alarm_count += 1
                _update_window(flag_window, raw_alarm, maxlen=n_value)
                _update_ratio_window(ratio_window, ratio, maxlen=n_value)
                kofn_count = sum(1 for flag in flag_window if flag)
                kofn_active = kofn_count >= k_value
                if kofn_active:
                    kofn_alarm_steps += 1
                if not alarm_active and kofn_active:
                    alarm_active = True
                    trigger_count += 1
                elif alarm_active:
                    release_ratio = ratio if math.isfinite(ratio) else float("inf")
                    if not kofn_active and release_ratio <= (1.0 / hysteresis):
                        alarm_active = False
                if alarm_active:
                    active_steps += 1
                lead_time = None
                if raw_alarm and tau_q is not None and math.isfinite(tau_q):
                    lead_time = max(0.0, delta - tau_q)
                timestamp = ""
                if timestamps and step < len(timestamps):
                    timestamp = str(timestamps[step])
                row_index = ""
                if rows_index and step < len(rows_index):
                    row_index = str(rows_index[step])
                row = [
                    seq_index,
                    step,
                    source or "",
                    session_id or "",
                    uid or "",
                    timestamp,
                    row_index,
                    round(delta, 6),
                    int(censored),
                    round(float(g_val), 10),
                    round(float(w_val), 10),
                    round(float(survival), 12),
                    None if tau_q is None else round(float(tau_q), 6),
                    round(float(ratio), 6),
                    int(raw_alarm),
                    kofn_count,
                    int(kofn_active),
                    int(alarm_active),
                    None if lead_time is None else round(float(lead_time), 6),
                ]
                rows.append(row)
                audit_entry = {
                    "sequence": seq_index,
                    "step": step,
                    "source": source,
                    "session_id": session_id,
                    "uid": uid,
                    "timestamp": timestamp or None,
                    "row_index": row_index or None,
                    "delta": round(delta, 6),
                    "censored": censored,
                    "g": round(float(g_val), 10),
                    "w": round(float(w_val), 10),
                    "survival": round(float(survival), 12),
                    "tau_q": None if tau_q is None else round(float(tau_q), 6),
                    "ratio": round(float(ratio), 6),
                    "raw_alarm": raw_alarm,
                    "kofn_count": kofn_count,
                    "alarm_active": alarm_active,
                    "lead_time": None if lead_time is None else round(float(lead_time), 6),
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
        "row_index",
        "delta",
        "censored",
        "g",
        "w",
        "survival",
        "tau_q",
        "s_evt",
        "raw_alarm",
        "kofn_count",
        "kofn_active",
        "alarm_active",
        "lead_time",
    ]

    with output_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)

    if audit_path is not None:
        audit_path.write_text("\n".join(audit_records) + "\n", encoding="utf-8")

    return OnlineSummary(
        sequences=len(dataset),
        events=total_events,
        raw_alarms=raw_alarm_count,
        kofn_alarms=kofn_alarm_steps,
        active_steps=active_steps,
        triggers=trigger_count,
        out_path=output_path,
        audit_path=audit_path,
    )


__all__ = [
    "OnlineSummary",
    "OnlineError",
    "run_online_stream",
]

