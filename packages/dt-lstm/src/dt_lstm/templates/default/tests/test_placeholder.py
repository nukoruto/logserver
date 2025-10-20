"""テンプレート用のプレースホルダーテスト。"""

from __future__ import annotations

import pytest

_ = pytest.importorskip("dt_lstm.pipeline")


from dt_lstm.pipeline import ProjectPipeline  # type: ignore  # noqa: E402


def test_pipeline_setup(tmp_path):
    config = {
        "runtime": {
            "seed": 123,
            "device": "cpu",
        }
    }
    pipeline = ProjectPipeline(config)
    runtime = pipeline.setup()
    assert runtime.seed == 123
    assert str(runtime.device) in {"cpu", "cuda:0"}
