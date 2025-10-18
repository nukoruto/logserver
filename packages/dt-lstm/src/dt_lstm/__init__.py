"""dt-lstm core package.

このパッケージは Δt 対応 LSTM 実験の決定性制御・GPU 切替・プロジェクト雛形生成を担う。
Electron/CLI 双方から共通の `DTLSTMEngine` を経由して利用することを想定している。
"""

from __future__ import annotations

from pkgutil import extend_path

__path__ = extend_path(__path__, __name__)

from .calibrate import calibrate_temperature
from .engine import DTLSTMEngine, RuntimeContext, configure_runtime
from .eval import EvaluationError, evaluate
from .model_def import ModelDefinition, load_definition, save_definition
from .modules import DeltaTimeModel, DeltaTimeModelConfig

__all__ = [
    "DTLSTMEngine",
    "RuntimeContext",
    "configure_runtime",
    "evaluate",
    "EvaluationError",
    "calibrate_temperature",
    "DeltaTimeModelConfig",
    "DeltaTimeModel",
    "ModelDefinition",
    "save_definition",
    "load_definition",
]
