"""GPU/CPU デバイス解決ユーティリティ。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, Optional

try:
    import torch
except ImportError as exc:  # pragma: no cover - import error handled at runtime
    raise RuntimeError(
        "PyTorch (torch) がインストールされていません。`pip install torch` で導入してください。"
    ) from exc

_GPU_VISIBLE_MAP: Dict[str, str] = {
    "ada6000": "0",
    "4060": "1",
}


@dataclass
class DeviceSelection:
    """デバイス解決結果。"""

    device: "torch.device"
    cuda_visible_devices: Optional[str]


def resolve_device(
    requested: str,
    gpu_mode: Optional[str],
) -> DeviceSelection:
    """希望デバイスと GPU_MODE を元に torch.device を決定する。"""

    normalized = (requested or "auto").lower()
    gpu_mode_normalized = (gpu_mode or os.getenv("GPU_MODE", "")).lower() or None

    if normalized not in {"auto", "cpu", "cuda"}:
        raise ValueError(f"不正なデバイス指定です: {requested}")

    if normalized == "auto":
        normalized = "cuda" if torch.cuda.is_available() else "cpu"

    if normalized == "cpu":
        return DeviceSelection(device=torch.device("cpu"), cuda_visible_devices=None)

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA が利用できません。GPU ドライバまたは torch.cuda が有効か確認してください。")

    visible = None
    if gpu_mode_normalized:
        visible = _GPU_VISIBLE_MAP.get(gpu_mode_normalized)
        if visible is None:
            raise ValueError(
                "GPU_MODE は ada6000 または 4060 を指定してください。"
            )
        os.environ["CUDA_VISIBLE_DEVICES"] = visible

    device = torch.device("cuda:0")
    return DeviceSelection(device=device, cuda_visible_devices=visible)
