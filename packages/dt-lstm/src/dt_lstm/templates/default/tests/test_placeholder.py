"""テンプレート用のプレースホルダーテスト。"""

from __future__ import annotations

from dt_lstm.pipeline import ProjectPipeline


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
