"""LSTM 異常検知パイプラインの雛形。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

from dt_lstm.engine import DTLSTMEngine, RuntimeContext


@dataclass
class TrainingArtifacts:
    """学習結果の保持用構造体。"""

    model_path: str
    metrics_path: str


class ProjectPipeline:
    """dt-lstm エンジンを利用するプロジェクト雛形。"""

    def __init__(self, config: Dict[str, Any]) -> None:
        self._config = config
        runtime_cfg = config.get("runtime", {})
        self._engine = DTLSTMEngine(
            seed=runtime_cfg.get("seed", 42),
            device=runtime_cfg.get("device", "auto"),
            gpu_mode=runtime_cfg.get("gpu_mode"),
        )
        self._runtime: RuntimeContext | None = None

    def setup(self) -> RuntimeContext:
        self._runtime = self._engine.configure()
        return self._runtime

    def train(self) -> TrainingArtifacts:
        if self._runtime is None:
            self.setup()
        # TODO: 実際の前処理・学習処理を実装する
        return TrainingArtifacts(model_path="models/model.pt", metrics_path="reports/metrics.json")
