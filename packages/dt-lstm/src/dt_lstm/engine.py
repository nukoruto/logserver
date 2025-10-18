"""dt-lstm の共通エンジン実装。"""

from __future__ import annotations

import logging
import os
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

try:
    import torch
except ImportError as exc:  # pragma: no cover - import error handled at runtime
    raise RuntimeError(
        "PyTorch (torch) がインストールされていません。`pip install torch` で導入してください。"
    ) from exc

from .device import DeviceSelection, resolve_device
from .scaffold import create_project

_LOGGER = logging.getLogger(__name__)

_CUBLAS_WORKSPACE = ":16:8"


@dataclass
class RuntimeContext:
    """実行時の決定性・デバイス情報。"""

    seed: int
    deterministic: bool
    device: "torch.device"
    cuda_visible_devices: Optional[str]


def _apply_torch_determinism(seed: int, deterministic: bool, allow_tf32: bool) -> None:
    torch.manual_seed(seed)
    if torch.cuda.is_available():  # pragma: no branch - 分岐は定数に近い
        torch.cuda.manual_seed_all(seed)
        try:
            torch.cuda.set_device(0)
        except Exception as exc:  # pragma: no cover - デバイス未初期化の場合
            _LOGGER.debug("CUDA デバイス設定で例外", exc_info=exc)

    if deterministic:
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
        try:
            torch.use_deterministic_algorithms(True)
        except RuntimeError as exc:  # pragma: no cover - 古い torch
            _LOGGER.warning("deterministic algorithms の設定に失敗しました: %s", exc)
    torch.backends.cuda.matmul.allow_tf32 = allow_tf32


def configure_runtime(
    seed: int,
    device_selection: DeviceSelection,
    *,
    deterministic: bool = True,
    allow_tf32: bool = False,
) -> RuntimeContext:
    """Python/NumPy/PyTorch の乱数とバックエンドを決定的に設定する。"""

    os.environ["PYTHONHASHSEED"] = str(seed)
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = _CUBLAS_WORKSPACE
    random.seed(seed)
    np.random.default_rng(seed)
    np.random.seed(seed)

    _apply_torch_determinism(seed, deterministic, allow_tf32)

    _LOGGER.info(
        "runtime configured", extra={
            "seed": seed,
            "deterministic": deterministic,
            "device": str(device_selection.device),
            "cuda_visible_devices": device_selection.cuda_visible_devices,
            "allow_tf32": allow_tf32,
        }
    )

    return RuntimeContext(
        seed=seed,
        deterministic=deterministic,
        device=device_selection.device,
        cuda_visible_devices=device_selection.cuda_visible_devices,
    )


class DTLSTMEngine:
    """CLI と IPC 双方から共有する実行エンジン。"""

    def __init__(
        self,
        *,
        seed: int = 42,
        device: str = "auto",
        gpu_mode: Optional[str] = None,
        deterministic: bool = True,
        allow_tf32: bool = False,
    ) -> None:
        self._seed = seed
        self._device_request = device
        self._gpu_mode = gpu_mode
        self._deterministic = deterministic
        self._allow_tf32 = allow_tf32
        self._device_selection: Optional[DeviceSelection] = None
        self._runtime: Optional[RuntimeContext] = None

    @property
    def runtime(self) -> RuntimeContext:
        if self._runtime is None:
            raise RuntimeError("ランタイムが初期化されていません。`configure` を先に呼び出してください。")
        return self._runtime

    def configure(self) -> RuntimeContext:
        self._device_selection = resolve_device(self._device_request, self._gpu_mode)
        self._runtime = configure_runtime(
            self._seed,
            self._device_selection,
            deterministic=self._deterministic,
            allow_tf32=self._allow_tf32,
        )
        return self._runtime

    def scaffold_project(
        self,
        *,
        out_dir: Path,
        preset: str = "default",
        overwrite: bool = False,
    ) -> RuntimeContext:
        runtime = self._runtime or self.configure()
        create_project(
            out_dir=out_dir,
            preset=preset,
            runtime=runtime,
            overwrite=overwrite,
        )
        return runtime
